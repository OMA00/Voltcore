import 'dotenv/config'
import express from 'express'
import crypto from 'crypto'
import { initTelegramBot } from './bot/telegram.js'
import { prisma } from './db/prisma.js'
import { Queue, Worker } from 'bullmq'
import { provisionRunPod, getRunPodStatus, terminateRunPod } from './providers/runpod.js'
import { provisionVastai, getVastaiStatus, terminateVastai } from './providers/vastai.js'
import { getCheapestProvider } from './providers/provider.router.js'
import { startJobPoller } from './services/jobPoller.js'
import inferenceRouter from './routes/inference.js'

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

// Inference routes
app.use('/api/inference', inferenceRouter)

// --- Paystack Webhook ---
function verifyPaystackSignature(req) {
  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(JSON.stringify(req.body))
    .digest('hex')
  return hash === req.headers['x-paystack-signature']
}

app.post('/webhook/paystack', async (req, res) => {
  if (!verifyPaystackSignature(req)) {
    console.error('Invalid Paystack signature')
    return res.sendStatus(401)
  }

  const event = req.body
  console.log('Paystack webhook:', event.event)

  if (event.event === 'charge.success') {
    const { metadata, amount, reference } = event.data
    const telegramId = metadata?.telegramId
    if (!telegramId) return res.sendStatus(200)

    try {
      const user = await prisma.user.findUnique({ where: { telegramId } })
      if (!user) return res.sendStatus(200)

      const nairaAmount = amount / 100
      await prisma.creditWallet.update({
        where: { userId: user.id },
        data: { balance: { increment: nairaAmount } }
      })

      console.log(`💰 ${telegramId} +₦${nairaAmount}`)

      // Notify user
      try {
        const bot = await initTelegramBot(process.env.TELEGRAM_BOT_TOKEN, process.env.REDIS_URL, gpuQueue)
        await bot.telegram.sendMessage(telegramId,
          `✅ *Payment received!*\n💰 ₦${nairaAmount.toLocaleString()}\n🔖 Ref: ${reference}`,
          { parse_mode: 'Markdown' }
        )
      } catch (e) {
        console.error('Notify failed:', e.message)
      }

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
  console.log(`🚀 Job ${job.id}:`, job.name)

  const { jobId, gpuType, hours, userId, userTelegramId, jobType, prompt } = job.data

  try {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'provisioning' }
    })

    if (jobType === 'inference') {
      // Inference job
      const { deployInferencePod } = await import('./services/inference.js')
      const result = await deployInferencePod('nemotron-nano', gpuType)

      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'running',
          providerJobId: result.id,
          endpoint: result.endpoint,
          prompt: prompt,
          startedAt: new Date()
        }
      })

      // Run inference
      const { runInference, deductInferenceCredits } = await import('./services/inference.js')
      const inferenceResult = await runInference(result.endpoint, prompt)
      await deductInferenceCredits(userId, inferenceResult.tokens)

      // Update job
      await prisma.job.update({
        where: { id: jobId },
        data: { status: 'completed', completedAt: new Date() }
      })

      // Notify user
      const bot = await initTelegramBot(process.env.TELEGRAM_BOT_TOKEN, process.env.REDIS_URL, gpuQueue)
      await bot.telegram.sendMessage(userTelegramId,
        `🧠 *Inference Result*\n\n${inferenceResult.text}\n\n` +
        `📊 Tokens: ${inferenceResult.tokens}\n` +
        `💰 Cost: ₦${(inferenceResult.tokens * 0.002).toFixed(2)}`,
        { parse_mode: 'Markdown' }
      )

      return { success: true }
    }

    // GPU job – cheapest provider
    const provider = await getCheapestProvider(gpuType)
    console.log(`📡 Using: ${provider.name}`)

    let result
    if (provider.name === 'runpod') {
      result = await provisionRunPod(gpuType, hours)
    } else {
      result = await provisionVastai(gpuType, hours)
    }

    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'running',
        providerJobId: result.id,
        providerName: provider.name,
        sshDetails: result.sshDetails,
        startedAt: new Date()
      }
    })

    // Schedule usage metering
    await gpuQueue.add('meter-usage', {
      jobId, hours, userId,
      providerJobId: result.id,
      providerName: provider.name
    }, {
      delay: hours * 60 * 60 * 1000
    })

    // Notify user
    const bot = await initTelegramBot(process.env.TELEGRAM_BOT_TOKEN, process.env.REDIS_URL, gpuQueue)
    await bot.telegram.sendMessage(userTelegramId,
      `✅ *GPU Ready!*\n\n` +
      `🔗 Provider: ${provider.name.toUpperCase()}\n` +
      `🖥️ SSH:\n\`\`\`\n${result.sshDetails}\n\`\`\`\n` +
      `⏱️ ${hours} hours\n` +
      `📋 Job: ${jobId}`,
      { parse_mode: 'Markdown' }
    )

    return { success: true }
  } catch (err) {
    console.error(`❌ Job ${jobId} failed:`, err)
    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'failed' }
    })
    throw err
  }
}, {
  connection: { url: process.env.REDIS_URL },
  concurrency: 10
})

// --- Usage Metering Worker ---
const meterWorker = new Worker('gpu-provisioning', async (job) => {
  if (job.name !== 'meter-usage') return

  const { jobId, hours, userId, providerJobId, providerName } = job.data

  try {
    const jobRecord = await prisma.job.findUnique({ where: { id: jobId } })
    if (!jobRecord) return

    let status
    if (providerName === 'runpod') {
      status = await getRunPodStatus(providerJobId)
    } else {
      status = await getVastaiStatus(providerJobId)
    }

    // Terminate if still running
    if (status === 'RUNNING' || status === 'running') {
      if (providerName === 'runpod') {
        await terminateRunPod(providerJobId)
      } else {
        await terminateVastai(providerJobId)
      }
    }

    // Deduct credits
    const totalCost = hours * jobRecord.costPerHourNGN
    await prisma.$transaction([
      prisma.creditWallet.update({
        where: { userId },
        data: { balance: { decrement: totalCost } }
      }),
      prisma.job.update({
        where: { id: jobId },
        data: { status: 'completed', completedAt: new Date() }
      })
    ])

    console.log(`💳 Deducted ₦${totalCost} for job ${jobId}`)
  } catch (err) {
    console.error('Metering error:', err)
  }
}, {
  connection: { url: process.env.REDIS_URL }
})

// --- Start Bot ---
let bot
try {
  bot = await initTelegramBot(process.env.TELEGRAM_BOT_TOKEN, process.env.REDIS_URL, gpuQueue)
  await bot.launch()
  console.log("VoltCore bot active.")
} catch (err) {
  console.error('Bot start failed:', err)
  process.exit(1)
}

// Start job poller
startJobPoller()

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`VoltCore server on port ${PORT}`))

// Graceful shutdown
const shutdown = async () => {
  console.log("Shutting down...")
  await worker.close()
  await meterWorker.close()
  await gpuQueue.close()
  await bot?.stop()
  await prisma.$disconnect()
  process.exit(0)
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)