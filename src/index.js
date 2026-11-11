import 'dotenv/config'
import express from 'express'
import crypto from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import { initTelegramBot } from './bot/telegram.js'
import { initWhatsAppBot } from './bot/whatsapp.js'
import { prisma } from './db/prisma.js'
import { Queue, Worker } from 'bullmq'
import { provisionRunPod, getRunPodStatus, terminateRunPod } from './providers/runpod.js'
import { provisionVastai, getVastaiStatus, terminateVastai } from './providers/vastai.js'
import { getCheapestProvider } from './providers/provider.router.js'
import { startJobPoller } from './services/jobPoller.js'
import { handleJobFailure } from './services/failHandler.js'
import inferenceRouter from './routes/inference.js'
import adminRouter from './routes/admin.js'
import { startFxRefreshJob } from './services/fx.js'
import { startNightlyReconciliation } from './services/reconciliation.js'
import { startHealthChecks } from './services/healthCheck.js'
import { startCreditExpiryJob } from './services/creditExpiry.js'
import { startTopupReminders } from './services/topupReminder.js'
import keysRouter from './routes/keys.js'
import { seedModels } from './services/modelRegistry.js'
import smeInferenceRouter from './routes/smeInference.js'

// ============================================================
// ESM PATH SETUP
// ============================================================
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ============================================================
// ENVIRONMENT VALIDATION
// ============================================================
const REQUIRED_ENV = ['TELEGRAM_BOT_TOKEN', 'DATABASE_URL', 'REDIS_URL']
REQUIRED_ENV.forEach(key => {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`)
    process.exit(1)
  }
})

// ============================================================
// EXPRESS APP
// ============================================================
const app = express()
app.use(express.json())

// Serve static files (admin dashboard)
app.use(express.static(path.join(__dirname, 'public')))

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => res.sendStatus(200))

// ============================================================
// API ROUTES
// ============================================================
app.use('/api/inference', inferenceRouter)
app.use('/api/admin', adminRouter)
app.use('/api/keys', keysRouter)
app.use('/api/sme', smeInferenceRouter) 

// ============================================================
// ADMIN DASHBOARD (HTML)
// ============================================================
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
})

// ============================================================
// PAYSTACK WEBHOOK
// ============================================================
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

// ============================================================
// BULLMQ QUEUE
// ============================================================
const gpuQueue = new Queue('gpu-provisioning', {
  connection: { url: process.env.REDIS_URL }
})

// ============================================================
// BULLMQ WORKER – GPU + INFERENCE
// ============================================================
const worker = new Worker('gpu-provisioning', async (job) => {
  console.log(`🚀 Job ${job.id}:`, job.name)

  const { jobId, gpuType, hours, userId, userTelegramId, jobType, prompt } = job.data

  try {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'provisioning' }
    })

    // --------------------------------------------------------
    // INFERENCE JOB
    // --------------------------------------------------------
    if (jobType === 'inference') {
      const { deployInferencePod, runInference, deductInferenceCredits } = await import('./services/inference.js')

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

      const inferenceResult = await runInference(result.endpoint, prompt)
      await deductInferenceCredits(userId, inferenceResult.tokens)

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

    // --------------------------------------------------------
    // GPU PROVISIONING JOB
    // --------------------------------------------------------
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
   const { action, retryDelay, classification } = await handleJobFailure(
    jobId,
    err,
    job.data.providerName || 'unknown'
  )

  if (action === 'retry') {
    // Schedule retry with backoff
    console.log(`🔄 Retrying job ${jobId} in ${retryDelay}ms`)
    await gpuQueue.add('provision-gpu', { ...job.data }, { delay: retryDelay })
  } else if (action === 'dlq') {
    console.log(`💀 Job ${jobId} moved to dead-letter queue`)
    // No retry – refund already issued
  }

    throw err
  }
}, {
  connection: { url: process.env.REDIS_URL },
  concurrency: 10
})

// ============================================================
// USAGE METERING WORKER
// ============================================================
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

// ============================================================
// START TELEGRAM BOT
// ============================================================
let bot
try {
  bot = await initTelegramBot(process.env.TELEGRAM_BOT_TOKEN, process.env.REDIS_URL, gpuQueue)
  await bot.launch()
  console.log("✅ VoltCore Telegram bot active.")
} catch (err) {
  console.error('Telegram bot start failed:', err)
  process.exit(1)
}

// ============================================================
// START WHATSAPP BOT (OPTIONAL)
// ============================================================
if (process.env.WHATSAPP_ENABLED === 'true') {
  try {
    await initWhatsAppBot(gpuQueue)
    console.log("✅ WhatsApp bot initializing...")
  } catch (err) {
    console.warn("⚠️ WhatsApp bot failed to start:", err.message)
  }
} else {
  console.log("ℹ️ WhatsApp bot disabled (set WHATSAPP_ENABLED=true to enable)")
}

// ============================================================
// START JOB POLLER
// ============================================================
startJobPoller()

// ============================================================
// EXPRESS SERVER
// ============================================================
const PORT = process.env.PORT || 3000
// Start background jobs
startCreditExpiryJob()
startTopupReminders()
startFxRefreshJob()
startNightlyReconciliation()
startHealthChecks()
app.listen(PORT, () => {
  console.log(`VoltCore server on port ${PORT}`)
  console.log(`Admin dashboard: http://localhost:${PORT}/admin`)
})

// Seed default models
await seedModels()

// At the bottom of index.js (before shutdown)
export { gpuQueue }
// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
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