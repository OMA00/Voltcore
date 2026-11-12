import crypto from 'crypto'
import { prisma } from '../db/prisma.js'

const TIERS = {
  bronze: { minReferrals: 0, bonusPerReferral: 5000, workshopReward: 50000 },
  silver: { minReferrals: 10, bonusPerReferral: 7500, workshopReward: 75000 },
  gold: { minReferrals: 30, bonusPerReferral: 10000, workshopReward: 100000 }
}

/**
 * Register a new ambassador
 */
export async function registerAmbassador(userId, university = null, city = null) {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) throw new Error('User not found')

  const existing = await prisma.ambassador.findUnique({ where: { userId } })
  if (existing) throw new Error('Already an ambassador')

  const referralCode = 'AMB' + crypto.randomBytes(4).toString('hex').toUpperCase()

  const ambassador = await prisma.ambassador.create({
    data: {
      userId,
      university,
      city,
      referralCode
    }
  })

  console.log(`🎓 Ambassador registered: ${user.firstName || userId} (${referralCode})`)
  return ambassador
}

/**
 * Record ambassador event (workshop, referral, etc.)
 */
export async function recordAmbassadorEvent(ambassadorId, eventType, data = {}) {
  const ambassador = await prisma.ambassador.findUnique({ where: { id: ambassadorId } })
  if (!ambassador) throw new Error('Ambassador not found')

  const tier = TIERS[ambassador.tier] || TIERS.bronze
  const rewardNGN = data.rewardNGN || 0

  const event = await prisma.ambassadorEvent.create({
    data: {
      ambassadorId,
      eventType,
      description: data.description,
      attendees: data.attendees || 0,
      referralCode: data.referralCode,
      rewardNGN
    }
  })

  // Update ambassador stats
  await prisma.ambassador.update({
    where: { id: ambassadorId },
    data: {
      lastActiveAt: new Date(),
      totalEarnedNGN: { increment: rewardNGN },
      totalReferrals: eventType === 'referral' ? { increment: 1 } : undefined
    }
  })

  // Award credits to ambassador
  if (rewardNGN > 0) {
    await prisma.creditWallet.update({
      where: { userId: ambassador.userId },
      data: { balance: { increment: rewardNGN } }
    })
  }

  // Check for tier upgrade
  await checkTierUpgrade(ambassadorId)

  console.log(`📊 Ambassador event: ${eventType} (₦${rewardNGN} reward)`)
  return event
}

/**
 * Auto-upgrade ambassador tiers
 */
export async function checkTierUpgrade(ambassadorId) {
  const ambassador = await prisma.ambassador.findUnique({ where: { id: ambassadorId } })
  if (!ambassador) return

  let newTier = 'bronze'
  if (ambassador.totalReferrals >= TIERS.gold.minReferrals) newTier = 'gold'
  else if (ambassador.totalReferrals >= TIERS.silver.minReferrals) newTier = 'silver'

  if (newTier !== ambassador.tier) {
    await prisma.ambassador.update({
      where: { id: ambassadorId },
      data: { tier: newTier }
    })
    console.log(`⬆️ Ambassador upgraded to ${newTier}: ${ambassador.userId}`)
  }
}

/**
 * Get ambassador dashboard
 */
export async function getAmbassadorDashboard(userId) {
  const ambassador = await prisma.ambassador.findUnique({
    where: { userId },
    include: {
      events: { orderBy: { createdAt: 'desc' }, take: 20 }
    }
  })

  if (!ambassador) return null

  const tier = TIERS[ambassador.tier] || TIERS.bronze
  const nextTier = ambassador.tier === 'bronze' ? 'silver' : ambassador.tier === 'silver' ? 'gold' : null
  const nextTierInfo = nextTier ? TIERS[nextTier] : null

  return {
    ...ambassador,
    tierInfo: tier,
    nextTier,
    nextTierRequirement: nextTierInfo ? nextTierInfo.minReferrals - ambassador.totalReferrals : 0,
    recentEvents: ambassador.events
  }
}

/**
 * List all ambassadors (admin)
 */
export async function listAmbassadors(page = 1, limit = 20) {
  const skip = (page - 1) * limit
  const [ambassadors, total] = await Promise.all([
    prisma.ambassador.findMany({
      skip, take: limit,
      orderBy: { totalReferrals: 'desc' },
      include: { user: { select: { firstName: true, email: true, telegramId: true } } }
    }),
    prisma.ambassador.count()
  ])
  return { ambassadors, pagination: { page, limit, total, pages: Math.ceil(total / limit) } }
}

/**
 * Get referral leaderboard
 */
export async function getLeaderboard(limit = 20) {
  return await prisma.ambassador.findMany({
    take: limit,
    orderBy: { totalReferrals: 'desc' },
    include: {
      user: { select: { firstName: true } }
    }
  })
}

/**
 * Record workshop
 */
export async function createWorkshop(data) {
  const workshop = await prisma.workshop.create({
    data: {
      ambassadorId: data.ambassadorId,
      title: data.title,
      description: data.description,
      location: data.location,
      scheduledAt: new Date(data.scheduledAt),
      creditReward: data.creditReward || 50000,
      status: 'planned'
    }
  })
  return workshop
}

/**
 * Complete workshop and award credits
 */
export async function completeWorkshop(workshopId, attendees) {
  const workshop = await prisma.workshop.findUnique({ where: { id: workshopId } })
  if (!workshop) throw new Error('Workshop not found')

  const updated = await prisma.workshop.update({
    where: { id: workshopId },
    data: {
      attended: attendees,
      status: 'completed'
    }
  })

  // Award ambassador
  if (workshop.ambassadorId) {
    await recordAmbassadorEvent(workshop.ambassadorId, 'workshop', {
      description: `Workshop: ${workshop.title}`,
      attendees,
      rewardNGN: workshop.creditReward
    })
  }

  return updated
}

export { TIERS }