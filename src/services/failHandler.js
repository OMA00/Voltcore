import { prisma } from '../db/prisma.js'
import { terminateRunPod } from '../providers/runpod.js'
import { terminateVastai } from '../providers/vastai.js'

/**
 * Classify and handle provider failures
 */
export async function handleJobFailure(jobId, error, providerName) {
  console.log(`🔍 Classifying failure for job ${jobId}:`, error.message)

  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) return

  // Classify failure
  const failType = classifyFailure(error)

  if (failType === 'SOFT') {
    // Retry on different provider
    console.log(`🔄 SOFT fail – retrying job ${jobId} on different provider`)

    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'pending' }
    })

    // Notify user of retry
    await notifyUser(job.userId,
      `🔄 *Retrying your job*\n\n` +
      `Provider ${providerName} encountered a temporary issue.\n` +
      `We're retrying on a different provider.\n\n` +
      `No action needed – your job will resume shortly.`
    )

    return { retry: true, failType }
  }

  // HARD fail – refund and notify
  console.log(`❌ HARD fail – refunding job ${jobId}`)

  const refundAmount = job.totalCostNGN

  await prisma.$transaction([
    prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'failed',
        completedAt: new Date(),
        sshDetails: `FAILED: ${error.message}`
      }
    }),
    prisma.creditWallet.update({
      where: { userId: job.userId },
      data: { balance: { increment: refundAmount } }
    })
  ])

  // Notify user of refund
  await notifyUser(job.userId,
    `❌ *Job failed – full refund issued*\n\n` +
    `Job ID: ${jobId}\n` +
    `Refunded: ₦${refundAmount.toLocaleString()}\n\n` +
    `Reason: ${error.message}\n\n` +
    `Your balance has been restored. Try again with /start.`
  )

  return { retry: false, failType, refund: refundAmount }
}

/**
 * Classify failure type
 */
function classifyFailure(error) {
  const message = (error.message || '').toLowerCase()
  const code = error.code || ''

  // SOFT failures – retryable
  const softPatterns = [
    'timeout',
    'rate limit',
    '429',
    '503',
    'temporarily unavailable',
    'connection reset',
    'network',
    'no available gpus',
    'capacity',
    'sold out',
    'spot reclaimed',
    'preempted'
  ]

  if (softPatterns.some(p => message.includes(p))) {
    return 'SOFT'
  }

  // HARD failures – not retryable
  const hardPatterns = [
    'authentication',
    'unauthorized',
    '401',
    '403',
    'invalid api key',
    'quota exceeded',
    'account suspended',
    'payment required',
    'not enough credit'
  ]

  if (hardPatterns.some(p => message.includes(p))) {
    return 'HARD'
  }

  // Default: treat as SOFT (retryable)
  return 'SOFT'
}

/**
 * Notify user of job status change
 */
async function notifyUser(userId, message) {
  try {
    // Send via Telegram and WhatsApp (whichever the user is on)
    const { initTelegramBot } = await import('../bot/telegram.js')
    const { sendWhatsAppMessage } = await import('../bot/whatsapp.js')

    // Try Telegram first
    try {
      const bot = await initTelegramBot(process.env.TELEGRAM_BOT_TOKEN, process.env.REDIS_URL, null)
      await bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' })
      return
    } catch (e) {
      // Fall back to WhatsApp
      await sendWhatsAppMessage(userId, message)
    }
  } catch (err) {
    console.error('Notification failed:', err.message)
  }
}