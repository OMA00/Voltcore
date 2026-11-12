import crypto from 'crypto'
import { prisma } from '../db/prisma.js'
import { runInference, deployInferencePod } from './inference.js'
import { getModel } from './modelRegistry.js'

const SME_KEY_PREFIX = 'sme_'
const DEFAULT_PRICE_PER_1K = 2 // ₦2 per 1,000 tokens

// ============================================================
// SME API KEY MANAGEMENT
// ============================================================

/**
 * Generate an API key for an SME
 */
export async function generateSmeApiKey(smeId) {
  const randomPart = crypto.randomBytes(24).toString('hex')
  const key = `${SME_KEY_PREFIX}${randomPart}`

  await prisma.sme.update({
    where: { id: smeId },
    data: { apiKey: key }
  })

  console.log(`🔑 SME API key generated for ${smeId}`)
  return key
}

/**
 * Validate an SME API key
 */
export async function validateSmeApiKey(key) {
  if (!key || !key.startsWith(SME_KEY_PREFIX)) return null

  return await prisma.sme.findUnique({
    where: { apiKey: key },
    include: { user: true }
  })
}

// ============================================================
// INFERENCE
// ============================================================

/**
 * Run inference.
 *
 * - If smeId is provided → SME-scoped inference (billed to SME user wallet, logged in SmeUsage)
 * - If smeId is null      → System/default inference (billed to a system user, logged in ApiUsage)
 *
 * @param {string|null} smeId
 * @param {string} prompt
 * @param {string|null} modelId       CustomModel id (SME-scoped only)
 * @param {number} maxTokens
 * @param {string} source             'api' | 'whatsapp' | 'telegram'
 * @param {object|null} options       { apiKeyId, userId } for system mode
 */
export async function runSmeInference(
  smeId,
  prompt,
  modelId = null,
  maxTokens = 500,
  source = 'api',
  options = null
) {
  if (!prompt || !prompt.trim()) throw new Error('Missing prompt')

  // ----------------------------------------------------------
  // 1. RESOLVE SME (optional)
  // ----------------------------------------------------------
  let sme = null
  if (smeId) {
    sme = await prisma.sme.findUnique({ where: { id: smeId } })
    if (!sme) throw new Error('SME not found')
  }

  // ----------------------------------------------------------
  // 2. RESOLVE MODEL + ENDPOINT
  // ----------------------------------------------------------
  let endpoint
  let baseModel = 'micro-gpt'
  let pricePer1k = DEFAULT_PRICE_PER_1K

  if (modelId) {
    // SME custom model
    const customModel = await prisma.customModel.findUnique({
      where: { id: modelId }
    })
    if (!customModel || customModel.status !== 'ready') {
      throw new Error('Custom model not ready')
    }
    if (sme && customModel.smeId !== sme.id) {
      throw new Error('Custom model does not belong to this SME')
    }
    endpoint = customModel.endpoint
    baseModel = customModel.baseModel
    console.log(`🎯 Using custom model ${customModel.id} (${customModel.displayName})`)
  } else {
    // Deploy default inference pod
    const pod = await deployInferencePod('micro-gpt', '4090')
    endpoint = pod.endpoint
    console.log(`🎯 Using default model: micro-gpt on ${endpoint}`)
  }

  // ----------------------------------------------------------
  // 3. RUN INFERENCE
  // ----------------------------------------------------------
  const result = await runInference(endpoint, prompt, maxTokens)
  const tokens = result.tokens || 0
  const costNGN = (tokens / 1000) * pricePer1k

  // ----------------------------------------------------------
  // 4. BILL + LOG
  // ----------------------------------------------------------
  if (sme) {
    // SME-scoped → bill SME owner's wallet, log in SmeUsage
    await prisma.$transaction([
      prisma.sme.update({
        where: { id: sme.id },
        data: {
          totalTokens: { increment: tokens },
          totalSpentNGN: { increment: costNGN }
        }
      }),
      prisma.smeUsage.create({
        data: {
          smeId: sme.id,
          modelId: modelId || null,
          tokens,
          costNGN,
          source
        }
      }),
      prisma.creditWallet.update({
        where: { userId: sme.userId },
        data: { balance: { decrement: costNGN } }
      })
    ])
  } else if (options?.userId) {
    // System mode → bill the API key owner's wallet
    await prisma.$transaction([
      prisma.creditWallet.update({
        where: { userId: options.userId },
        data: { balance: { decrement: costNGN } }
      })
    ])

    // Log ApiUsage if an API key was used
    if (options.apiKeyId) {
      await prisma.apiUsage.create({
        data: {
          apiKeyId: options.apiKeyId,
          modelName: baseModel,
          tokens,
          costNGN
        }
      })
    }
  } else {
    console.warn('⚠️ runSmeInference called with no billing target (no SME, no userId)')
  }

  const billingLabel = sme ? `SME ${sme.id.slice(0, 8)}` : 'system'
  console.log(`💬 ${billingLabel} inference: ${tokens} tokens · ₦${costNGN.toFixed(2)}`)

  // ----------------------------------------------------------
  // 5. RETURN
  // ----------------------------------------------------------
  return {
    text: result.text,
    tokens,
    costNGN,
    model: baseModel,
    endpoint,
    smeId: sme?.id || null
  }
}

// ============================================================
// USAGE ANALYTICS
// ============================================================

/**
 * Get SME usage summary (last N days)
 */
export async function getSmeUsage(smeId, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const usage = await prisma.smeUsage.aggregate({
    where: { smeId, createdAt: { gte: since } },
    _sum: { tokens: true, costNGN: true },
    _count: true
  })

  return {
    period: `Last ${days} days`,
    totalRequests: usage._count,
    totalTokens: usage._sum.tokens || 0,
    totalCostNGN: usage._sum.costNGN || 0
  }
}

/**
 * Get detailed SME usage records (last N days)
 */
export async function getSmeUsageLogs(smeId, days = 30, limit = 50) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  return await prisma.smeUsage.findMany({
    where: { smeId, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      sme: { select: { name: true } }
    }
  })
}

/**
 * Get usage grouped by model for an SME
 */
export async function getSmeUsageByModel(smeId, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const usage = await prisma.smeUsage.groupBy({
    by: ['modelId'],
    where: { smeId, createdAt: { gte: since } },
    _sum: { tokens: true, costNGN: true },
    _count: true
  })

  return usage.map(u => ({
    modelId: u.modelId || 'default',
    requests: u._count,
    tokens: u._sum.tokens || 0,
    costNGN: u._sum.costNGN || 0
  }))
}