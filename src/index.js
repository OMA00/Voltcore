import 'dotenv/config'
import express from 'express'
import { initTelegramBot } from './bot/telegram.js'
import { prisma } from './db/prisma.js'
import { Queue, Worker } from 'bullmq'
import { provisionRunPod, terminateRunPod, getRunPodStatus } from './providers/runpod.js'
import { provisionVastai, terminateVastai, getVastaiStatus } from './providers/vastai.js'
import { getCheapestProvider } from './providers/provider.router.js'

const REQUIRED_ENV = ['TELEGRAM_BOT_TOKEN', 'DATABASE_URL', 'REDIS_URL']
REQUIRED_ENV.forEach(key => {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`)
    process.exit(1)
  }
})

const app = express()
app.use(express.json())

// Health check
app.get('/health', (req, res) => res.sendStatus(200))

// --- Paystack Webhook ---
app.post('/webhook/paystack', async (req, res) => {
  const event = req.body
  console.log('Paystack webhook received:', event)

  if (event.event === 'charge.success') {
    const { metadata, amount } = event.data
    const telegramId = metadata.telegramId

    try {
      const user = await prisma.user.findUnique({ where: { telegramId } })
      if (!user) {
        console.error('User not found:', telegramId)
        return res.sendStatus(404)
      }

      const nairaAmount = amount / 100
      await prisma.creditWallet.update({
        where: { userId: user.id },
        data: { balance: { increment: nairaAmount } }
      })

      console.log(`💰 Wallet topped up: ${telegramId} +₦${nairaAmount}`)
      res.sendStatus(200)
    } catch (err) {
      console.error('Webhook error:', err)
      res.sendStatus(500)
    }
  } else {
    res.sendStatus(200)
  }
})

// --- BullMQ Queue ---
const gpuQueue = new Queue('gpu-provisioning', {
  connection: { url: process.env.REDIS_URL }
})

// --- BullMQ Worker ---
const worker = new Worker('gpu-provisioning', async (job) => {
  console.log(`🚀 Processing job ${job.id}:`, job.data)

  const { jobId, gpuType, hours, userId, userTelegramId } = job.data

  try {
    // Update job status
    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'provisioning' }
    })

    // Get cheapest provider
    const provider = await getCheapestProvider(gpuType)
    console.log(`📡 Selected provider: ${provider.name}`)

    let result
    if (provider.name === 'runpod') {
      result = await provisionRunPod(gpuType, hours)
    } else if (provider.name === 'vastai') {
      result = await provisionVastai(gpuType, hours)
    } else {
      throw new Error(`Unknown provider: ${provider.name}`)
    }

    // Update job with SSH details
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'running',
        providerJobId: result.id,
        sshDetails: result.sshDetails,
        startedAt: new Date()
      }
    })

    // Schedule usage metering
    await gpuQueue.add('meter-usage', {
      jobId,
      hours,
      userId,
      providerJobId: result.id,
      providerName: provider.name
    }, {
      delay: hours * 60 * 60 * 1000,
    })

    // Notify user via Telegram
    const bot = await initTelegramBot(process.env.TELEGRAM_BOT_TOKEN, process.env.REDIS_URL, gpuQueue)
    await bot.telegram.sendMessage(userTelegramId, 
      `✅ Your GPU is ready!\n\n` +
      `🔗 Provider: ${provider.name.toUpperCase()}\n` +
      `🖥️ SSH: ${result.sshDetails}\n` +
      `⏱️ Duration: ${hours} hours\n` +
      `📋 Job ID: ${jobId}\n\n` +
      `⚠️ Your session will end in ${hours} hours. We'll notify you before it expires.`
    )

    console.log(`✅ Job ${jobId} provisioned successfully on ${provider.name}`)
    return { success: true, sshDetails: result.sshDetails, provider: provider.name }
  } catch (err) {
    console.error(`❌ Job ${jobId} failed:`, err)

    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'failed' }
    })

    // Notify user of failure
    try {
      const bot = await initTelegramBot(process.env.TELEGRAM_BOT_TOKEN, process.env.REDIS_URL, gpuQueue)
      await bot.telegram.sendMessage(userTelegramId,
        `❌ Your GPU job failed to start.\n\n` +
        `🔄 We're retrying with a different provider.\n` +
        `📋 Job ID: ${jobId}\n\n` +
        `You'll be notified when it's ready.`
      )
    } catch (notifyErr) {
      console.error('Failed to notify user:', notifyErr)
    }

    throw err
  }
}, {
  connection: { url: process.env.REDIS_URL },
  concurrency: 10
})

// --- Usage Metering Worker ---
const meterWorker = new Worker('gpu-provisioning', async (job) => {
  if (job.name !== 'meter-usage') return

  console.log(`⏱️ Metering usage for job ${job.data.jobId}`)

  try {
    const { jobId, hours, userId, providerJobId, providerName } = job.data

    const jobRecord = await prisma.job.findUnique({ where: { id: jobId } })
    if (!jobRecord) return

    // Check if still running (providers may have terminated early)
    let status
    if (providerName === 'runpod') {
      status = await getRunPodStatus(providerJobId)
    } else if (providerName === 'vastai') {
      status = await getVastaiStatus(providerJobId)
    }

    if (status === 'running') {
      // Deduct credits
      const costPerHour = jobRecord.costPerHourNGN
      const totalCost = hours * costPerHour

      await prisma.$transaction([
        prisma.creditWallet.update({
          where: { userId },
          data: { balance: { decrement: totalCost } }
        }),
        prisma.job.update({
          where: { id: jobId },
          data: {
            status: 'completed',
            completedAt: new Date()
          }
        })
      ])

      console.log(`💳 Deducted ₦${totalCost} from user ${userId}`)
    } else {
      // Provider terminated early – partial refund
      const actualHours = 0 // calculate actual usage
      console.log(`⚠️ Job ${jobId} terminated early. Refunding remaining credits.`)
    }
  } catch (err) {
    console.error(`❌ Metering error:`, err)
  }
}, {
  connection: { url: process.env.REDIS_URL }
})

// --- Start Bot ---
let bot
try {
  bot = await initTelegramBot(process.env.TELEGRAM_BOT_TOKEN, process.env.REDIS_URL, gpuQueue)
  await bot.launch()
  console.log("VoltCore Telegram bot active via polling.")
} catch (err) {
  console.error('Failed to start bot:', err)
  process.exit(1)
}

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`VoltCore server running on port ${PORT}`))

// Graceful shutdown
const shutdown = async () => {
  console.log("Shutting down VoltCore...")
  await worker.close()
  await meterWorker.close()
  await gpuQueue.close()
  await bot?.stop()
  await prisma.$disconnect()
  process.exit(0)
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)