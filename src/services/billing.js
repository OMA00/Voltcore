// ============================================================
// GPU job billing: hold, provision-once, complete, refund, sweep.
//
// Rules (CLAUDE.md money path, Day 23 design note):
//  - The user pays when the job is created: a hold debited with ledger ref job_<jobId>.
//    The hold IS the charge (pre-pay, fixed hours); completion moves no money.
//  - A refund happens at most once (ref refund_<jobId>), only up to the hold, and only
//    after the provider pod is terminated.
//  - Every status change uses updateMany with a status filter and checks the count, so
//    two workers racing on one job cannot both act.
//
// Job.status values (plain strings; no schema change):
//   pending -> provisioning -> running -> completed
//   any active -> refunding -> cancelled | failed | refunded
//
// Job fields reused without a schema change:
//   nextRetryAt  time of the last state change the sweep should measure from
//                (provisioning claimed, sweep re-enqueue, refund claimed)
//   lastError    error text, or the sweep marker, or the refund plan (JSON) while refunding
// ============================================================
import { prisma } from '../db/prisma.js'
import { applyWalletChange, findLedgerEntry, DuplicateReferenceError } from './walletLedger.js'
import * as pods from '../providers/pods.js'
import { sendToUser, sendToAdmins } from './messenger.js'

export const ACTIVE_STATUSES = ['pending', 'provisioning', 'running']
export const STUCK_AFTER_MS = 10 * 60 * 1000
export const SWEEP_MARK = 'sweep: re-enqueued once'
const HOUR_MS = 60 * 60 * 1000

export const holdReference = jobId => `job_${jobId}`
export const refundReference = jobId => `refund_${jobId}`
export const provisionQueueId = (jobId, attempt) => `provision-${jobId}-${attempt}`

const defaultDeps = {
  terminatePod: pods.terminatePod,
  findPodsByName: pods.findPodsByName,
  notifyUser: sendToUser,
  notifyAdmins: sendToAdmins,
  now: () => new Date()
}

// ------------------------------------------------------------
// Refund policy: the one place to change how much a refund returns.
// ------------------------------------------------------------
/**
 * @param {object} p
 * @param {'user_cancel'|'hard_failure'|'stuck'|'admin'} p.reason
 * @param {string} p.fromStatus      job status before the refund started
 * @param {number} p.holdNGN         amount held at creation (0 for jobs created before holds)
 * @param {number} p.pricePerHourNGN
 * @param {number} p.requestedHours
 * @param {Date|null} p.startedAt    Job.startedAt: set when the provider returned a pod id,
 *                                   which is when the provider starts billing us
 * @param {Date} p.now
 * @returns {number} NGN to refund, never more than the hold
 */
export function refundPolicy({ reason, fromStatus, holdNGN, pricePerHourNGN, requestedHours, startedAt, now }) {
  if (!(holdNGN > 0)) return 0
  // Our fault or the provider's, an admin override, or the GPU never ran: full hold back.
  if (reason === 'hard_failure' || reason === 'admin') return holdNGN
  if (fromStatus === 'pending' || fromStatus === 'provisioning') return holdNGN
  // User cancels a running GPU: refund unused whole hours, rounded down.
  if (fromStatus === 'running') {
    if (!startedAt) return holdNGN
    const elapsedHours = Math.max(0, (now.getTime() - new Date(startedAt).getTime()) / HOUR_MS)
    const unusedWholeHours = Math.floor(Math.max(0, requestedHours - elapsedHours))
    return Math.min(holdNGN, unusedWholeHours * pricePerHourNGN)
  }
  return 0
}

const finalStatusFor = { user_cancel: 'cancelled', admin: 'refunded', hard_failure: 'failed', stuck: 'failed' }

// ------------------------------------------------------------
// Hold at creation
// ------------------------------------------------------------
/** Create the job and debit the full price in one transaction. Throws InsufficientBalanceError. */
export async function createJobWithHold({ userId, gpuType, hours, pricePerHourNGN }) {
  const total = hours * pricePerHourNGN
  return prisma.$transaction(async tx => {
    const job = await tx.job.create({
      data: {
        userId, gpuType, requestedHours: hours, costPerHourNGN: pricePerHourNGN,
        totalCostNGN: total, status: 'pending', jobType: 'gpu'
      }
    })
    await applyWalletChange(userId, 'job_debit', -total, {
      reference: holdReference(job.id),
      description: `GPU job ${job.id.slice(0, 8)} (${gpuType.toUpperCase()}, ${hours}h), paid upfront`,
      metadata: { jobId: job.id, gpuType, hours },
      tx
    })
    return job
  })
}

