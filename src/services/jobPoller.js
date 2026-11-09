import { prisma } from '../db/prisma.js'
import { getRunPodStatus } from '../providers/runpod.js'
import { getVastaiStatus } from '../providers/vastai.js'

/**
 * Poll all running jobs and update their status
 */
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

      // Update job status
      if (status === 'RUNNING' || status === 'running') {
        // Still running – update lastChecked
        await prisma.job.update({
          where: { id: job.id },
          data: { startedAt: job.startedAt || new Date() }
        })
      } else if (status === 'EXITED' || status === 'stopped' || status === 'failed') {
        // Job terminated externally – complete it
        await prisma.job.update({
          where: { id: job.id },
          data: {
            status: 'completed',
            completedAt: new Date()
          }
        })

        // Deduct credits
        const cost = job.requestedHours * job.costPerHourNGN
        await prisma.creditWallet.update({
          where: { userId: job.userId },
          data: { balance: { decrement: cost } }
        })

        console.log(`✅ Job ${job.id} completed. Deducted ₦${cost}`)
      }
    } catch (error) {
      console.error(`Job ${job.id} polling error:`, error.message)
    }
  }
}

/**
 * Start polling every 30 seconds
 */
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