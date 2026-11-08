import { Telegraf, session } from 'telegraf'
import { Redis } from '@telegraf/session/redis'
import axios from 'axios'
import { prisma } from '../db/prisma.js'
import { GPU_PRICING_NGN, getMenuText } from '../services/pricing.js'

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
  // /start – Welcome + GPU menu
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
      await ctx.reply(`Welcome to VoltCore, ${user.firstName || "there"}! 🇳🇬\n\n${getMenuText()}`)
    } catch (err) {
      console.error('Start error:', err)
      await ctx.reply('Error starting. Please try again.')
    }
  })

  // ============================================================
  // /cancel – Reset current order
  // ============================================================
  bot.command('cancel', async (ctx) => {
    try {
      ctx.session.selectedGpu = null
      await ctx.reply("Order cancelled. Use /start to begin again.")
    } catch (err) {
      console.error('Cancel error:', err)
    }
  })

  // ============================================================
  // /topup – Real Paystack link generation
  // ============================================================
  bot.command('topup', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) {
        return ctx.reply("Please /start first.")
      }

      const amount = 5000 // ₦5,000 minimum top-up

      // Create Paystack payment link via API
      const response = await axios.post(
        'https://api.paystack.co/transaction/initialize',
        {
          email: `${user.telegramId}@voltcore.africa`,
          amount: amount * 100, // convert to kobo
          metadata: {
            telegramId: user.telegramId,
            userId: user.id
          },
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
  // /balance – Check wallet balance
  // ============================================================
  bot.command('balance', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) {
        return ctx.reply("Please /start first.")
      }

      const wallet = await prisma.creditWallet.findUnique({
        where: { userId: user.id }
      })

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
  // GPU selection (1, 2, 3)
  // ============================================================
  bot.hears(/^(1|2|3)$/, async (ctx) => {
    try {
      const gpuMap = { 1: "3090", 2: "4090", 3: "a100" }
      const gpuType = gpuMap[ctx.match[1]]
      const price = GPU_PRICING_NGN[gpuType]
      ctx.session.selectedGpu = gpuType
      ctx.session.pricePerHour = price
      await ctx.reply(`Selected ${gpuType.toUpperCase()} – ₦${price}/hour.\nHow many hours do you need? (minimum 1)`)
    } catch (err) {
      console.error('Selection error:', err)
      await ctx.reply('Error selecting GPU. Please try again.')
    }
  })

  // ============================================================
  // Hours input – create GPU provisioning job
  // ============================================================
  bot.hears(/^\d+(\.\d+)?$/, async (ctx) => {
    try {
      if (!ctx.session.selectedGpu) {
        return ctx.reply("Please select a GPU first using 1, 2, or 3.")
      }
      const hours = parseFloat(ctx.message.text)
      if (hours < 1) {
        return ctx.reply("Minimum 1 hour required.")
      }
      const total = hours * ctx.session.pricePerHour

      const user = ctx.session.user
      if (!user) {
        return ctx.reply("User not found. Please /start again.")
      }

      const wallet = await prisma.creditWallet.findUnique({
        where: { userId: user.id }
      })

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
          status: "pending"
        }
      })

      await gpuQueue.add('provision-gpu', {
        jobId: job.id,
        gpuType: ctx.session.selectedGpu,
        hours: hours,
        userId: user.id,
        userTelegramId: String(ctx.from.id),
        jobType: 'gpu'
      })

      ctx.session.selectedGpu = null
      await ctx.reply(`✅ Job ${job.id} created and queued for provisioning!\n⏳ You'll receive SSH details shortly.`)
    } catch (err) {
      console.error('Job creation error:', err)
      await ctx.reply('Error creating job. Please try again.')
    }
  })

  // ============================================================
  // /infer – Run Micro-GPT inference (Day 3)
  // ============================================================
  bot.command('infer', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) {
        return ctx.reply("Please /start first.")
      }

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
  // Handle inference prompt (after /infer)
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

      // Check wallet balance (minimum ₦10)
      const wallet = await prisma.creditWallet.findUnique({
        where: { userId: user.id }
      })

      if (!wallet || wallet.balance < 10) {
        ctx.session.awaitingInferencePrompt = false
        return ctx.reply(`⚠️ Insufficient balance. You need at least ₦10 for inference.\n\nTo top up, reply with: /topup`)
      }

      await ctx.reply("⏳ Running inference... (this may take a few seconds)")

      // Create inference job
      const job = await prisma.job.create({
        data: {
          userId: user.id,
          gpuType: '4090',
          requestedHours: 1,
          costPerHourNGN: 0.002, // per token pricing (approximate)
          totalCostNGN: 0,
          status: "pending",
          sshDetails: prompt // store the prompt temporarily
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
  // /help – Show all commands
  // ============================================================
  bot.command('help', async (ctx) => {
    await ctx.reply(
      `🧠 *VoltCore Commands*\n\n` +
      `/start – Show GPU menu\n` +
      `/topup – Add credits via Paystack\n` +
      `/balance – Check wallet balance\n` +
      `/infer – Run Micro-GPT inference\n` +
      `/cancel – Cancel current order\n` +
      `/help – Show this menu`,
      { parse_mode: 'Markdown' }
    )
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