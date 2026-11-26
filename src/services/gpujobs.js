// ============================================================
// GPU job queue handlers: provision once, then meter (stop + complete).
// Called by the single BullMQ worker in index.js, which routes by job name.
// ============================================================
import { prisma } from '../db/prisma.js'
import { getCheapestProvider } from '../providers/provider.router.js'
import { provisionRunPod } from '../providers/runpod.js'
import { provisionVastai } from '../providers/vastai.js'
import { podNameFor, getPodState, terminatePod, findPodsByName } from '../providers/pods.js'
import { claimForProvisioning, recordPod, completeJob, enqueueProvisioning, hasHold } from './billing.js'
import { handleJobFailure } from './failHandler.js'
import { sendToUser, sendToAdmins } from './messenger.js'
import { notifyJobComplete } from './notifications.js'
import { jobsTotal, jobDuration, activeJobs, revenueTotal } from './metrics.js'

const TERMINATE_RETRY_MS = 5 * 60 * 1000

const defaultDeps = {
  getCheapestProvider,
  provision: { runpod: provisionRunPod, vastai: provisionVastai },
  findPodsByName,
  terminatePod,
  handleJobFailure,
  sendToUser,
  sendToAdmins,
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  lookupDelayMs: 15_000 // a pod created by a timed-out request can take a moment to be listed
}

/**
 * Look for a pod named voltcore-<jobId> on every provider.
 * @returns {{ status: 'adopted', providerName, podId } | { status: 'none' } | { status: 'unknown' }}
 *   'unknown' means the lookup itself failed, so we cannot tell whether a pod exists.
 */
async function findOwnPod(jobId, d) {
  let found
  try { found = await d.findPodsByName(podNameFor(jobId)) } catch { return { status: 'unknown' } }
  if (found.length === 0) return { status: 'none' }
  const [keep, ...extra] = found
  // More than one should be impossible now that creates are never retried; stop any extras.
  for (const e of extra) {
    console.error(`⚠️ Job ${jobId}: extra pod ${e.providerName}/${e.podId} with the same name; terminating it`)
    await d.terminatePod(e.providerName, e.podId)
  }
  return { status: 'adopted', providerName: keep.providerName, podId: keep.podId }
}

/** Leave the job in `provisioning` for the sweep (which finds by name, stops, refunds). */
async function leaveForSweep(jobId, reason, d) {
  console.error(`⚠️ Job ${jobId}: ${reason}. Not provisioning again; the sweep will check by name.`)
  await d.sendToAdmins(`⚠️ Job ${jobId}: ${reason}. Left in provisioning for the sweep (find by name, stop, refund).`)
  return { skipped: 'unknown-outcome' }
}

/**
 * Provision a GPU for a held job, exactly once.
 * - Skips jobs that already have a pod, have no hold (legacy), or are no longer pending.
 * - A create call is never retried blind. If its outcome is unknown (timeout, dropped
 *   connection, 5xx), the pod is looked up by its voltcore-<jobId> name and adopted if found.
 * - A retry attempt first looks for a pod left by an earlier attempt.
 * - Saves the pod id immediately. If the job was cancelled while the provider call was in
 *   flight, the new pod is terminated instead of left running.
 * - On a clean failure, a pod that was created is terminated before the retry/refund logic
 *   runs, so a retry can never leave a second pod behind.
 */
