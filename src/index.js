import 'dotenv/config'
import express from 'express'
import crypto from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import { initTelegramBot } from './bot/telegram.js'
import { initWhatsAppBot } from './bot/whatsapp.js'
import { prisma } from './db/prisma.js'
import { createBullConnection } from './db/redis.js'
import { Queue, Worker } from 'bullmq'
import { startJobPoller } from './services/jobPoller.js'
import { handleProvisionJob, handleMeterJob } from './services/gpujobs.js'
import { sendToUser } from './services/messenger.js'
import { acquireBotLock } from './services/botlock.js'
import inferenceRouter from './routes/inference.js'
import adminRouter from './routes/admin.js'
// TODO(gap): fx.js, reconciliation.js and healthCheck.js were imported here but have never
// existed in any commit. Disabled until they are written (Day 23 audit, gap list).
// import { startFxRefreshJob } from './services/fx.js'
// import { startNightlyReconciliation } from './services/reconciliation.js'
// import { startHealthChecks } from './services/healthCheck.js'
import { startCreditExpiryJob } from './services/creditExpiry.js'
import { startTopupReminders } from './services/topupReminder.js'
import keysRouter from './routes/keys.js'
import { seedModels } from './services/modelRegistry.js'
import smeInferenceRouter from './routes/smeInference.js'
import { cleanupSessions } from './services/sessionStore.js'
import apiV1Router from './routes/apiV1.js'
import docsRouter from './routes/doc.js'
import { metricsMiddleware } from './middleware/metrics.js'
import { logger } from './services/logger.js'
import {
  getMetrics,
  getMetricsContentType,
  jobsTotal,
  jobDuration,
  activeJobs,
  inferenceRequests,
  inferenceTokens,
  revenueTotal
} from './services/metrics.js'
// TODO(gap): alerting.js has been an empty file since Day 18 (a7c47d2), so it exports nothing.
// import { alertDeadLetterJob } from './services/alerting.js'
import cookieParser from 'cookie-parser'
import authRouter from './routes/auth.js'
import userRouter from './routes/user.js'
import coursesRouter from './routes/courses.js'
import { seedCourses } from './services/courseSeed.js' 
import growthRouter from './routes/growth.js'
import { startGrowthTracking } from './services/growth.js'
import { notifyJobComplete } from './services/notifications.js'
import paystackRouter from './routes/paystack.js'
import walletRouter from './routes/wallet.js'
import notificationsRouter from './routes/notification.js'



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
app.use(metricsMiddleware)
app.use(express.static(path.join(__dirname, 'public')))

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => res.sendStatus(200))

// ============================================================
// COOKIE PARSER
//=============================================================
app.use(cookieParser())

// ============================================================
// API ROUTES
// ============================================================
app.use('/api/inference', inferenceRouter)
app.use('/api/admin', adminRouter)
app.use('/api/keys', keysRouter)
app.use('/api/sme', smeInferenceRouter)
app.use('/api/v1', apiV1Router)
app.use('/api/docs', docsRouter)
app.use('/api/auth', authRouter)
app.use('/api/user', userRouter)
app.use('/api/courses', coursesRouter)
app.use('/api/growth', growthRouter)
app.use('/api/notifications', notificationsRouter)
app.use('/webhook', paystackRouter)
app.use('/api/wallet', walletRouter)



// ============================================================
// DEVELOPER PORTAL
// ============================================================
app.get('/developers', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'developers.html'))
})

// ============================================================
// ADMIN DASHBOARD
// ============================================================
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
})

// ============================================================
// METRICS ENDPOINT
// ============================================================
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', getMetricsContentType())
    res.send(await getMetrics())
  } catch (err) {
    res.status(500).send(err.message)
  }
})
//===============================================================
// LANDING PAGE ROUTE
//===============================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'))
})


app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'))
})

app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signup.html'))
})

app.get('/school', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'school.html'))
})

app.get('/learn', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'learn.html'))
})

app.get('/ambassador', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ambassador.html'))
})

app.get('/leaderboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'leaderboard.html'))
})

await seedCourses()

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================
app.use((err, req, res, next) => {
  const requestLog = logger.child({ path: req.path, method: req.method })
  requestLog.error('Unhandled API error', { error: err.message, stack: err.stack })

  res.status(500).json({
    error: 'Internal server error',
    correlationId: requestLog.correlationId
  })
})

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) })
})

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack })
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
// TODO(gate-4 money path): a job_debit ledger row was pasted here at module top level, where
// userId/jobId/totalCost do not exist, so it crashed on import. It belongs in the job charge
// step, which is being redesigned (hold at creation, charge on completion). Removed for now.
// A "payment received" notify was also pasted here; routes/paystack.js already sends it.

// ============================================================
// BULLMQ QUEUE
// ============================================================
const gpuQueue = new Queue('gpu-provisioning', {
  connection: createBullConnection()
})

