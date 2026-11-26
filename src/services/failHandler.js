import { prisma } from '../db/prisma.js'
import { refundJob } from './billing.js'
import { sendToUser, sendToAdmins } from './messenger.js'


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
 * Handle a provisioning failure: retry SOFT failures with backoff, refund HARD ones.
 * Called only while the job is `provisioning` and has no saved pod (gpujobs.js terminates
 * any pod it created before calling this), so a retry can never leave a pod behind.
 * @returns {{ action: 'retry'|'dlq'|'ignore', retryDelay?, retryCount?, classification? }}
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
  // HARD FAIL OR MAX RETRIES EXCEEDED → DLQ + FULL REFUND
  // ----------------------------------------------------------
  if (classification.type === 'HARD' || retryCount >= MAX_RETRIES) {
    console.log(`❌ Job ${jobId} permanently failed (${classification.label})`)

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

    // Once-only refund of the hold (full, per refund policy for failures).
    const refund = await refundJob(jobId, 'hard_failure', {
      extraData: { isDeadLetter: true, failedAt: new Date(), lastError: error.message || 'Unknown error' }
    })

    if (refund.ok) {
      await notifyUser(
        job.userId,
        `❌ *Job Failed – Refunded*\n\n` +
        `Job ID: ${jobId}\n` +
        `Reason: ${classification.label}\n` +
        `Refunded: ₦${refund.refunded.toLocaleString()}\n\n` +
        `Our team has been notified. Try again with /start.`
      )
    }

    await notifyAdmins(
      `🚨 *Job Permanently Failed*\n\n` +
      `Job: ${jobId}\n` +
      `User: ${job.userId}\n` +
      `GPU: ${job.gpuType}\n` +
      `Error: ${classification.label}\n` +
      `Attempts: ${retryCount + 1}\n` +
      `Refund: ${refund.ok ? '₦' + refund.refunded : 'NOT DONE – ' + refund.error}`
    )

    return { action: 'dlq', refunded: refund.refunded || 0, classification }
  }

  // ----------------------------------------------------------
  // SOFT FAIL → RETRY WITH BACKOFF
  // Only from `provisioning`; if the user cancelled meanwhile, do nothing.
  // ----------------------------------------------------------
  const delay = getRetryDelay(retryCount)
  const nextRetryAt = new Date(Date.now() + delay)

  const { count } = await prisma.job.updateMany({
    where: { id: jobId, status: 'provisioning', providerJobId: null },
    data: {
      status: 'pending',
      retryCount: retryCount + 1,
      lastError: error.message,
      nextRetryAt
    }
  })
  if (count !== 1) return { action: 'ignore', classification }

  console.log(`🔄 Job ${jobId} scheduled for retry at ${nextRetryAt.toISOString()} (attempt ${retryCount + 2})`)

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
    retryDelay: delay,
    nextRetryAt,
    retryCount: retryCount + 1,
    classification
  }
}

// ============================================================
// CANCELLATION (user, web dashboard, admin)
// ============================================================

/**
 * Cancel a job and refund it once, per the refund policy (full before the GPU runs,
 * unused whole hours while it runs). The pod is terminated before any money moves.
 * Keeps the old return shape for existing callers.
 */
export async function handleJobCancellation(jobId) {
  const result = await refundJob(jobId, 'user_cancel')
  if (!result.ok) return { success: false, error: result.error }

  const job = await prisma.job.findUnique({ where: { id: jobId } })
  await notifyUser(
    job.userId,
    `✅ *Job Cancelled*\n\n` +
    `Job ID: ${jobId}\n` +
    `Refunded: ₦${result.refunded.toLocaleString()}`
  )
  return { success: true, refunded: result.refunded }
}

// ============================================================
// NOTIFICATION HELPERS
// ============================================================

// `userId` here is the DATABASE id. The messenger looks up the platform id (Telegram chat
// id or WhatsApp JID). Before, this sent straight to the database id, which Telegram
// rejected, so users never heard about failures or refunds.
async function notifyUser(userId, message) {
  await sendToUser(userId, message)
}

async function notifyAdmins(message) {
  await sendToAdmins(message)
}