/** Queue provisioning. The BullMQ job id is fixed per attempt, so a repeat add is a no-op. */
export async function enqueueProvisioning(queue, job, attempt = 0, delay = 0) {
  await queue.add('provision-gpu', {
    jobId: job.id, gpuType: job.gpuType, hours: job.requestedHours, userId: job.userId, jobType: 'gpu'
  }, { jobId: provisionQueueId(job.id, attempt), delay })
}

// ------------------------------------------------------------
// Provision once
// ------------------------------------------------------------
/** pending -> provisioning. False if the job is in any other state or already has a pod. */
export async function claimForProvisioning(jobId, now = new Date()) {
  const { count } = await prisma.job.updateMany({
    where: { id: jobId, status: 'pending', providerJobId: null },
    data: { status: 'provisioning', nextRetryAt: now }
  })
  return count === 1
}

/** Save the pod the moment the provider returns it. False if the job left `provisioning` meanwhile. */
export async function recordPod(jobId, { providerName, podId, sshDetails, providerCostUSD, billedNGN }, now = new Date()) {
  const { count } = await prisma.job.updateMany({
    where: { id: jobId, status: 'provisioning' },
    data: {
      status: 'running', providerJobId: String(podId), providerName, sshDetails: sshDetails || null,
      startedAt: now, providerCostUSD, fxRateAtProvision: null, billedNGN
    }
  })
  return count === 1
}

// ------------------------------------------------------------
// Complete (no money moves: the hold was the charge)
// ------------------------------------------------------------
export async function completeJob(jobId, now = new Date()) {
  const { count } = await prisma.job.updateMany({
    where: { id: jobId, status: 'running' },
    data: { status: 'completed', completedAt: now }
  })
  if (count !== 1) return { completed: false }
  const hold = await findLedgerEntry(holdReference(jobId))
  if (!hold) console.log(`[legacy-job] ${jobId} completed with no hold row: not charged, not refunded`)
  return { completed: true, legacy: !hold }
}

// ------------------------------------------------------------
// Once-only refund
// ------------------------------------------------------------
/**
 * Refund a job at most once. Terminates the pod first; if that fails, no money moves and
 * the job stays `refunding` for the sweep to retry.
 * @returns {{ ok: boolean, refunded?: number, pending?: boolean, legacy?: boolean, error?: string }}
 */
export async function refundJob(jobId, reason, options = {}, deps = {}) {
  const d = { ...defaultDeps, ...deps }
  const now = d.now()
  let job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) return { ok: false, error: 'Job not found' }

  let plan
  let legacy = false
  if (job.status === 'refunding') {
    // Resuming a refund that stopped part-way (crash, or the pod would not terminate).
    try { plan = JSON.parse(job.lastError).refund } catch { plan = null }
    if (!plan) return { ok: false, error: 'Refund in progress with no saved plan; needs an admin' }
  } else {
    if (!ACTIVE_STATUSES.includes(job.status)) {
      return { ok: false, error: `This job is already ${job.status}.` }
    }
    const hold = await findLedgerEntry(holdReference(jobId))
    legacy = !hold
    const holdNGN = hold ? -hold.amountNGN : 0
    if (legacy) console.log(`[legacy-job] ${jobId} has no hold row: refund is ₦0`)
    plan = {
      reason,
      fromStatus: job.status,
      amount: refundPolicy({
        reason, fromStatus: job.status, holdNGN, pricePerHourNGN: job.costPerHourNGN,
        requestedHours: job.requestedHours, startedAt: job.startedAt, now
      }),
      finalStatus: options.finalStatus || finalStatusFor[reason] || 'refunded',
      extraData: options.extraData || {}
    }
    // Claim: only one caller can move the job out of its current status.
    const { count } = await prisma.job.updateMany({
      where: { id: jobId, status: job.status },
      data: { status: 'refunding', nextRetryAt: now, lastError: JSON.stringify({ refund: plan }) }
    })
    if (count !== 1) return { ok: false, error: 'This job changed while cancelling. Please check /activejobs.' }
  }

  // Terminate before refunding, or we pay for compute we gave back.
  if (job.providerJobId && job.providerName) {
    const gone = await d.terminatePod(job.providerName, job.providerJobId)
    if (!gone) {
      // Push the next sweep attempt a full threshold away, so a provider outage is not hammered.
      await prisma.job.updateMany({ where: { id: jobId, status: 'refunding' }, data: { nextRetryAt: now } })
      await d.notifyAdmins(`⚠️ Could not terminate pod for job ${jobId} (${job.providerName}). Refund is waiting; the sweep will retry.`)
      return { ok: false, pending: true, error: "We couldn't stop the GPU yet. Your refund will follow automatically once it stops." }
    }
  }

  try {
    await prisma.$transaction(async tx => {
      const already = await tx.walletLedger.findUnique({ where: { reference: refundReference(jobId) } })
      if (plan.amount > 0 && !already) {
        await applyWalletChange(job.userId, 'refund', plan.amount, {
          reference: refundReference(jobId),
          description: `Refund for job ${jobId.slice(0, 8)} (${plan.reason.replace('_', ' ')})`,
          metadata: { jobId, reason: plan.reason, fromStatus: plan.fromStatus },
          tx
        })
      }
      await tx.job.updateMany({
        where: { id: jobId, status: 'refunding' },
        data: { status: plan.finalStatus, completedAt: now, ...plan.extraData }
      })
    })
  } catch (err) {
    // A concurrent resume already credited this refund; the reference stopped a second credit.
    if (!(err instanceof DuplicateReferenceError)) throw err
    await prisma.job.updateMany({ where: { id: jobId, status: 'refunding' }, data: { status: plan.finalStatus, completedAt: now } })
  }

  return { ok: true, refunded: plan.amount, legacy }
}

