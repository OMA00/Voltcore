import { prisma } from '../db/prisma.js'
import { applyWalletChange } from './walletLedger.js'

const EXPIRY_DAYS = 60

/**
 * Schedule credit expiry for a wallet top-up
 */
export async function scheduleCreditExpiry(userId, amount) {
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + EXPIRY_DAYS)

  await prisma.creditExpiry.create({
    data: {
      userId,
      amount,
      expiresAt
    }
  })

  console.log(`⏰ Credit expiry scheduled: ₦${amount} for ${userId} on ${expiresAt.toISOString().slice(0, 10)}`)
}

/**
 * Process expired credits
 */
export async function processExpiredCredits() {
  const now = new Date()

  const expiredEntries = await prisma.creditExpiry.findMany({
    where: {
      expiresAt: { lte: now },
      expired: false
    }
  })

  for (const entry of expiredEntries) {
    try {
      // Check if user still has this amount in wallet
      const wallet = await prisma.creditWallet.findUnique({
        where: { userId: entry.userId }
      })

      if (!wallet) continue

      // Only expire if wallet has enough (don't go negative)
      const amountToExpire = Math.min(entry.amount, wallet.balance)

      if (amountToExpire > 0) {
        // Mark expired and debit together, once per expiry entry.
        await prisma.$transaction(async tx => {
          const { count } = await tx.creditExpiry.updateMany({ where: { id: entry.id, expired: false }, data: { expired: true } })
          if (count !== 1) return
          await applyWalletChange(entry.userId, 'credit_expiry', -amountToExpire, {
            reference: `expiry_${entry.id}`,
            description: 'Credits expired after 60 days unused',
            tx
          })
        })

        console.log(`⏰ Expired ₦${amountToExpire} from ${entry.userId}`)

        // Notify user
        await notifyUser(entry.userId,
          `⏰ *Credits Expired*\n\n` +
          `₦${amountToExpire.toLocaleString()} of your credits have expired (60 days unused).\n\n` +
          `Top up again with /topup to keep using VoltCore.`
        )
      } else {
        // Mark as expired without deducting
        await prisma.creditExpiry.update({
          where: { id: entry.id },
          data: { expired: true }
        })
      }
    } catch (err) {
      console.error(`Expiry error for ${entry.userId}:`, err)
    }
  }

  return expiredEntries.length
}

/**
 * Start daily credit expiry job
 */
export function startCreditExpiryJob() {
  console.log('⏰ Credit expiry job started (daily at 3 AM)')

  const scheduleNext = () => {
    const now = new Date()
    const next3am = new Date(now)
    next3am.setHours(3, 0, 0, 0)
    if (next3am <= now) next3am.setDate(next3am.getDate() + 1)

    setTimeout(async () => {
      try {
        const count = await processExpiredCredits()
        console.log(`⏰ Processed ${count} expired credit entries`)
      } catch (err) {
        console.error('Expiry job error:', err)
      }
      scheduleNext()
    }, next3am - now)
  }

  scheduleNext()
}

// userId is the DATABASE id; the messenger sends to the user's platform id (Telegram chat
// id or WhatsApp JID) through one shared client. This used to send to the database id,
// which Telegram rejects, and built a new bot + Redis connection for every message.
async function notifyUser(userId, message) {
  const { sendToUser } = await import('./messenger.js')
  await sendToUser(userId, message)
}