import { prisma } from '../db/prisma.js'
import { terminateRunPod } from '../providers/runpod.js'
import { terminateVastai } from '../providers/vastai.js'

// ============================================================
// FAILURE CLASSIFICATION & HANDLING
// ============================================================

/**
 * Classify and handle provider failures.
 *
 * SOFT fail → retry on a different provider (no refund yet)
 * HARD fail → refund credits to user and mark job failed
 *
 * Returns: { retry: boolean, failType: 'SOFT' | 'HARD', refund?: number }
 */
export async function handleJobFailure(jobId, error, providerName) {
  console.log(`🔍 Classifying failure for job ${jobId}:`, error.message)

  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) {
    console.warn(`Job ${jobId} not found – cannot classify failure`)
    return { retry: false, failType: 'HARD' }
  }

  const failType = classifyFailure(error)

  // ----------------------------------------------------------
  // SOFT FAIL – retry on different provider
  // ----------------------------------------------------------
  if (failType === 'SOFT') {
    console.log(`🔄 SOFT fail – retrying job ${jobId} on different provider`)

    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'pending',
        providerJobId: null,
        providerName: null,
        sshDetails: null
      }
    })

    await notifyUser(
      job.userId,
      `🔄 *Retrying your job*\n\n` +
      `Provider ${providerName} encountered a temporary issue.\n` +
      `We're retrying on a different provider.\n\n` +
      `No action needed – your job will resume shortly.`
    )

    return { retry: true, failType }
  }

  // ----------------------------------------------------------
  // HARD FAIL – refund and mark as failed
  // ----------------------------------------------------------
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

  await notifyUser(
    job.userId,
    `❌ *Job failed – full refund issued*\n\n` +
    `Job ID: ${jobId}\n` +
    `Refunded: ₦${refundAmount.toLocaleString()}\n\n` +
    `Reason: ${error.message}\n\n` +
    `Your balance has been restored. Try again with /start.`
  )

  return { retry: false, failType, refund: refundAmount }
}

/**
 * Classify a provider error as SOFT (retryable) or HARD (fatal).
 */
function classifyFailure(error) {
  const message = (error.message || '').toLowerCase()

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

// ============================================================
// CANCELLATION HANDLER (Day 6)
// ============================================================

/**
 * Cancel a job, terminate any running provider instance, and refund credits.
 *
 * Returns: { success: boolean, refunded?: number, error?: string }
 */
export async function handleJobCancellation(jobId) {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) {
    return { success: false, error: 'Job not found' }
  }

  // Only cancellable statuses
  if (!['pending', 'provisioning', 'running'].includes(job.status)) {
    return { success: false, error: `Cannot cancel job with status: ${job.status}` }
  }

  // Terminate provider instance if running
  if (job.providerJobId && job.providerName) {
    try {
      if (job.providerName === 'runpod') {
        await terminateRunPod(job.providerJobId)
      } else if (job.providerName === 'vastai') {
        await terminateVastai(job.providerJobId)
      }
      console.log(`🛑 Terminated provider instance for job ${jobId}`)
    } catch (err) {
      console.error(`Provider termination failed for job ${jobId}:`, err.message)
      // Continue – still refund the user
    }
  }

  const refundAmount = job.totalCostNGN

  await prisma.$transaction([
    prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'cancelled',
        completedAt: new Date()
      }
    }),
    prisma.creditWallet.update({
      where: { userId: job.userId },
      data: { balance: { increment: refundAmount } }
    })
  ])

  console.log(`💸 Job ${jobId} cancelled. Refunded ₦${refundAmount}`)

  await notifyUser(
    job.userId,
    `✅ *Job Cancelled*\n\n` +
    `Job ID: ${jobId}\n` +
    `Refunded: ₦${refundAmount.toLocaleString()}\n\n` +
    `Your balance has been restored.`
  )

  return { success: true, refunded: refundAmount }
}

// ============================================================
// NOTIFICATION HELPER
// ============================================================

/**
 * Notify a user via Telegram (and WhatsApp fallback).
 */
async function notifyUser(userId, message) {
  try {
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