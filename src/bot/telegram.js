import { Telegraf, session } from 'telegraf'
import { Redis } from '@telegraf/session/redis'
import axios from 'axios'
import { prisma } from '../db/prisma.js'
import { getMenuText, getGpuPriceNGN } from '../services/pricing.js'
import { terminateRunPod } from '../providers/runpod.js'
import { terminateVastai } from '../providers/vastai.js'
import { generateReferralCode, applyReferralCode, getReferralStats, REFERRER_BONUS } from '../services/referral.js'
import { detectLanguage, t } from '../services/ux.js'
import { transcribeAudio, transcribeWithOpenAI } from '../services/transcription.js'


const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(id => id.trim()).filter(Boolean)

export async function initTelegramBot(token, redisUrl, gpuQueue) {
  const store = Redis({ url: redisUrl })
  const bot = new Telegraf(token)
  bot.use(session({ store }))

  // ============================================================
  // MIDDLEWARE – User cache
  // ============================================================
  bot.use(async (ctx, next) => {
    try {
      if (!ctx.session) ctx.session = {}
      if (!ctx.session.user && ctx.from) {
        const telegramId = String(ctx.from.id)
        ctx.session.user = await prisma.user.findUnique({ where: { telegramId } })
        // In bot.use middleware, after user cache:
const { checkRateLimit } = await import('../services/rateLimiter.js')
const rateCheck = await checkRateLimit(String(ctx.from.id), 'telegram')
if (!rateCheck.allowed) {
  return ctx.reply(`⏳ Too many requests. Please wait ${rateCheck.resetIn}s.`)
}
      }
      return next()
    } catch (err) {
      console.error('Middleware error:', err)
      await ctx.reply('Something went wrong. Please try again.')
    }
  })

  // ============================================================
  // /start
  // ============================================================
  bot.start(async (ctx) => {
    try {
      let user = ctx.session.user
      if (!user) {
        user = await prisma.user.create({
          data: {
            telegramId: String(ctx.from.id),
            firstName: ctx.from.first_name,
            wallet: { create: { balance: 0 } }
          }
        })
        ctx.session.user = user
      }
      const lang = ctx.session.language || detectLanguage(ctx.message.text || '')
      ctx.session.language = lang
      const menuText = await getMenuText()
      await ctx.reply(`${t(lang, 'welcome')}, ${user.firstName || 'there'}! 🇳🇬\n\n${menuText}`)
    } catch (err) {
      console.error('Start error:', err)
      await ctx.reply('Error starting. Please try again.')
    }
  })

  // ============================================================
  // /cancel
  // ============================================================
  bot.command('cancel', async (ctx) => {
    try {
      ctx.session.selectedGpu = null
      ctx.session.awaitingInferencePrompt = false
      ctx.session.awaitingUploadSmeId = null
      await ctx.reply("Order cancelled. Use /start to begin again.")
    } catch (err) {
      console.error('Cancel error:', err)
    }
  })

  // ============================================================
  // /topup
  // ============================================================
  bot.command('topup', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) return ctx.reply("Please /start first.")

      const amount = 5000

      const response = await axios.post(
        'https://api.paystack.co/transaction/initialize',
        {
          email: `${user.telegramId}@voltcore.africa`,
          amount: amount * 100,
          metadata: { telegramId: user.telegramId, userId: user.id },
          callback_url: `https://t.me/${ctx.botInfo.username}`
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      )

      const { authorization_url, reference } = response.data.data

      await ctx.reply(
        `💳 *Top up your wallet*\n\n` +
        `💰 Amount: ₦${amount.toLocaleString()}\n` +
        `🔖 Reference: ${reference}\n\n` +
        `👉 [Click here to pay](${authorization_url})\n\n` +
        `After payment, your wallet will be credited automatically.`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('Topup error:', err.response?.data || err.message)
      await ctx.reply('Error generating payment link. Please try again.')
    }
  })

  // ============================================================
  // /balance
  // ============================================================
  bot.command('balance', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) return ctx.reply("Please /start first.")

      const wallet = await prisma.creditWallet.findUnique({ where: { userId: user.id } })

      await ctx.reply(
        `💼 *Your wallet balance*\n\n` +
        `💰 ₦${(wallet?.balance || 0).toLocaleString()}\n\n` +
        `Use /topup to add more credits.`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('Balance error:', err)
      await ctx.reply('Error fetching balance. Please try again.')
    }
  })

  // ============================================================
  // /jobs
  // ============================================================
  bot.command('jobs', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) return ctx.reply("Please /start first.")

      const jobs = await prisma.job.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 10
      })

      if (jobs.length === 0) return ctx.reply("📋 You have no jobs yet. Use /start to create one.")

      const list = jobs.map(j => {
        const emoji = j.status === 'completed' ? '✅' :
                      j.status === 'running' ? '🚀' :
                      j.status === 'failed' ? '❌' :
                      j.status === 'provisioning' ? '⏳' : '📋'
        return `${emoji} ${j.id.slice(0, 8)} · ${j.gpuType.toUpperCase()} · ₦${j.totalCostNGN.toLocaleString()} · ${j.status}`
      }).join('\n')

      await ctx.reply(`📋 *Your Recent Jobs*\n\n${list}`, { parse_mode: 'Markdown' })
    } catch (err) {
      console.error('Jobs error:', err)
      await ctx.reply('Error fetching jobs. Please try again.')
    }
  })

  // ============================================================
  // /status <jobId>
  // ============================================================
  bot.command('status', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) return ctx.reply("Please /start first.")

      const args = ctx.message.text.split(' ').slice(1)
      if (args.length === 0) return ctx.reply("Usage: /status <jobId>\n\nUse /jobs to see your job IDs.")

      const job = await prisma.job.findFirst({
        where: { id: { startsWith: args[0] }, userId: user.id }
      })

      if (!job) return ctx.reply(`❌ Job not found: ${args[0]}`)

      const emoji = job.status === 'completed' ? '✅' :
                    job.status === 'running' ? '🚀' :
                    job.status === 'failed' ? '❌' :
                    job.status === 'provisioning' ? '⏳' : '📋'

      await ctx.reply(
        `${emoji} *Job Details*\n\n` +
        `📋 ID: \`${job.id}\`\n` +
        `🖥️ GPU: ${job.gpuType.toUpperCase()}\n` +
        `⏱️ Hours: ${job.requestedHours}\n` +
        `💰 Cost: ₦${job.totalCostNGN.toLocaleString()}\n` +
        `📊 Status: *${job.status}*\n` +
        `${job.retryCount > 0 ? `🔄 Retries: ${job.retryCount}\n` : ''}` +
        `${job.sshDetails ? `🖥️ SSH:\n\`\`\`\n${job.sshDetails}\n\`\`\`\n` : ''}` +
        `📅 Created: ${job.createdAt.toISOString().slice(0, 16).replace('T', ' ')}`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('Status error:', err)
      await ctx.reply('Error fetching job. Please try again.')
    }
  })

  // ============================================================
  // /canceljob <jobId>
  // ============================================================
  bot.command('canceljob', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) return ctx.reply("Please /start first.")

      const args = ctx.message.text.split(' ').slice(1)
      if (args.length === 0) return ctx.reply("Usage: /canceljob <jobId>\n\nUse /activejobs to see running jobs.")

      const job = await prisma.job.findFirst({
        where: {
          id: { startsWith: args[0] },
          userId: user.id,
          status: { in: ['running', 'provisioning', 'pending'] }
        }
      })

      if (!job) return ctx.reply(`❌ No running job found with ID: ${args[0]}`)

      const { handleJobCancellation } = await import('../services/failHandler.js')
      const result = await handleJobCancellation(job.id)

      if (!result.success) return ctx.reply(`❌ ${result.error}`)

      await ctx.reply(
        `✅ *Job Cancelled*\n\n` +
        `📋 Job: ${job.id.slice(0, 8)}\n` +
        `💰 Refunded: ₦${result.refunded.toLocaleString()}\n\n` +
        `Your balance has been restored.`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('Cancel job error:', err)
      await ctx.reply('Error cancelling job. Please try again.')
    }
  })

  // ============================================================
  // /activejobs
  // ============================================================
  bot.command('activejobs', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) return ctx.reply("Please /start first.")

      const jobs = await prisma.job.findMany({
        where: { userId: user.id, status: { in: ['pending', 'provisioning', 'running'] } },
        orderBy: { createdAt: 'desc' }
      })

      if (jobs.length === 0) return ctx.reply("📭 You have no active jobs. Use /start to create one.")

      const limit = user.maxConcurrentJobs || 3
      const list = jobs.map(j => {
        const emoji = j.status === 'running' ? '🚀' : j.status === 'provisioning' ? '⏳' : '📋'
        return `${emoji} ${j.id.slice(0, 8)} · ${j.gpuType.toUpperCase()} · ${j.requestedHours}h · ₦${j.totalCostNGN.toLocaleString()}`
      }).join('\n')

      await ctx.reply(
        `📊 *Active Jobs (${jobs.length}/${limit})*\n\n${list}\n\nUse /canceljob <id> to cancel.`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('Active jobs error:', err)
      await ctx.reply('Error fetching active jobs.')
    }
  })

  // ============================================================
  // /cancelall
  // ============================================================
  bot.command('cancelall', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) return ctx.reply("Please /start first.")

      const activeJobs = await prisma.job.findMany({
        where: { userId: user.id, status: { in: ['pending', 'provisioning', 'running'] } }
      })

      if (activeJobs.length === 0) return ctx.reply("📭 You have no active jobs to cancel.")

      await ctx.reply(`⏳ Cancelling ${activeJobs.length} jobs...`)

      const { handleJobCancellation } = await import('../services/failHandler.js')
      let totalRefunded = 0

      for (const job of activeJobs) {
        const result = await handleJobCancellation(job.id)
        if (result.success) totalRefunded += result.refunded
      }

      await ctx.reply(
        `✅ *All Jobs Cancelled*\n\n` +
        `📋 Cancelled: ${activeJobs.length}\n` +
        `💰 Total refunded: ₦${totalRefunded.toLocaleString()}`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('Cancel all error:', err)
      await ctx.reply('Error cancelling jobs.')
    }
  })

  // ============================================================
  // GPU selection (1, 2, 3)
  // ============================================================
  bot.hears(/^(1|2|3)$/, async (ctx) => {
    try {
      const gpuMap = { 1: "3090", 2: "4090", 3: "a100" }
      const gpuType = gpuMap[ctx.match[1]]
      const price = await getGpuPriceNGN(gpuType)
      ctx.session.selectedGpu = gpuType
      ctx.session.pricePerHour = price
      await ctx.reply(`Selected ${gpuType.toUpperCase()} – ₦${price}/hour.\nHow many hours do you need? (minimum 1)`)
    } catch (err) {
      console.error('Selection error:', err)
      await ctx.reply('Error selecting GPU. Please try again.')
    }
  })

  // ============================================================
  // Hours input – create GPU job
  // ============================================================
  bot.hears(/^\d+(\.\d+)?$/, async (ctx) => {
    try {
      if (!ctx.session.selectedGpu) return ctx.reply("Please select a GPU first using 1, 2, or 3.")
      const hours = parseFloat(ctx.message.text)
      if (hours < 1) return ctx.reply("Minimum 1 hour required.")

      const total = hours * ctx.session.pricePerHour
      const user = ctx.session.user
      if (!user) return ctx.reply("User not found. Please /start again.")

      const { canStartJob } = await import('../services/concurrency.js')
      const concurrency = await canStartJob(user.id)
      if (!concurrency.allowed) {
        return ctx.reply(
          `⚠️ ${concurrency.reason}\n\n` +
          `Active jobs: ${concurrency.currentCount}/${concurrency.limit}\n\n` +
          `Use /activejobs to see them, or /canceljob <id> to cancel one.`
        )
      }

      const wallet = await prisma.creditWallet.findUnique({ where: { userId: user.id } })
      if (!wallet || wallet.balance < total) {
        return ctx.reply(`⚠️ Insufficient balance. You have ₦${wallet?.balance || 0}. Need ₦${total}.\n\nTo top up, reply with: /topup`)
      }

      const job = await prisma.job.create({
        data: {
          userId: user.id,
          gpuType: ctx.session.selectedGpu,
          requestedHours: hours,
          costPerHourNGN: ctx.session.pricePerHour,
          totalCostNGN: total,
          status: "pending",
          jobType: 'gpu'
        }
      })

      await gpuQueue.add('provision-gpu', {
        jobId: job.id,
        gpuType: ctx.session.selectedGpu,
        hours,
        userId: user.id,
        userTelegramId: String(ctx.from.id),
        jobType: 'gpu'
      })

      ctx.session.selectedGpu = null
      await ctx.reply(
        `✅ Job ${job.id} queued!\n\n` +
        `📊 Active jobs: ${concurrency.currentCount + 1}/${concurrency.limit}\n` +
        `⏳ You'll receive SSH details shortly.`
      )
    } catch (err) {
      console.error('Job creation error:', err)
      await ctx.reply('Error creating job. Please try again.')
    }
  })

  // ============================================================
  // /infer
  // ============================================================
  bot.command('infer', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) return ctx.reply("Please /start first.")

      ctx.session.awaitingInferencePrompt = true
      await ctx.reply(
        `🧠 *Micro-GPT Inference*\n\n` +
        `Send me your prompt (question or task), and I'll run it on our Nemotron model.\n\n` +
        `💡 Example: "Summarise this text: ..."\n\n` +
        `Cost: ₦2 per 1,000 tokens.`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('Infer command error:', err)
      await ctx.reply('Error. Please try again.')
    }
  })

  // ============================================================
  // Handle inference prompt
  // ============================================================
  bot.on('text', async (ctx, next) => {
    if (!ctx.session.awaitingInferencePrompt) return next()

    try {
      const user = ctx.session.user
      if (!user) {
        ctx.session.awaitingInferencePrompt = false
        return ctx.reply("Please /start first.")
      }

      const prompt = ctx.message.text
      const wallet = await prisma.creditWallet.findUnique({ where: { userId: user.id } })

      if (!wallet || wallet.balance < 10) {
        ctx.session.awaitingInferencePrompt = false
        return ctx.reply(`⚠️ Insufficient balance. You need at least ₦10 for inference.\n\nTo top up, reply with: /topup`)
      }

      await ctx.reply("⏳ Running inference...")

      const job = await prisma.job.create({
        data: {
          userId: user.id,
          gpuType: '4090',
          requestedHours: 1,
          costPerHourNGN: 0.002,
          totalCostNGN: 0,
          status: "pending",
          jobType: 'inference',
          prompt: prompt
        }
      })

      await gpuQueue.add('provision-gpu', {
        jobId: job.id,
        gpuType: '4090',
        hours: 0.1,
        userId: user.id,
        userTelegramId: String(ctx.from.id),
        jobType: 'inference',
        prompt: prompt
      })

      ctx.session.awaitingInferencePrompt = false
      await ctx.reply(`✅ Inference job ${job.id} queued.\n⏳ You'll receive the response shortly.`)
    } catch (err) {
      console.error('Inference prompt error:', err)
      ctx.session.awaitingInferencePrompt = false
      await ctx.reply('Error running inference. Please try again.')
    }
  })
