import { prisma } from '../db/prisma.js'
import { getRunPodStatus } from '../providers/runpod.js'
import { getVastaiStatus } from '../providers/vastai.js'

export async function pollRunningJobs() {
  const runningJobs = await prisma.job.findMany({
    where: {
      status: 'running',
      providerJobId: { not: null }
    }
  })

  for (const job of runningJobs) {
    try {
      let status
      if (job.providerName === 'runpod') {
        status = await getRunPodStatus(job.providerJobId)
      } else if (job.providerName === 'vastai') {
        status = await getVastaiStatus(job.providerJobId)
      }

      if (status === 'RUNNING' || status === 'running') {
        await prisma.job.update({
          where: { id: job.id },
          data: { startedAt: job.startedAt || new Date() }
        })
      } else if (status === 'EXITED' || status === 'stopped' || status === 'failed') {
        // Job terminated externally
        const cost = job.requestedHours * job.costPerHourNGN
        await prisma.$transaction([
          prisma.job.update({
            where: { id: job.id },
            data: { status: 'completed', completedAt: new Date() }
          }),
          prisma.creditWallet.update({
            where: { userId: job.userId },
            data: { balance: { decrement: cost } }
          })
        ])

        console.log(`✅ Job ${job.id} completed. Deducted ₦${cost}`)
      }
    } catch (error) {
      console.error(`Job ${job.id} polling error:`, error.message)
    }
  }

  // Check for pending retries
  await checkPendingRetries()
}

async function checkPendingRetries() {
  const now = new Date()
  const pendingRetries = await prisma.job.findMany({
    where: {
      status: 'pending',
      retryCount: { gt: 0 },
      nextRetryAt: { lte: now }
    }
  })

  for (const job of pendingRetries) {
    console.log(`🔄 Retrying job ${job.id} (attempt ${job.retryCount + 1})`)

    // Re-queue
    const { gpuQueue } = await import('../index.js').catch(() => ({}))
    if (gpuQueue) {
      await gpuQueue.add('provision-gpu', {
        jobId: job.id,
        gpuType: job.gpuType,
        hours: job.requestedHours,
        userId: job.userId,
        userTelegramId: job.userId,
        jobType: job.jobType
      })
    }
  }
}

export function startJobPoller() {
  console.log('🔄 Job poller started (30s interval)')
  setInterval(async () => {
    try {
      await pollRunningJobs()
    } catch (error) {
      console.error('Job poller error:', error)
    }
  }, 30000)
}