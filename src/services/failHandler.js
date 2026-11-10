import { prisma } from '../db/prisma.js'
import { terminateRunPod } from '../providers/runpod.js'
import { terminateVastai } from '../providers/vastai.js'

// ============================================================
// FAILURE CLASSIFICATION WITH CODES
// ============================================================

const FAILURE_CODES = {
  // SOFT failures (retryable)
  TIMEOUT: { type: 'SOFT', retryable: true, label: 'Request timed out' },
  RATE_LIMIT: { type: 'SOFT', retryable: true, label: 'Rate limited by provider' },
  NO_CAPACITY: { type: 'SOFT', retryable: true, label: 'No GPU capacity available' },
  SPOT_RECLAIMED: { type: 'SOFT', retryable: true, label: 'Spot instance reclaimed' },
  NETWORK_ERROR: { type: 'SOFT', retryable: true, label: 'Network issue' },
  PROVIDER_5XX: { type: 'SOFT', retryable: true, label: 'Provider server error' },
  
  // HARD failures (not retryable)
  AUTH_FAILED: { type: 'HARD', retryable: false, label: 'Authentication failed' },
  INVALID_API_KEY: { type: 'HARD', retryable: false, label: 'Invalid API key' },
  QUOTA_EXCEEDED: { type: 'HARD', retryable: false, label: 'Provider quota exceeded' },
  ACCOUNT_SUSPENDED: { type: 'HARD', retryable: false, label: 'Provider account suspended' },
  PAYMENT_REQUIRED: { type: 'HARD', retryable: false, label: 'Provider payment required' },
  INSUFFICIENT_CREDITS: { type: 'HARD', retryable: false, label: 'Provider insufficient credits' }
}

/**
 * Classify a provider error into a specific failure code
 */
export function classifyFailure(error) {
  const message = (error.message || '').toLowerCase()
  const statusCode = error.response?.status
  const responseBody = JSON.stringify(error.response?.data || {}).toLowerCase()

  // HARD failures first
  if (message.includes('unauthorized') || statusCode === 401) return FAILURE_CODES.AUTH_FAILED
  if (message.includes('invalid api key') || responseBody.includes('invalid_api_key')) return FAILURE_CODES.INVALID_API_KEY
  if (message.includes('quota exceeded')) return FAILURE_CODES.QUOTA_EXCEEDED
  if (message.includes('suspended')) return FAILURE_CODES.ACCOUNT_SUSPENDED
  if (message.includes('payment required') || statusCode === 402) return FAILURE_CODES.PAYMENT_REQUIRED
  if (message.includes('insufficient credit')) return FAILURE_CODES.INSUFFICIENT_CREDITS
  if (statusCode === 403) return FAILURE_CODES.AUTH_FAILED

  // SOFT failures
  if (message.includes('timeout') || message.includes('etimedout')) return FAILURE_CODES.TIMEOUT
  if (message.includes('rate limit') || statusCode === 429) return FAILURE_CODES.RATE_LIMIT
  if (message.includes('no available gpu') || message.includes('no gpus')) return FAILURE_CODES.NO_CAPACITY
  if (message.includes('sold out') || message.includes('capacity')) return FAILURE_CODES.NO_CAPACITY
  if (message.includes('spot') || message.includes('preempt')) return FAILURE_CODES.SPOT_RECLAIMED
  if (message.includes('network') || message.includes('econnreset') || message.includes('econnrefused')) return FAILURE_CODES.NETWORK_ERROR
  if (statusCode >= 500 && statusCode < 600) return FAILURE_CODES.PROVIDER_5XX

  // Default: treat as SOFT (retryable)
  return FAILURE_CODES.TIMEOUT
}

// ============================================================
// RETRY LOGIC
// ============================================================

const MAX_RETRIES = 3
const BACKOFF_DELAYS = [30000, 120000, 600000] // 30s, 2min, 10min

/**
 * Calculate next retry delay
 */
export function getRetryDelay(retryCount) {
  return BACKOFF_DELAYS[retryCount] || BACKOFF_DELAYS[BACKOFF_DELAYS.length - 1]
}

/**
 * Handle job failure with retry logic
 */
