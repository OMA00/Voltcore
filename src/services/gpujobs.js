// ============================================================
// GPU job queue handlers: provision once, then meter (stop + complete).
// Called by the single BullMQ worker in index.js, which routes by job name.
// ============================================================
import { prisma } from '../db/prisma.js'
import { getCheapestProvider } from '../providers/provider.router.js'
import { provisionRunPod } from '../providers/runpod.js'
import { provisionVastai } from '../providers/vastai.js'
import { podNameFor, getPodState, terminatePod } from '../providers/pods.js'
import { claimForProvisioning, recordPod, completeJob, enqueueProvisioning, hasHold } from './billing.js'
import { handleJobFailure } from './failHandler.js'
import { sendToUser, sendToAdmins } from './messenger.js'
import { notifyJobComplete } from './notifications.js'
import { jobsTotal, jobDuration, activeJobs, revenueTotal } from './metrics.js'

const TERMINATE_RETRY_MS = 5 * 60 * 1000

/**
 * Provision a GPU for a held job, exactly once.
 * - Skips jobs that already have a pod or are no longer pending (cancelled, refunding...).
 * - Saves the pod id immediately. If the job was cancelled while the provider call was in
 *   flight, the new pod is terminated instead of left running.
 * - On failure, a pod that was created is terminated before the retry/refund logic runs,
 *   so a retry can never leave a second pod behind.
 */
export async function handleProvisionJob(data, queue) {
  const { jobId } = data
  const started = Date.now()
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) return { skipped: 'missing' }
  if (job.providerJobId) { console.log(`⏭️ Job ${jobId} already has pod ${job.providerJobId}; not deploying again`); return { skipped: 'has-pod' } }
  if (!(await hasHold(jobId))) {
    console.log(`[legacy-job] ${jobId} has no hold (created before pre-pay holds); not provisioning`)
    return { skipped: 'legacy' }
  }
  if (!(await claimForProvisioning(jobId))) { console.log(`⏭️ Job ${jobId} is ${job.status}; not provisioning`); return { skipped: job.status } }

  let provider = null
  let pod = null
  try {
    provider = await getCheapestProvider(job.gpuType, jobId)
    console.log(`📡 Job ${jobId}: provisioning on ${provider.name}`)
    const name = podNameFor(jobId)
    pod = provider.name === 'runpod'
      ? await provisionRunPod(job.gpuType, job.requestedHours, { gpuCount: data.gpuCount || 1, podName: name })
      : await provisionVastai(job.gpuType, job.requestedHours, { label: name })

    const saved = await recordPod(jobId, {
      providerName: provider.name,
      podId: pod.id,
      sshDetails: pod.sshDetails,
      providerCostUSD: (pod.costPerHourUSD || 0) * job.requestedHours,
      billedNGN: job.totalCostNGN
    })
    if (!saved) {
      console.log(`🛑 Job ${jobId} was cancelled during provisioning; terminating new pod ${pod.id}`)
      await terminatePod(provider.name, pod.id)
      return { skipped: 'cancelled-during-provision' }
    }
  } catch (err) {
    console.error(`❌ Job ${jobId} provisioning failed:`, err.message)
    if (pod?.id && provider) {
      const gone = await terminatePod(provider.name, pod.id)
      if (!gone) await sendToAdmins(`⚠️ Job ${jobId}: provisioning failed after pod ${pod.id} was created, and it would not terminate.`)
    }
    jobsTotal.inc({ gpuType: job.gpuType, status: 'failed', provider: provider?.name || 'unknown' })
    const outcome = await handleJobFailure(jobId, err, provider?.name || 'unknown')
    if (outcome.action === 'retry') {
      await enqueueProvisioning(queue, job, outcome.retryCount, outcome.retryDelay)
    }
    return { failed: true, action: outcome.action }
  }

  // The pod exists and is saved. Nothing below may trigger a retry or refund.
  try {
    await queue.add('meter-usage', { jobId }, { jobId: `meter-${jobId}-0`, delay: job.requestedHours * 60 * 60 * 1000 })
  } catch (err) {
    await sendToAdmins(`⚠️ Job ${jobId}: could not schedule the end-of-job stop (${err.message}). The poller will still complete it when the pod exits.`)
  }
  try {
    jobsTotal.inc({ gpuType: job.gpuType, status: 'provisioned', provider: provider.name })
    revenueTotal.inc({ source: 'gpu' }, job.totalCostNGN)
    activeJobs.inc()
    jobDuration.observe({ gpuType: job.gpuType, status: 'provisioned' }, (Date.now() - started) / 1000)
  } catch {}
  await sendToUser(job.userId,
    `✅ *GPU Ready!*\n\n` +
    `🔗 Provider: ${provider.name.toUpperCase()}\n` +
    (pod.sshDetails ? `🖥️ SSH:\n\`\`\`\n${pod.sshDetails}\n\`\`\`\n` : `🖥️ Connection details will follow once the GPU finishes starting. Use /status ${jobId.slice(0, 8)}.\n`) +
    `⏱️ ${job.requestedHours} hours\n` +
    `📋 Job: ${jobId}`)
  return { provisioned: true }
}

/**
 * End of the paid time: stop the pod, then mark the job completed. No money moves here;
 * the user paid when the job was created. If the pod will not stop, the job stays
 * running and this check is retried in 5 minutes.
 */
export async function handleMeterJob(data, queue, attempt = 0) {
  const { jobId } = data
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job || job.status !== 'running') return { skipped: job?.status || 'missing' }

  if (job.providerJobId) {
    const state = await getPodState(job.providerName, job.providerJobId)
    if (state !== 'exited' && !(await terminatePod(job.providerName, job.providerJobId))) {
      await sendToAdmins(`⚠️ Job ${jobId}: paid time is over but the pod would not terminate. Retrying in 5 minutes.`)
      await queue.add('meter-usage', { jobId, attempt: attempt + 1 }, { jobId: `meter-${jobId}-${attempt + 1}`, delay: TERMINATE_RETRY_MS })
      return { retry: true }
    }
  }

  const { completed } = await completeJob(jobId)
  if (completed) {
    try {
      activeJobs.dec()
      jobsTotal.inc({ gpuType: job.gpuType, status: 'completed', provider: job.providerName })
    } catch {}
    try {
      const user = await prisma.user.findUnique({ where: { id: job.userId } })
      if (user) await notifyJobComplete(user, job)
    } catch (e) {
      console.error('Job-complete notification failed:', e.message)
    }
  }
  return { completed }
}