// ============================================================
// Handle voice notes (Telegram)
// ============================================================
bot.on('voice', async (ctx) => {
  try {
    const user = ctx.session.user
    if (!user) return ctx.reply("Please /start first.")

    const voice = ctx.message.voice
    await ctx.reply('🎤 Transcribing voice note...')

    // Get file link
    const fileLink = await ctx.telegram.getFileLink(voice.file_id)
    const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' })
    const buffer = Buffer.from(response.data)

    // Transcribe
    let transcription = await transcribeAudio(buffer, 'audio/ogg')
    if (!transcription) transcription = await transcribeWithOpenAI(buffer, 'audio/ogg')

    if (!transcription || transcription.trim().length === 0) {
      return ctx.reply('🎤 Could not understand the voice note. Please try again or send text.')
    }

    await ctx.reply(`🎤 Heard: "${transcription}"\n\n⏳ Processing...`)

    // If awaiting inference prompt
    if (ctx.session.awaitingInferencePrompt) {
      ctx.message.text = transcription
      // Re-trigger inference flow
      const wallet = await prisma.creditWallet.findUnique({ where: { userId: user.id } })
      if (!wallet || wallet.balance < 10) {
        ctx.session.awaitingInferencePrompt = false
        return ctx.reply(`⚠️ Insufficient balance. You need at least ₦10 for inference.\n\nTo top up, reply with: /topup`)
      }
      const job = await prisma.job.create({
        data: {
          userId: user.id,
          gpuType: '4090',
          requestedHours: 1,
          costPerHourNGN: 0.002,
          totalCostNGN: 0,
          status: 'pending',
          jobType: 'inference',
          prompt: transcription
        }
      })
      await gpuQueue.add('provision-gpu', {
        jobId: job.id,
        gpuType: '4090',
        hours: 0.1,
        userId: user.id,
        userTelegramId: String(ctx.from.id),
        jobType: 'inference',
        prompt: transcription
      })
      ctx.session.awaitingInferencePrompt = false
      return ctx.reply(`✅ Inference job ${job.id} queued.`)
    }

    // Otherwise, treat as normal text
    const lang = ctx.session.language || 'en'
    const { handleUserMessage } = await import('../services/messageHandler.js')
    const reply = await handleUserMessage(String(ctx.from.id), transcription, gpuQueue, 'telegram', lang)
    if (reply) await ctx.reply(reply)
  } catch (err) {
    console.error('Voice handler error:', err.message)
    await ctx.reply('🎤 Error processing voice note. Please send text.')
  }
})


  // ============================================================
  // /referral
  // ============================================================
  bot.command('referral', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) return ctx.reply("Please /start first.")

      const code = await generateReferralCode(user.id)
      const stats = await getReferralStats(user.id)

      await ctx.reply(
        `🎁 *Your Referral Programme*\n\n` +
        `📌 Your code: \`${code}\`\n\n` +
        `Share this code with friends. When they sign up and spend ₦1,000, you'll earn ₦${REFERRER_BONUS.toLocaleString()}.\n\n` +
        `*Your Stats:*\n` +
        `👥 Total referrals: ${stats.totalReferrals}\n` +
        `✅ Completed: ${stats.completed}\n` +
        `⏳ Pending: ${stats.pending}\n` +
        `💰 Total earned: ₦${stats.totalEarnedNGN.toLocaleString()}`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('Referral error:', err)
      await ctx.reply('Error fetching referral info.')
    }
  })

  // ============================================================
  // /redeem <code>
  // ============================================================
  bot.command('redeem', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) return ctx.reply("Please /start first.")

      const args = ctx.message.text.split(' ').slice(1)
      if (args.length === 0) return ctx.reply("Usage: /redeem <code>\n\nExample: /redeem VCABC123")

      const result = await applyReferralCode(user.id, args[0])

      if (!result.success) return ctx.reply(`❌ ${result.error}`)

      await ctx.reply(
        `✅ *Referral Applied!*\n\n` +
        `💰 You received ₦${result.bonus.toLocaleString()} in credits!\n\n` +
        `Your friend will earn a bonus when you spend ₦1,000.`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('Redeem error:', err)
      await ctx.reply('Error applying referral code.')
    }
  })

  // ============================================================
  // /invoices
  // ============================================================
  bot.command('invoices', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) return ctx.reply("Please /start first.")

      const invoices = await prisma.invoice.findMany({
        where: { userId: user.id },
        orderBy: { issuedAt: 'desc' },
        take: 10
      })

      if (invoices.length === 0) return ctx.reply("📄 You have no invoices yet.")

      const list = invoices.map(inv =>
        `📄 ${inv.number} · ₦${inv.amountNGN.toLocaleString()} · ${inv.status}`
      ).join('\n')

      await ctx.reply(`📄 *Your Invoices*\n\n${list}`, { parse_mode: 'Markdown' })
    } catch (err) {
      console.error('Invoices error:', err)
      await ctx.reply('Error fetching invoices.')
    }
  })

  // ============================================================
  // /language
  // ============================================================
  bot.command('language', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1)

    if (args.length === 0) {
      return ctx.reply(
        `🌍 *Available Languages*\n\n` +
        `/language en – English\n` +
        `/language pcm – Pidgin\n` +
        `/language yo – Yorùbá\n` +
        `/language ha – Hausa\n` +
        `/language ig – Igbo`,
        { parse_mode: 'Markdown' }
      )
    }

    const lang = args[0].toLowerCase()
    const validLangs = ['en', 'pcm', 'yo', 'ha', 'ig']

    if (!validLangs.includes(lang)) {
      return ctx.reply(`❌ Unsupported language: ${lang}\n\nUse /language to see options.`)
    }

    ctx.session.language = lang
    await ctx.reply(`✅ Language set to ${t(lang, 'welcome')}`)
  })

  // ============================================================
  // API KEYS
  // ============================================================
  bot.command('apikeys', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) return ctx.reply("Please /start first.")

      const { listApiKeys } = await import('../services/apiKeys.js')
      const keys = await listApiKeys(user.id)

      if (keys.length === 0) {
        return ctx.reply(`🔑 You have no API keys.\n\nGenerate one with:\n/newkey <name>`)
      }

      const list = keys.map(k =>
        `🔑 ${k.name} · ${k.key.slice(0, 12)}... · last used: ${k.lastUsedAt ? k.lastUsedAt.toISOString().slice(0, 10) : 'never'}`
      ).join('\n')

      await ctx.reply(`🔑 *Your API Keys*\n\n${list}`, { parse_mode: 'Markdown' })
    } catch (err) {
      console.error('API keys error:', err)
      await ctx.reply('Error fetching API keys.')
    }
  })

  bot.command('newkey', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) return ctx.reply("Please /start first.")

      const args = ctx.message.text.split(' ').slice(1)
      const name = args[0] || 'default'

      const { generateApiKey } = await import('../services/apiKeys.js')
      const apiKey = await generateApiKey(user.id, name)

      await ctx.reply(
        `🔑 *API Key Created*\n\n` +
        `📝 Name: ${apiKey.name}\n` +
        `🔑 Key: \`${apiKey.key}\`\n\n` +
        `⚠️ *Save this key now* – you won't see it again.`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('New key error:', err)
      await ctx.reply('Error generating API key.')
    }
  })

  // ============================================================
  // FINE-TUNING
  // ============================================================
  bot.command('finetune', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) return ctx.reply("Please /start first.")

      const args = ctx.message.text.split(' ').slice(1)
      if (args.length < 2) {
        return ctx.reply(
          `Usage: /finetune <model> <dataset_url>\n\n` +
          `Example: /finetune micro-gpt https://example.com/dataset.jsonl\n\n` +
          `Available models: micro-gpt, nemotron-nano, nemotron-super`
        )
      }

      const [modelName, datasetUrl] = args
      const { queueFineTuneJob } = await import('../services/fineTuning.js')
      const job = await queueFineTuneJob(user.id, modelName, datasetUrl, 0)

      await ctx.reply(
        `🎓 *Fine-Tuning Job Queued*\n\n` +
        `📋 Job: ${job.id.slice(0, 8)}\n` +
        `🤖 Model: ${modelName}\n` +
        `📂 Dataset: ${datasetUrl}\n\n` +
        `You'll be notified when training completes.`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('Finetune error:', err)
      await ctx.reply(`Error: ${err.message}`)
    }
  })

  // ============================================================
  // SME COMMANDS
  // ============================================================
  bot.command('sme', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) return ctx.reply("Please /start first.")

      const { getUserSmes } = await import('../services/smeOnboarding.js')
      const smes = await getUserSmes(user.id)

      if (smes.length === 0) {
        return ctx.reply(
          `🏢 *No SMEs yet*\n\n` +
          `Create your first SME:\n` +
          `/newsme <name> [industry]\n\n` +
          `Example: /newsme "Lagos Bites" restaurant`,
          { parse_mode: 'Markdown' }
        )
      }

      const list = smes.map(s =>
        `🏢 *${s.name}* (${s.status})\n` +
        `📂 ${s._count.datasets} datasets · 🤖 ${s._count.customModels} models`
      ).join('\n\n')

      await ctx.reply(
        `🏢 *Your SMEs*\n\n${list}\n\n` +
        `Commands:\n` +
        `/sme <id> – View details\n` +
        `/newsme <name> [industry] – Create SME`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('SME list error:', err)
      await ctx.reply('Error fetching SMEs.')
    }
  })

  bot.command('newsme', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) return ctx.reply("Please /start first.")

      const args = ctx.message.text.split(' ').slice(1)
      if (args.length === 0) {
        return ctx.reply("Usage: /newsme <name> [industry]\n\nExample: /newsme 'Lagos Bites' restaurant")
      }

      let name, industry
      if (args[0].startsWith('"')) {
        const match = args.join(' ').match(/^"([^"]+)"\s*(.*)$/)
        if (match) {
          name = match[1]
          industry = match[2] || null
        }
      } else {
        name = args[0]
        industry = args[1] || null
      }

      const { createSme } = await import('../services/smeOnboarding.js')
      const sme = await createSme(user.id, name, industry)

      await ctx.reply(
        `✅ *SME Created*\n\n` +
        `🏢 ${sme.name}\n` +
        `📊 Industry: ${sme.industry || 'Not specified'}\n` +
        `🆔 ID: \`${sme.id}\`\n\n` +
        `Next: Upload a dataset with /upload <smeId>`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('New SME error:', err)
      await ctx.reply(`Error: ${err.message}`)
    }
  })

  bot.command('upload', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) return ctx.reply("Please /start first.")

      const args = ctx.message.text.split(' ').slice(1)
      if (args.length === 0) {
        return ctx.reply("Usage: /upload <smeId>\n\nThen send the file (CSV/JSONL) as a document.")
      }

      ctx.session.awaitingUploadSmeId = args[0]

      await ctx.reply(
        `📂 *Upload Dataset*\n\n` +
        `SME: ${args[0]}\n\n` +
        `Send your dataset as a file (JSONL or CSV).\n\n` +
        `Requirements:\n` +
        `• At least 10 rows\n` +
        `• JSONL: one JSON object per line\n` +
        `• CSV: with headers`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('Upload error:', err)
      await ctx.reply('Error: ' + err.message)
    }
  })

  bot.on('document', async (ctx) => {
    if (!ctx.session.awaitingUploadSmeId) {
      return ctx.reply("Use /upload <smeId> first.")
    }

    try {
      const smeId = ctx.session.awaitingUploadSmeId
      const doc = ctx.message.document

      if (!doc.file_name.endsWith('.jsonl') && !doc.file_name.endsWith('.csv')) {
        return ctx.reply("❌ Only .jsonl or .csv files are supported.")
      }

      const fileLink = await ctx.telegram.getFileLink(doc.file_id)
      const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' })

      const format = doc.file_name.endsWith('.csv') ? 'csv' : 'jsonl'
      const { saveDataset, validateDataset } = await import('../services/datasetUpload.js')
      const dataset = await saveDataset(smeId, doc.file_name, Buffer.from(response.data), format)

      try {
        await validateDataset(dataset.id)
        await ctx.reply(
          `✅ *Dataset Uploaded*\n\n` +
          `📂 File: ${doc.file_name}\n` +
          `📊 Rows: ${dataset.rowCount}\n` +
          `📦 Size: ${(dataset.fileSize / 1024).toFixed(2)} KB\n` +
          `🔖 ID: \`${dataset.id}\`\n\n` +
          `Now create a custom model:\n` +
          `/train <smeId> ${dataset.id}`,
          { parse_mode: 'Markdown' }
        )
      } catch (err) {
        await ctx.reply(`⚠️ Dataset uploaded but validation failed: ${err.message}`)
      }

      ctx.session.awaitingUploadSmeId = null
    } catch (err) {
      console.error('Document handler error:', err)
      ctx.session.awaitingUploadSmeId = null
      await ctx.reply('Error processing document.')
    }
  })

  bot.command('train', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) return ctx.reply("Please /start first.")

      const args = ctx.message.text.split(' ').slice(1)
      if (args.length < 2) {
        return ctx.reply("Usage: /train <smeId> <datasetId> [baseModel]")
      }

      const [smeId, datasetId, baseModel = 'micro-gpt'] = args

      const { createCustomModel } = await import('../services/customModel.js')
      const model = await createCustomModel(smeId, baseModel, 'custom', datasetId)

      await ctx.reply(
        `🎨 *Custom Model Training Started*\n\n` +
        `🏢 SME: ${smeId}\n` +
        `🤖 Base model: ${baseModel}\n` +
        `📊 Version: ${model.version}\n` +
        `📋 Job: ${model.fineTuneJobId.slice(0, 8)}\n\n` +
        `Training takes 20-60 minutes. You'll be notified when ready.`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('Train error:', err)
      await ctx.reply(`Error: ${err.message}`)
    }
  })

  bot.command('models', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) return ctx.reply("Please /start first.")

      const args = ctx.message.text.split(' ').slice(1)
      if (args.length === 0) return ctx.reply("Usage: /models <smeId>")

      const { getSmeCustomModels } = await import('../services/customModel.js')
      const models = await getSmeCustomModels(args[0])

      if (models.length === 0) return ctx.reply(`No custom models found for SME ${args[0]}.`)

      const list = models.map(m => {
        const emoji = m.status === 'ready' ? '✅' : m.status === 'training' ? '⏳' : m.status === 'failed' ? '❌' : '📋'
        return `${emoji} v${m.version} · ${m.displayName} · ${m.status}`
      }).join('\n