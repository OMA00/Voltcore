import { Redis } from 'ioredis'

const redis = new Redis(process.env.REDIS_URL)

const SESSION_PREFIX = 'session:'
const SESSION_TTL = 24 * 60 * 60 // 24 hours

/**
 * Get session for a user + platform
 */
export async function getSession(userId, platform) {
  const key = `${SESSION_PREFIX}${platform}:${userId}`
  const data = await redis.get(key)
  if (!data) return null
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

/**
 * Store/merge session data
 */
export async function storeSession(userId, platform, data) {
  const key = `${SESSION_PREFIX}${platform}:${userId}`
  const existing = (await getSession(userId, platform)) || {}
  const merged = { ...existing, ...data }
  await redis.set(key, JSON.stringify(merged), 'EX', SESSION_TTL)
  return merged
}

/**
 * Clear session
 */
export async function clearSession(userId, platform) {
  const key = `${SESSION_PREFIX}${platform}:${userId}`
  await redis.del(key)
}

/**
 * Count active sessions (admin)
 */
export async function countSessions() {
  const keys = await redis.keys(`${SESSION_PREFIX}*`)
  return keys.length
}

/**
 * Cleanup expired sessions (safety net – Redis TTL handles most)
 */
export async function cleanupSessions() {
  const keys = await redis.keys(`${SESSION_PREFIX}*`)
  let cleaned = 0
  for (const key of keys) {
    const ttl = await redis.ttl(key)
    if (ttl === -1) {
      // No TTL set – set one
      await redis.expire(key, SESSION_TTL)
      cleaned++
    }
  }
  return cleaned
}

export { redis as sessionRedis }