export async function handleProvisionJob(data, queue, deps = {}) {
  const d = { ...defaultDeps, ...deps, provision: { ...defaultDeps.provision, ...(deps.provision || {}) } }
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

  // A retry may follow an attempt whose create call had an unknown outcome: look first.
  if ((job.retryCount || 0) > 0) {
    const prior = await findOwnPod(jobId, d)
    if (prior.status === 'adopted') return adopt(job, prior, queue, d, started)
    if (prior.status === 'unknown') return leaveForSweep(jobId, 'could not check for a pod from the previous attempt', d)
  }

  let provider = null
  let pod = null
  try {
    provider = await d.getCheapestProvider(job.gpuType, jobId)
    console.log(`📡 Job ${jobId}: provisioning on ${provider.name}`)
    const name = podNameFor(jobId)
    pod = provider.name === 'runpod'
      ? await d.provision.runpod(job.gpuType, job.requestedHours, { gpuCount: data.gpuCount || 1, podName: name })
      : await d.provision.vastai(job.gpuType, job.requestedHours, { label: name })

    const saved = await recordPod(jobId, {
      providerName: provider.name,
      podId: pod.id,
      sshDetails: pod.sshDetails,
      providerCostUSD: (pod.costPerHourUSD || 0) * job.requestedHours,
      billedNGN: job.totalCostNGN
    })
    if (!saved) {
      console.log(`🛑 Job ${jobId} was cancelled during provisioning; terminating new pod ${pod.id}`)
      await d.terminatePod(provider.name, pod.id)
      return { skipped: 'cancelled-during-provision' }
    }
  } catch (err) {
    // Outcome unknown: the provider may have created the pod even though we got no answer.
    if (err.ambiguous && !pod) {
      let found = await findOwnPod(jobId, d)
      if (found.status === 'none') {
        await d.sleep(d.lookupDelayMs)
        found = await findOwnPod(jobId, d)
      }
      if (found.status === 'adopted') return adopt(job, found, queue, d, started)
      if (found.status === 'unknown') return leaveForSweep(jobId, 'create call had an unknown outcome and the pod lookup failed', d)
      console.log(`Job ${jobId}: no pod named ${podNameFor(jobId)} after an unknown outcome; treating as a clean failure`)
    }

    console.error(`❌ Job ${jobId} provisioning failed:`, err.message)
    if (pod?.id && provider) {
      const gone = await d.terminatePod(provider.name, pod.id)
      if (!gone) await d.sendToAdmins(`⚠️ Job ${jobId}: provisioning failed after pod ${pod.id} was created, and it would not terminate.`)
    }
    try { jobsTotal.inc({ gpuType: job.gpuType, status: 'failed', provider: provider?.name || 'unknown' }) } catch {}
    const outcome = await d.handleJobFailure(jobId, err, provider?.name || 'unknown')
    if (outcome.action === 'retry') {
      await enqueueProvisioning(queue, job, outcome.retryCount, outcome.retryDelay)
    }
    return { failed: true, action: outcome.action }
  }

  return afterProvisioned(job, provider.name, pod, queue, d, started)
}

/** Save a pod we found by name (created by a call whose reply we never got) as this job's pod. */
async function adopt(job, found, queue, d, started) {
  console.log(`🔗 Job ${job.id}: adopting pod ${found.providerName}/${found.podId} found by name`)
  const saved = await recordPod(job.id, {
    providerName: found.providerName,
    podId: found.podId,
    sshDetails: null,
    providerCostUSD: null, // unknown: the create reply that carried the price was lost
    billedNGN: job.totalCostNGN
  })
  if (!saved) {
    console.log(`🛑 Job ${job.id} left provisioning before adoption; terminating ${found.podId}`)
    await d.terminatePod(found.providerName, found.podId)
    return { skipped: 'cancelled-during-provision' }
  }
  const result = await afterProvisioned(job, found.providerName, { id: found.podId, sshDetails: null }, queue, d, started)
  return { ...result, adopted: true }
}

/** The pod exists and is saved. Nothing here may trigger a retry or refund. */
async function afterProvisioned(job, providerName, pod, queue, d, started) {
  const jobId = job.id
  try {
    await queue.add('meter-usage', { jobId }, { jobId: `meter-${jobId}-0`, delay: job.requestedHours * 60 * 60 * 1000 })
  } catch (err) {
    await d.sendToAdmins(`⚠️ Job ${jobId}: could not schedule the end-of-job stop (${err.message}). The poller will still complete it when the pod exits.`)
  }
  try {
    jobsTotal.inc({ gpuType: job.gpuType, status: 'provisioned', provider: providerName })
    revenueTotal.inc({ source: 'gpu' }, job.totalCostNGN)
    activeJobs.inc()
    jobDuration.observe({ gpuType: job.gpuType, status: 'provisioned' }, (Date.now() - started) / 1000)
  } catch {}
  await d.sendToUser(job.userId,
    `✅ *GPU Ready!*\n\n` +
    `🔗 Provider: ${providerName.toUpperCase()}\n` +
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
