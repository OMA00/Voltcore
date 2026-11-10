import { prisma } from '../db/prisma.js'

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
        await prisma.$transaction([
          prisma.creditExpiry.update({
            where: { id: entry.id },
            data: { expired: true }
          }),
          prisma.creditWallet.update({
            where: { userId: entry.userId },
            data: { balance: { decrement: amountToExpire } }
          })
        ])

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

async function notifyUser(userId, message) {
  try {
    const { initTelegramBot } = await import('../bot/telegram.js')
    const bot = await initTelegramBot(process.env.TELEGRAM_BOT_TOKEN, process.env.REDIS_URL, null)
    await bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' })
  } catch (err) {
    console.error('Notify failed:', err.message)
  }
}