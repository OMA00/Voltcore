import { Telegraf, session } from 'telegraf'
import { Redis } from '@telegraf/session/redis'
import { prisma } from '../db/prisma.js'
import { GPU_PRICING_NGN, getMenuText } from '../services/pricing.js'

export async function initTelegramBot(token, redisUrl, gpuQueue) {
  const store = Redis({ url: redisUrl })
  const bot = new Telegraf(token)
  bot.use(session({ store }))

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

  bot.command('cancel', async (ctx) => {
    try {
      ctx.session.selectedGpu = null
      await ctx.reply("Order cancelled. Use /start to begin again.")
    } catch (err) {
      console.error('Cancel error:', err)
    }
  })

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

      // Add to BullMQ queue
      await gpuQueue.add('provision-gpu', {
        jobId: job.id,
        gpuType: ctx.session.selectedGpu,
        hours: hours,
        userId: user.id,
        userTelegramId: String(ctx.from.id)
      })

      ctx.session.selectedGpu = null
      await ctx.reply(`✅ Job ${job.id} created and queued for provisioning!\n⏳ You'll receive SSH details shortly.`)
    } catch (err) {
      console.error('Job creation error:', err)
      await ctx.reply('Error creating job. Please try again.')
    }
  })

  // Top-up command (Paystack link generator)
  bot.command('topup', async (ctx) => {
    try {
      const user = ctx.session.user
      if (!user) {
        return ctx.reply("Please /start first.")
      }

      // Generate Paystack payment link
      const amount = 5000 // ₦5,000 minimum top-up
      const paymentLink = `https://paystack.com/pay/voltcore?amount=${amount}&telegramId=${user.telegramId}`
      
      await ctx.reply(`💳 Top up your wallet:\n\n` +
        `💰 Minimum: ₦5,000\n` +
        `📱 Click here to pay: ${paymentLink}\n\n` +
        `After payment, your wallet will be credited automatically.`)
    } catch (err) {
      console.error('Topup error:', err)
      await ctx.reply('Error generating payment link. Please try again.')
    }
  })

  bot.catch((err, ctx) => {
    console.error('Global bot error:', err)
    ctx.reply('Something went wrong. Please try again.').catch(() => {})
  })

  return bot
}