// ------------------------------------------------------------
// Sweep: recover jobs stuck after a crash. Only looks at jobs whose last state change is
// older than STUCK_AFTER_MS, so provider APIs are only called for genuinely stuck jobs.
// ------------------------------------------------------------
/**
 * @param {object} p
 * @param {(job) => Promise<void>} p.enqueue  re-queue provisioning for a job
 * @returns {{ requeued: string[], refunded: string[], resumed: string[], skipped: string[] }}
 */
export async function sweepStuckJobs({ enqueue }, deps = {}) {
  const d = { ...defaultDeps, ...deps }
  const now = d.now()
  const cutoff = new Date(now.getTime() - STUCK_AFTER_MS)
  const old = { OR: [{ nextRetryAt: null, createdAt: { lt: cutoff } }, { nextRetryAt: { lt: cutoff } }] }
  const out = { requeued: [], refunded: [], resumed: [], skipped: [] }

  // 1. Held but never provisioned (crash between hold and enqueue, or a lost queue entry).
  const pending = await prisma.job.findMany({ where: { status: 'pending', providerJobId: null, jobType: 'gpu', ...old } })
  for (const job of pending) {
    if (job.lastError !== SWEEP_MARK) {
      // First time: re-enqueue once.
      const { count } = await prisma.job.updateMany({
        where: { id: job.id, status: 'pending', OR: [{ lastError: null }, { lastError: { not: SWEEP_MARK } }] },
        data: { lastError: SWEEP_MARK, nextRetryAt: now }
      })
      if (count === 1) { await enqueue(job); out.requeued.push(job.id) }
    } else {
      // Already re-enqueued once and still not provisioned: give the money back.
      const r = await refundJob(job.id, 'stuck', {}, d)
      if (r.ok) {
        out.refunded.push(job.id)
        await d.notifyUser(job.userId, `⚠️ We couldn't start your GPU job ${job.id.slice(0, 8)}. ₦${r.refunded.toLocaleString()} has been returned to your wallet.`)
      }
    }
  }

  // 2. Crashed mid-provisioning: a pod may exist that we never saved. Find it by name.
  const provisioning = await prisma.job.findMany({ where: { status: 'provisioning', providerJobId: null, ...old } })
  for (const job of provisioning) {
    let orphans
    try { orphans = await d.findPodsByName(pods.podNameFor(job.id)) } catch { out.skipped.push(job.id); continue }
    let allGone = true
    for (const o of orphans) {
      if (!(await d.terminatePod(o.providerName, o.podId))) allGone = false
    }
    if (!allGone) {
      await d.notifyAdmins(`⚠️ Orphan pod for job ${job.id} would not terminate. Refund held back.`)
      out.skipped.push(job.id)
      continue
    }
    const r = await refundJob(job.id, 'stuck', {}, d)
    if (r.ok) {
      out.refunded.push(job.id)
      await d.notifyUser(job.userId, `⚠️ Your GPU job ${job.id.slice(0, 8)} didn't start. ₦${r.refunded.toLocaleString()} has been returned to your wallet.`)
    }
  }

  // 3. Refunds that stopped part-way.
  const refunding = await prisma.job.findMany({ where: { status: 'refunding', ...old } })
  for (const job of refunding) {
    const r = await refundJob(job.id, null, {}, d)
    if (r.ok) out.resumed.push(job.id)
    else out.skipped.push(job.id)
  }

  return out
}
