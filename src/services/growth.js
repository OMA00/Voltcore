import { prisma } from '../db/prisma.js'

/**
 * Calculate viral coefficient (K-factor)
 * K = i × c (invites sent per user × conversion rate)
 */
export async function calculateKFactor() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  const totalUsers = await prisma.user.count()
  const newUsers = await prisma.user.count({
    where: { createdAt: { gte: thirtyDaysAgo } }
  })

  const referredUsers = await prisma.user.count({
    where: {
      referredBy: { not: null },
      createdAt: { gte: thirtyDaysAgo }
    }
  })

  const conversionRate = newUsers > 0 ? referredUsers / newUsers : 0

  // Average referrals per user
  const referralCount = await prisma.referral.count({
    where: { createdAt: { gte: thirtyDaysAgo } }
  })
  const avgInvites = totalUsers > 0 ? referralCount / totalUsers : 0

  return {
    kFactor: avgInvites * conversionRate,
    avgInvites,
    conversionRate,
    referredUsers,
    newUsers
  }
}

/**
 * Daily growth snapshot – run once per day
 */
export async function recordDailyGrowth() {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)

  const [newUsers, newJobs, newReferrals, totalUsers, revenue] = await Promise.all([
    prisma.user.count({ where: { createdAt: { gte: today, lt: tomorrow } } }),
    prisma.job.count({ where: { createdAt: { gte: today, lt: tomorrow } } }),
    prisma.referral.count({ where: { createdAt: { gte: today, lt: tomorrow } } }),
    prisma.user.count(),
    prisma.job.aggregate({
      where: { completedAt: { gte: today, lt: tomorrow } },
      _sum: { totalCostNGN: true }
    })
  ])

  const kFactorData = await calculateKFactor()

  const metric = await prisma.growthMetric.upsert({
    where: { date: today },
    create: {
      date: today,
      newUsers,
      newJobs,
      newReferrals,
      totalUsers,
      revenueNGN: revenue._sum.totalCostNGN || 0,
      kFactor: kFactorData.kFactor
    },
    update: {
      newUsers,
      newJobs,
      newReferrals,
      totalUsers,
      revenueNGN: revenue._sum.totalCostNGN || 0,
      kFactor: kFactorData.kFactor
    }
  })

  console.log(`📊 Growth recorded: ${newUsers} users, ${newJobs} jobs, K=${kFactorData.kFactor.toFixed(2)}`)
  return metric
}

/**
 * Get growth trends
 */
export async function getGrowthTrends(days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  return await prisma.growthMetric.findMany({
    where: { date: { gte: since } },
    orderBy: { date: 'asc' }
  })
}

/**
 * Start daily growth recording (midnight)
 */
export function startGrowthTracking() {
  console.log('📈 Growth tracking started (daily at midnight)')

  const scheduleNext = () => {
    const now = new Date()
    const midnight = new Date(now)
    midnight.setHours(0, 5, 0, 0) // 12:05 AM
    if (midnight <= now) midnight.setDate(midnight.getDate() + 1)

    setTimeout(async () => {
      try {
        await recordDailyGrowth()
      } catch (err) {
        console.error('Growth recording error:', err)
      }
      scheduleNext()
    }, midnight - now)
  }

  scheduleNext()
}