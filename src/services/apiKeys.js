import crypto from 'crypto'
import { prisma } from '../db/prisma.js'

const KEY_PREFIX = 'vck_' // VoltCore Key
const KEY_LENGTH = 32

/**
 * Generate a new API key for a user
 */
export async function generateApiKey(userId, name = 'default') {
  const randomPart = crypto.randomBytes(KEY_LENGTH).toString('hex')
  const key = `${KEY_PREFIX}${randomPart}`

  const apiKey = await prisma.apiKey.create({
    data: {
      key,
      name,
      userId
    }
  })

  console.log(`🔑 API key created for ${userId}: ${name}`)

  return {
    id: apiKey.id,
    key,
    name: apiKey.name,
    createdAt: apiKey.createdAt
  }
}

/**
 * Validate an API key
 */
export async function validateApiKey(key) {
  if (!key || !key.startsWith(KEY_PREFIX)) return null

  const apiKey = await prisma.apiKey.findUnique({
    where: { key },
    include: { user: true }
  })

  if (!apiKey) return null
  if (apiKey.revoked) return null
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null

  // Update last used
  await prisma.apiKey.update({
    where: { id: apiKey.id },
    data: { lastUsedAt: new Date() }
  })

  return apiKey
}

/**
 * List API keys for a user
 */
export async function listApiKeys(userId) {
  return await prisma.apiKey.findMany({
    where: { userId, revoked: false },
    orderBy: { createdAt: 'desc' }
  })
}

/**
 * Revoke an API key
 */
export async function revokeApiKey(keyId, userId) {
  return await prisma.apiKey.update({
    where: { id: keyId },
    data: { revoked: true }
  })
}

/**
 * Log API usage
 */
export async function logUsage(apiKeyId, modelName, tokens, costNGN) {
  await prisma.apiUsage.create({
    data: { apiKeyId, modelName, tokens, costNGN }
  })
}

/**
 * Get API usage stats for a key
 */
export async function getUsageStats(apiKeyId) {
  const logs = await prisma.apiUsage.findMany({
    where: { apiKeyId }
  })

  const totalTokens = logs.reduce((sum, l) => sum + l.tokens, 0)
  const totalCostNGN = logs.reduce((sum, l) => sum + l.costNGN, 0)

  return {
    totalRequests: logs.length,
    totalTokens,
    totalCostNGN
  }
}