// ============================================================
// BULLMQ WORKER – one worker for the queue, routed by job name
// ------------------------------------------------------------
// There used to be two Workers on this one queue. BullMQ hands each job to whichever
// worker is free, so a 'provision-gpu' job taken by the metering worker was marked done
// without provisioning, and a 'meter-usage' job taken by the main worker ran the
// provisioning path again. One worker now dispatches by name.
// ============================================================
const worker = new Worker('gpu-provisioning', async (job) => {
  console.log(`🚀 Queue job ${job.id}: ${job.name}`)

  if (job.name === 'meter-usage') {
    return handleMeterJob(job.data, gpuQueue, job.data.attempt || 0)
  }

  if (job.name === 'provision-gpu' && job.data.jobType !== 'inference') {
    return handleProvisionJob(job.data, gpuQueue)
  }

  // --------------------------------------------------------
  // INFERENCE JOB (unchanged behaviour; billed per token after the run)
  // --------------------------------------------------------
  const { jobId, gpuType, userId, userTelegramId, prompt } = job.data
  try {
    await prisma.job.update({ where: { id: jobId }, data: { status: 'provisioning' } })
    const { deployInferencePod, runInference, deductInferenceCredits } = await import('./services/inference.js')

    const result = await deployInferencePod('nemotron-nano', gpuType)
    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'running', providerJobId: result.id, endpoint: result.endpoint, prompt, startedAt: new Date() }
    })

    const inferenceResult = await runInference(result.endpoint, prompt)
    await deductInferenceCredits(userId, inferenceResult.tokens, `infer_${jobId}`)

    await prisma.job.update({ where: { id: jobId }, data: { status: 'completed', completedAt: new Date() } })

    inferenceRequests.inc({ model: 'nemotron-nano', source: 'telegram', status: 'success' })
    inferenceTokens.inc({ model: 'nemotron-nano', source: 'telegram' }, inferenceResult.tokens)
    revenueTotal.inc({ source: 'inference' }, inferenceResult.tokens * 0.002)

    await sendToUser(userId,
      `🧠 *Inference Result*\n\n${inferenceResult.text}\n\n` +
      `📊 Tokens: ${inferenceResult.tokens}\n` +
      `💰 Cost: ₦${(inferenceResult.tokens * 0.002).toFixed(2)}`
    )
    return { success: true }
  } catch (err) {
    console.error(`❌ Inference job ${jobId} failed:`, err)
    await prisma.job.updateMany({ where: { id: jobId, status: { in: ['provisioning', 'running'] } }, data: { status: 'failed', lastError: err.message, failedAt: new Date() } })
    throw err
  }
}, {
  connection: createBullConnection(),
  concurrency: 10
})


// ============================================================
// START TELEGRAM BOT
// ============================================================
// bot.launch() in Telegraf 4.16 resolves only when polling STOPS, so awaiting it blocked
// everything below (job poller, app.listen) forever. The onLaunch callback runs once the
// bot is connected; a rejected launch (bad token, network) still exits the process.
// Only one instance may poll Telegram (see services/botlock.js). Waiting for the lock
// happens in the background so the HTTP server and health check start immediately.
let bot
let releaseBotLock = null
try {
  bot = await initTelegramBot(process.env.TELEGRAM_BOT_TOKEN, process.env.REDIS_URL, gpuQueue)
  acquireBotLock()
    .then(release => {
      releaseBotLock = release
      return bot.launch(() => console.log("✅ VoltCore Telegram bot active."))
    })
    .catch(err => {
      console.error('Telegram bot stopped with an error:', err)
      process.exit(1)
    })
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
startJobPoller(gpuQueue)

// Session cleanup every hour
setInterval(async () => {
  try {
    const cleaned = await cleanupSessions()
    if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} sessions`)
  } catch (err) {
    console.error('Session cleanup error:', err.message)
  }
}, 60 * 60 * 1000)

// ============================================================
// BACKGROUND JOB HEALTH TRACKING
// ============================================================
const jobHealth = {
  worker: { lastRun: null, errors: 0 },
  jobPoller: { lastRun: null, errors: 0 }
}

worker.on('completed', () => { jobHealth.worker.lastRun = new Date() })
worker.on('failed', (job, err) => {
  jobHealth.worker.errors++
  console.error(`Queue job ${job?.id} (${job?.name}) failed: ${err?.message}`)
})
worker.on('error', err => console.error('Queue worker error:', err.message))

app.get('/health/jobs', (req, res) => res.json(jobHealth))

// ============================================================
// EXPRESS SERVER
// ============================================================
const PORT = process.env.PORT || 3000

startCreditExpiryJob()
startTopupReminders()
// TODO(gap): modules never written; see imports at the top of this file.
// startFxRefreshJob()
// startNightlyReconciliation()
// startHealthChecks()
startGrowthTracking()

app.listen(PORT, () => {
  console.log(`VoltCore server on port ${PORT}`)
  console.log(`Admin dashboard: http://localhost:${PORT}/admin`)
})

// Seed default models
await seedModels()

// ============================================================
// EXPORT QUEUE (for admin routes & poller)
// ============================================================
export { gpuQueue }



// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
const shutdown = async () => {
  console.log("Shutting down...")
  await worker.close()
  await gpuQueue.close()
  try { bot?.stop() } catch {}
  await releaseBotLock?.()
  await prisma.$disconnect()
  process.exit(0)
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)