import { Telegraf, session } from 'telegraf'
import { Redis } from '@telegraf/session/redis'
import { prisma } from '../db/prisma.js'
import { GPU_PRICING_NGN, getMenuText } from '../services/pricing.js'

export async function initTelegramBot(token, redisUrl) {
  let store
  try {
    store = Redis({ url: redisUrl })
  } catch (err) {
    console.error('Redis connection failed:', err)
    throw err
  }

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
      const job = await prisma.job.create({
        data: {
          userId: ctx.session.user.id,
          gpuType: ctx.session.selectedGpu,
          requestedHours: hours,
          costPerHourNGN: ctx.session.pricePerHour,
          totalCostNGN: total,
          status: "pending"
        }
      })
      ctx.session.selectedGpu = null
      await ctx.reply(`✅ Order created! Job ID: ${job.id}\nTotal: ₦${total}\n\nPayment will be added soon – we'll notify you.`)
    } catch (err) {
      console.error('Job creation error:', err)
      await ctx.reply('Error creating job. Please try again.')
    }
  })

  bot.catch((err, ctx) => {
    console.error('Global bot error:', err)
    ctx.reply('Something went wrong. Please try again.').catch(() => {})
  })

  return bot
}