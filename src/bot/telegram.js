import { Telegraf, session } from 'telegraf';
import { Redis } from '@telegraf/session/redis'; // Correct import path
import { prisma } from '../db/prisma.js';
import { GPU_PRICING_NGN, getMenuText } from '../services/pricing.js';

export async function initTelegramBot(token, redisUrl) {
  // Create the Redis store using the correct syntax
  const store = Redis({
    url: redisUrl
  });

  const bot = new Telegraf(token);
  bot.use(session({ store }));

  bot.use(async (ctx, next) => {
    if (!ctx.session.user && ctx.from) {
      const telegramId = String(ctx.from.id);
      ctx.session.user = await prisma.user.findUnique({ where: { telegramId } });
    }
    return next();
  });

  bot.start(async (ctx) => {
    let user = ctx.session.user;
    if (!user) {
      user = await prisma.user.create({
        data: {
          telegramId: String(ctx.from.id),
          firstName: ctx.from.first_name,
          wallet: { create: { balance: 0 } }
        }
      });
      ctx.session.user = user;
    }
    await ctx.reply(`Welcome to VoltCore, ${user.firstName || "there"}! 🇳🇬\n\n${getMenuText()}`);
  });

  bot.command('cancel', async (ctx) => {
    ctx.session.selectedGpu = null;
    await ctx.reply("Order cancelled. Use /start to begin again.");
  });

  bot.hears(/^(1|2|3)$/, async (ctx) => {
    const gpuMap = { 1: "3090", 2: "4090", 3: "a100" };
    const gpuType = gpuMap[ctx.match[1]];
    const price = GPU_PRICING_NGN[gpuType];
    ctx.session.selectedGpu = gpuType;
    ctx.session.pricePerHour = price;
    await ctx.reply(`Selected ${gpuType.toUpperCase()} – ₦${price}/hour.\nHow many hours do you need? (minimum 1)`);
  });

  bot.hears(/^\d+(\.\d+)?$/, async (ctx) => {
    if (!ctx.session.selectedGpu) {
      return ctx.reply("Please select a GPU first using 1, 2, or 3.");
    }
    const hours = parseFloat(ctx.message.text);
    if (hours < 1) {
      return ctx.reply("Minimum 1 hour required.");
    }
    const total = hours * ctx.session.pricePerHour;
    const job = await prisma.job.create({
      data: {
        userId: ctx.session.user.id,
        gpuType: ctx.session.selectedGpu,
        requestedHours: hours,
        costPerHourNGN: ctx.session.pricePerHour,
        totalCostNGN: total,
        status: "pending"
      }
    });
    ctx.session.selectedGpu = null;
    await ctx.reply(`✅ Order created! Job ID: ${job.id}\nTotal: ₦${total}\n\nPayment will be added soon – we'll notify you.`);
  });

  return bot;
}