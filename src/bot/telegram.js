import { Telegraf, session } from 'telegraf'
import { Redis } from '@telegraf/session/redis'
import axios from 'axios'
import { prisma } from '../db/prisma.js'
import { getMenuText, getGpuPriceNGN } from '../services/pricing.js'
import { terminateRunPod } from '../providers/runpod.js'
import { terminateVastai } from '../providers/vastai.js'
import { generateReferralCode, applyReferralCode, getReferralStats, REFERRER_BONUS } from '../services/referral.js'
import { detectLanguage, t } from '../services/ux.js'

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
  // /jobs – Recent jobs
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

      const jobId = args[0]
      const job = await prisma.job.findFirst({
        where: { id: { startsWith: jobId }, userId: user.id }
      })

      if (!job) return ctx.reply(`❌ Job not found: ${jobId}`)

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

      const jobId = args[0]
      const job = await prisma.job.findFirst({
        where: { id: { startsWith: jobId }, userId: user.id, status: { in: ['running', 'provisioning', 'pending'] } }
      })

      if (!job) return ctx.reply(`❌ No running job found with ID: ${jobId}`)

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
  // /activejobs – View active jobs (Day 11)
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
        `📊 *Active Jobs (${jobs.length}/${limit})*\n\n${list}\n\n` +
        `Use /canceljob <id> to cancel a specific job.`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('Active jobs error:', err)
      await ctx.reply('Error fetching active jobs.')
    }
  })

  // ============================================================
  // /cancelall – Cancel all active jobs (Day 11)
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

      // Concurrency check
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
      const activeCount = concurrency.currentCount + 1
      await ctx.reply(
        `✅ Job ${job.id} queued!\n\n` +
        `📊 Active jobs: ${activeCount}/${concurrency.limit}\n` +
        `⏳ You'll receive SSH details shortly.`
      )
    } catch (err) {
      console.error('Job creation error:', err)
      await ctx.reply('Error creating job. Please try again.')
    }
  })

  // ============================================================
  // /infer – Micro-GPT inference
  // ============================================================
  bot.command('infer', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) return ctx.reply("Please /start first.")

      ctx.session.awaitingInferencePrompt = true
      await ctx.reply(
        `🧠 *Micro-GPT Inference*\n\n` +
        `Send me your prompt (question or task), and I'll run it on our Nemotron model.\n\n` +
        `💡 Example: "Summarise this text: ..." or "Write a product description for a Lagos restaurant."\n\n` +
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

      await ctx.reply("⏳ Running inference... (this may take a few seconds)")

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

      const code = args[0]
      const result = await applyReferralCode(user.id, code)

      if (!result.success) return ctx.reply(`❌ ${result.error}`)

      await ctx.reply(
        `✅ *Referral Applied!*\n\n` +
        `💰 You received ₦${result.bonus.toLocaleString()} in credits!\n\n` +
        `Your friend will earn a bonus when you spend ₦1,000 on VoltCore.`,
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
      return ctx.reply(`❌ Unsupported language: ${lang}\n\nUse /language to see available options.`)
    }

    ctx.session.language = lang
    await ctx.reply(`✅ Language set to ${t(lang, 'welcome')}`)
  })

  // ============================================================
  // /help
  // ============================================================
  bot.command('help', async (ctx) => {
    await ctx.reply(
      `🧠 *VoltCore Commands*\n\n` +
      `*User Commands:*\n` +
      `/start – Show GPU menu\n` +
      `/topup – Add credits via Paystack\n` +
      `/balance – Check wallet balance\n` +
      `/jobs – View recent jobs\n` +
      `/activejobs – View active jobs\n` +
      `/status <id> – Check job status\n` +
      `/canceljob <id> – Cancel running job\n` +
      `/cancelall – Cancel all active jobs\n` +
      `/infer – Run Micro-GPT inference\n` +
      `/referral – Referral programme\n` +
      `/redeem <code> – Apply referral code\n` +
      `/invoices – View invoices\n` +
      `/language – Set language\n` +
      `/help – Show this menu\n\n` +
      `*Admin Commands:*\n` +
      `/admin – Platform stats\n` +
      `/alljobs – All users' jobs\n` +
      `/users – Recent users\n` +
      `/dlq – Dead-letter jobs\n` +
      `/maxjobs <id> <limit> – Set concurrency limit`,
      { parse_mode: 'Markdown' }
    )
  })

  // ============================================================
  // ADMIN: /admin – Platform stats
  // ============================================================
  bot.command('admin', async (ctx) => {
    const userId = String(ctx.from.id)
    if (!ADMIN_IDS.includes(userId)) return ctx.reply('⛔ Unauthorized')

    try {
      const totalUsers = await prisma.user.count()
      const totalJobs = await prisma.job.count()
      const completedJobs = await prisma.job.count({ where: { status: 'completed' } })
      const failedJobs = await prisma.job.count({ where: { status: 'failed' } })
      const runningJobs = await prisma.job.count({ where: { status: 'running' } })

      const totalRevenue = await prisma.job.aggregate({
        where: { status: 'completed' },
        _sum: { totalCostNGN: true }
      })

      const dlqCount = await prisma.deadLetterJob.count({ where: { reviewed: false } })

      await ctx.reply(
        `📊 *VoltCore Admin Stats*\n\n` +
        `👥 Users: ${totalUsers}\n` +
        `📋 Total Jobs: ${totalJobs}\n` +
        `  ✅ Completed: ${completedJobs}\n` +
        `  ❌ Failed: ${failedJobs}\n` +
        `  🚀 Running: ${runningJobs}\n` +
        `  💀 DLQ: ${dlqCount}\n\n` +
        `💰 Total Revenue: ₦${(totalRevenue._sum.totalCostNGN || 0).toLocaleString()}`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('Admin stats error:', err)
      await ctx.reply('Error fetching admin stats.')
    }
  })

  // ============================================================
  // ADMIN: /alljobs
  // ============================================================
  bot.command('alljobs', async (ctx) => {
    const userId = String(ctx.from.id)
    if (!ADMIN_IDS.includes(userId)) return ctx.reply('⛔ Unauthorized')

    try {
      const recentJobs = await prisma.job.findMany({
        take: 15,
        orderBy: { createdAt: 'desc' },
        include: { user: true }
      })

      if (recentJobs.length === 0) return ctx.reply("No jobs found.")

      const list = recentJobs.map(j => {
        const emoji = j.status === 'completed' ? '✅' :
                      j.status === 'running' ? '🚀' :
                      j.status === 'failed' ? '❌' : '📋'
        return `${emoji} ${j.id.slice(0, 8)} · ${j.user.firstName || 'user'} · ${j.gpuType} · ₦${j.totalCostNGN} · ${j.status}`
      }).join('\n')

      await ctx.reply(`📋 *Recent Jobs (All Users)*\n\n${list}`, { parse_mode: 'Markdown' })
    } catch (err) {
      console.error('Admin jobs error:', err)
      await ctx.reply('Error fetching jobs.')
    }
  })

  // ============================================================
  // ADMIN: /users
  // ============================================================
  bot.command('users', async (ctx) => {
    const userId = String(ctx.from.id)
    if (!ADMIN_IDS.includes(userId)) return ctx.reply('⛔ Unauthorized')

    try {
      const users = await prisma.user.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: { wallet: true }
      })

      const list = users.map(u =>
        `👤 ${u.firstName || 'user'} (${u.telegramId.slice(0, 6)}...) · ₦${(u.wallet?.balance || 0).toLocaleString()} · max ${u.maxConcurrentJobs || 3} jobs`
      ).join('\n')

      await ctx.reply(`👥 *Recent Users*\n\n${list}`, { parse_mode: 'Markdown' })
    } catch (err) {
      console.error('Admin users error:', err)
      await ctx.reply('Error fetching users.')
    }
  })

  // ============================================================
  // ADMIN: /dlq – Dead-letter jobs
  // ============================================================
  bot.command('dlq', async (ctx) => {
    const userId = String(ctx.from.id)
    if (!ADMIN_IDS.includes(userId)) return ctx.reply('⛔ Unauthorized')

    try {
      const jobs = await prisma.deadLetterJob.findMany({
        where: { reviewed: false },
        orderBy: { createdAt: 'desc' },
        take: 10
      })

      if (jobs.length === 0) return ctx.reply('✅ No dead-letter jobs.')

      const list = jobs.map(j =>
        `💀 ${j.originalJobId.slice(0, 8)} · ${j.gpuType} · ${j.errorCode} · ${j.attempts} attempts`
      ).join('\n')

      await ctx.reply(
        `💀 *Dead-Letter Jobs (${jobs.length})*\n\n${list}\n\n` +
        `Use the admin dashboard to review and retry.`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('DLQ error:', err)
      await ctx.reply('Error fetching DLQ.')
    }
  })

  // ============================================================
  // ADMIN: /maxjobs <telegramId> <limit>
  // ============================================================
  bot.command('maxjobs', async (ctx) => {
    const userId = String(ctx.from.id)
    if (!ADMIN_IDS.includes(userId)) return ctx.reply('⛔ Unauthorized')

    try {
      const args = ctx.message.text.split(' ').slice(1)
      if (args.length < 2) return ctx.reply("Usage: /maxjobs <telegramId> <limit>")

      const targetTelegramId = args[0]
      const limit = parseInt(args[1])

      if (!limit || limit < 1 || limit > 20) return ctx.reply("Limit must be between 1 and 20")

      const user = await prisma.user.findUnique({ where: { telegramId: targetTelegramId } })
      if (!user) return ctx.reply(`User not found: ${targetTelegramId}`)

      await prisma.user.update({ where: { id: user.id }, data: { maxConcurrentJobs: limit } })

      await ctx.reply(
        `✅ *Concurrency Updated*\n\n` +
        `User: ${user.firstName || 'user'}\n` +
        `New max concurrent jobs: ${limit}`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('Max jobs error:', err)
      await ctx.reply('Error updating limit.')
    }
  })

  // ============================================================
  // Global error handler
  // ============================================================
  bot.catch((err, ctx) => {
    console.error('Global bot error:', err)
    ctx.reply('Something went wrong. Please try again.').catch(() => {})
  })

  return bot
}