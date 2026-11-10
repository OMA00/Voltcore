import { prisma } from '../db/prisma.js'

const DEFAULT_MAX_CONCURRENT = 3

/**
 * Check if user can start a new job
 */
export async function canStartJob(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { maxConcurrentJobs: true }
  })

  if (!user) return { allowed: false, reason: 'User not found' }

  const runningJobs = await prisma.job.count({
    where: {
      userId,
      status: { in: ['pending', 'provisioning', 'running'] }
    }
  })

  const limit = user.maxConcurrentJobs || DEFAULT_MAX_CONCURRENT

  if (runningJobs >= limit) {
    return {
      allowed: false,
      reason: `You have ${runningJobs} active jobs (max ${limit}). Wait for one to finish or cancel a job.`,
      currentCount: runningJobs,
      limit
    }
  }

  return {
    allowed: true,
    currentCount: runningJobs,
    limit,
    remaining: limit - runningJobs
  }
}

/**
 * Get user's active jobs
 */
export async function getActiveJobs(userId) {
  return await prisma.job.findMany({
    where: {
      userId,
      status: { in: ['pending', 'provisioning', 'running'] }
    },
    orderBy: { createdAt: 'desc' }
  })
}

/**
 * Update user's max concurrent limit (admin only)
 */
export async function setMaxConcurrentJobs(userId, limit) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { maxConcurrentJobs: limit }
  })
  return user
}