import crypto from 'crypto'
import { prisma } from '../db/prisma.js'
import { runInference } from './inference.js'

const SME_KEY_PREFIX = 'sme_'

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

/**
 * Run inference for an SME's custom model
 */
export async function runSmeInference(smeId, prompt, modelId = null, maxTokens = 500, source = 'api') {
  const sme = await prisma.sme.findUnique({ where: { id: smeId } })
  if (!sme) throw new Error('SME not found')

  // Get model endpoint
  let endpoint
  if (modelId) {
    const customModel = await prisma.customModel.findUnique({ where: { id: modelId } })
    if (!customModel || customModel.status !== 'ready') {
      throw new Error('Custom model not ready')
    }
    endpoint = customModel.endpoint
  } else {
    // Use default Micro-GPT
    const { deployInferencePod } = await import('./inference.js')
    const pod = await deployInferencePod('micro-gpt', '4090')
    endpoint = pod.endpoint
  }

  // Run inference
  const result = await runInference(endpoint, prompt, maxTokens)

  // Calculate cost (₦2 per 1k tokens)
  const costNGN = (result.tokens / 1000) * 2

  // Update SME usage
  await prisma.$transaction([
    prisma.sme.update({
      where: { id: smeId },
      data: {
        totalTokens: { increment: result.tokens },
        totalSpentNGN: { increment: costNGN }
      }
    }),
    prisma.smeUsage.create({
      data: {
        smeId,
        modelId,
        tokens: result.tokens,
        costNGN,
        source
      }
    })
  ])

  // Deduct from user's wallet
  await prisma.creditWallet.update({
    where: { userId: sme.userId },
    data: { balance: { decrement: costNGN } }
  })

  console.log(`💬 SME ${smeId} inference: ${result.tokens} tokens, ₦${costNGN}`)

  return {
    text: result.text,
    tokens: result.tokens,
    costNGN
  }
}

/**
 * Get SME usage summary
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