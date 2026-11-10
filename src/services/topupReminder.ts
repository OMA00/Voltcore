import { prisma } from '../db/prisma.js'

const LOW_BALANCE_THRESHOLD = 5000 // ₦5,000
const REMINDER_COOLDOWN_HOURS = 24

/**
 * Check for low balances and send reminders
 */
export async function sendTopupReminders() {
  const cooldownTime = new Date(Date.now() - REMINDER_COOLDOWN_HOURS * 60 * 60 * 1000)

  const lowBalanceWallets = await prisma.creditWallet.findMany({
    where: {
      balance: { lt: LOW_BALANCE_THRESHOLD, gt: 0 }
    },
    include: {
      user: true
    }
  })

  for (const wallet of lowBalanceWallets) {
    try {
      // Check if we already reminded recently
      const lastReminder = await prisma.notificationLog.findFirst({
        where: {
          userId: wallet.userId,
          type: 'low_balance',
          sentAt: { gte: cooldownTime }
        }
      })

      if (lastReminder) continue

      // Send reminder
      await notifyUser(wallet.userId,
        `💼 *Low Balance Reminder*\n\n` +
        `Your wallet has ₦${wallet.balance.toLocaleString()} remaining.\n\n` +
        `Top up to avoid job interruptions:\n` +
        `Use /topup to add credits.`
      )

      // Log the reminder
      await prisma.notificationLog.create({
        data: {
          userId: wallet.userId,
          type: 'low_balance',
          sentAt: new Date()
        }
      })

      console.log(`💼 Low balance reminder sent to ${wallet.userId} (₦${wallet.balance})`)
    } catch (err) {
      console.error(`Reminder error for ${wallet.userId}:`, err)
    }
  }

  return lowBalanceWallets.length
}

/**
 * Start reminder job (every 6 hours)
 */
export function startTopupReminders() {
  console.log('💼 Top-up reminder job started (6h interval)')

  // Initial run
  sendTopupReminders().catch(err => console.error('Initial reminder error:', err))

  // Every 6 hours
  setInterval(sendTopupReminders, 6 * 60 * 60 * 1000)
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