export async function handleJobFailure(jobId, error, providerName) {
  console.log(`🔍 Analyzing failure for job ${jobId}`)

  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) return { action: 'ignore' }

  const classification = classifyFailure(error)
  const retryCount = job.retryCount || 0

  console.log(`🔍 Classification: ${classification.label} (${classification.type})`)
  console.log(`🔍 Retry count: ${retryCount}/${MAX_RETRIES}`)

  // ----------------------------------------------------------
  // HARD FAIL OR MAX RETRIES EXCEEDED → DLQ + REFUND
  // ----------------------------------------------------------
  if (classification.type === 'HARD' || retryCount >= MAX_RETRIES) {
    console.log(`❌ Job ${jobId} permanently failed (${classification.label})`)

    // Move to DLQ
    await prisma.deadLetterJob.create({
      data: {
        originalJobId: jobId,
        userId: job.userId,
        gpuType: job.gpuType,
        errorMessage: error.message || 'Unknown error',
        errorCode: classification.label,
        attempts: retryCount + 1,
        lastAttemptAt: new Date()
      }
    })

    // Mark job as failed
    const refundAmount = job.totalCostNGN
    await prisma.$transaction([
      prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'failed',
          isDeadLetter: true,
          failedAt: new Date(),
          lastError: error.message,
          completedAt: new Date()
        }
      }),
      prisma.creditWallet.update({
        where: { userId: job.userId },
        data: { balance: { increment: refundAmount } }
      })
    ])

    // Proactive alert
    await notifyUser(
      job.userId,
      `❌ *Job Failed – Full Refund*\n\n` +
      `Job ID: ${jobId}\n` +
      `Reason: ${classification.label}\n` +
      `Refunded: ₦${refundAmount.toLocaleString()}\n\n` +
      `Our team has been notified. Try again with /start.`
    )

    // Notify admins
    await notifyAdmins(
      `🚨 *Job Permanently Failed*\n\n` +
      `Job: ${jobId}\n` +
      `User: ${job.userId}\n` +
      `GPU: ${job.gpuType}\n` +
      `Error: ${classification.label}\n` +
      `Attempts: ${retryCount + 1}`
    )

    return { action: 'dlq', refunded: refundAmount, classification }
  }

  // ----------------------------------------------------------
  // SOFT FAIL → RETRY WITH BACKOFF
  // ----------------------------------------------------------
  const nextRetryAt = new Date(Date.now() + getRetryDelay(retryCount))

  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: 'pending',
      retryCount: retryCount + 1,
      lastError: error.message,
      nextRetryAt,
      providerJobId: null,
      providerName: null,
      sshDetails: null
    }
  })

  console.log(`🔄 Job ${jobId} scheduled for retry at ${nextRetryAt.toISOString()} (attempt ${retryCount + 2})`)

  // Proactive alert (before user notices)
  await notifyUser(
    job.userId,
    `🔄 *Retrying Your Job*\n\n` +
    `Job ID: ${jobId}\n` +
    `Reason: ${classification.label}\n` +
    `Attempt: ${retryCount + 2} of ${MAX_RETRIES + 1}\n\n` +
    `We're retrying on a different provider. No action needed.`
  )

  return {
    action: 'retry',
    retryDelay: getRetryDelay(retryCount),
    nextRetryAt,
    retryCount: retryCount + 1,
    classification
  }
}

// ============================================================
// CANCELLATION HANDLER (unchanged from Day 6)
// ============================================================

export async function handleJobCancellation(jobId) {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) return { success: false, error: 'Job not found' }

  if (!['pending', 'provisioning', 'running'].includes(job.status)) {
    return { success: false, error: `Cannot cancel job with status: ${job.status}` }
  }

  // Terminate provider instance
  if (job.providerJobId && job.providerName) {
    try {
      if (job.providerName === 'runpod') {
        await terminateRunPod(job.providerJobId)
      } else if (job.providerName === 'vastai') {
        await terminateVastai(job.providerJobId)
      }
    } catch (err) {
      console.error(`Termination failed for ${jobId}:`, err.message)
    }
  }

  const refundAmount = job.totalCostNGN
  await prisma.$transaction([
    prisma.job.update({
      where: { id: jobId },
      data: { status: 'cancelled', completedAt: new Date() }
    }),
    prisma.creditWallet.update({
      where: { userId: job.userId },
      data: { balance: { increment: refundAmount } }
    })
  ])

  await notifyUser(
    job.userId,
    `✅ *Job Cancelled*\n\n` +
    `Job ID: ${jobId}\n` +
    `Refunded: ₦${refundAmount.toLocaleString()}`
  )

  return { success: true, refunded: refundAmount }
}

// ============================================================
// NOTIFICATION HELPERS
// ============================================================

async function notifyUser(userId, message) {
  try {
    const { initTelegramBot } = await import('../bot/telegram.js')
    const { sendWhatsAppMessage } = await import('../bot/whatsapp.js')

    try {
      const bot = await initTelegramBot(process.env.TELEGRAM_BOT_TOKEN, process.env.REDIS_URL, null)
      await bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' })
    } catch (e) {
      await sendWhatsAppMessage(userId, message)
    }
  } catch (err) {
    console.error('Notification failed:', err.message)
  }
}

async function notifyAdmins(message) {
  const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(id => id.trim()).filter(Boolean)

  for (const adminId of adminIds) {
    try {
      const { initTelegramBot } = await import('../bot/telegram.js')
      const bot = await initTelegramBot(process.env.TELEGRAM_BOT_TOKEN, process.env.REDIS_URL, null)
      await bot.telegram.sendMessage(adminId, message, { parse_mode: 'Markdown' })
    } catch (err) {
      console.error(`Admin notification failed for ${adminId}:`, err.message)
    }
  }
}