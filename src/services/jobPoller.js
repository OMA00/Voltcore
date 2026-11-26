import { prisma } from '../db/prisma.js'
import { getPodState } from '../providers/pods.js'
import { completeJob, enqueueProvisioning, sweepStuckJobs, hasHold } from './billing.js'

/**
 * Check running jobs; when a pod has exited, mark the job completed.
 * No money moves here: the user paid when the job was created. (This used to deduct the
 * job price a second time, on top of the metering worker.)
 */
export async function pollRunningJobs() {
  const runningJobs = await prisma.job.findMany({
    where: { status: 'running', providerJobId: { not: null } }
  })

  for (const job of runningJobs) {
    try {
      const state = await getPodState(job.providerName, job.providerJobId)
      if (state === 'exited') {
        const { completed } = await completeJob(job.id)
        if (completed) console.log(`✅ Job ${job.id} completed (pod exited)`)
      }
    } catch (error) {
      console.error(`Job ${job.id} polling error:`, error.message)
    }
  }
}

/**
 * Re-queue soft-failed jobs whose retry time has passed. Uses the same BullMQ job id as
 * the worker's own delayed retry, so the two paths can never queue the job twice.
 */
async function checkPendingRetries(queue) {
  const due = await prisma.job.findMany({
    where: { status: 'pending', jobType: 'gpu', providerJobId: null, retryCount: { gt: 0 }, nextRetryAt: { lte: new Date() } }
  })
  for (const job of due) {
    if (!(await hasHold(job.id))) continue // legacy job: never auto-provisioned
    await enqueueProvisioning(queue, job, job.retryCount)
  }
}

export function startJobPoller(queue) {
  console.log('🔄 Job poller started (30s interval)')
  setInterval(async () => {
    try {
      await pollRunningJobs()
      await checkPendingRetries(queue)
      const swept = await sweepStuckJobs({ enqueue: job => enqueueProvisioning(queue, job, `sweep`) })
      const n = swept.requeued.length + swept.refunded.length + swept.resumed.length
      if (n > 0) console.log(`🧹 Sweep: requeued ${swept.requeued.length}, refunded ${swept.refunded.length}, resumed ${swept.resumed.length}`)
    } catch (error) {
      console.error('Job poller error:', error)
    }
  }, 30000)
}
