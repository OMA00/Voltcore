import crypto from 'crypto'
import { prisma } from '../db/prisma.js'

const REFERRAL_BONUS = 2000     // ₦2,000 to referee
const REFERRER_BONUS = 5000     // ₦5,000 to referrer
const REFERRAL_THRESHOLD = 1000 // Referee must spend ₦1,000 before referrer gets bonus

/**
 * Generate a unique referral code for a user
 */
export async function generateReferralCode(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) throw new Error('User not found')

  if (user.referralCode) return user.referralCode

  // Generate short unique code
  const code = 'VC' + crypto.randomBytes(4).toString('hex').toUpperCase()

  await prisma.user.update({
    where: { id: userId },
    data: { referralCode: code }
  })

  return code
}

/**
 * Apply a referral code when a new user signs up
 */
export async function applyReferralCode(refereeId, referralCode) {
  const referee = await prisma.user.findUnique({ where: { id: refereeId } })
  if (!referee) throw new Error('Referee not found')

  if (referee.referredBy) {
    return { success: false, error: 'Already referred' }
  }

  const referrer = await prisma.user.findUnique({
    where: { referralCode: referralCode.toUpperCase() }
  })

  if (!referrer) {
    return { success: false, error: 'Invalid referral code' }
  }

  if (referrer.id === refereeId) {
    return { success: false, error: 'Cannot refer yourself' }
  }

  // Mark as referred
  await prisma.user.update({
    where: { id: refereeId },
    data: {
      referredBy: referralCode.toUpperCase(),
      referredAt: new Date()
    }
  })

  // Create referral record
  await prisma.referral.create({
    data: {
      referrerId: referrer.id,
      refereeId: refereeId,
      status: 'pending'
    }
  })

  // Credit referee immediately
  await prisma.creditWallet.update({
    where: { userId: refereeId },
    data: { balance: { increment: REFERRAL_BONUS } }
  })

  console.log(`🎁 Referral applied: ${refereeId} ← ${referralCode} (₦${REFERRAL_BONUS} to referee)`)

  return { success: true, bonus: REFERRAL_BONUS }
}

/**
 * Complete referral when referee hits spending threshold
 */
export async function completeReferral(refereeId) {
  const referral = await prisma.referral.findUnique({
    where: { refereeId },
    include: { referrer: true, referee: true }
  })

  if (!referral || referral.status === 'completed') return null

  // Check if referee has spent enough
  const totalSpent = await prisma.job.aggregate({
    where: {
      userId: refereeId,
      status: 'completed'
    },
    _sum: { totalCostNGN: true }
  })

  const spent = totalSpent._sum.totalCostNGN || 0
  if (spent < REFERRAL_THRESHOLD) return null

  // Award referrer bonus
  await prisma.$transaction([
    prisma.referral.update({
      where: { id: referral.id },
      data: {
        status: 'completed',
        creditsAwarded: REFERRER_BONUS,
        completedAt: new Date()
      }
    }),
    prisma.creditWallet.update({
      where: { userId: referral.referrerId },
      data: { balance: { increment: REFERRER_BONUS } }
    })
  ])

  console.log(`🎉 Referral completed: ${referral.referrerId} earned ₦${REFERRER_BONUS}`)

  return {
    referrerId: referral.referrerId,
    bonus: REFERRER_BONUS
  }
}

/**
 * Get referral stats for a user
 */
export async function getReferralStats(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      referralsMade: {
        include: { referee: { select: { firstName: true, createdAt: true } } }
      }
    }
  })

  if (!user) return null

  const completed = user.referralsMade.filter(r => r.status === 'completed').length
  const pending = user.referralsMade.filter(r => r.status === 'pending').length
  const totalEarned = user.referralsMade.reduce((sum, r) => sum + r.creditsAwarded, 0)

  return {
    code: user.referralCode,
    totalReferrals: user.referralsMade.length,
    completed,
    pending,
    totalEarnedNGN: totalEarned,
    referrals: user.referralsMade
  }
}

export { REFERRAL_BONUS, REFERRER_BONUS, REFERRAL_THRESHOLD }