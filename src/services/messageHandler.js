import { prisma } from '../db/prisma.js'
import { GPU_PRICING_NGN, getMenuText } from './pricing.js'
import { getCheapestProvider } from '../providers/provider.router.js'

/**
 * Shared message handler for both Telegram and WhatsApp
 * Platform-agnostic – returns reply text
 */
export async function handleUserMessage(userId, text, gpuQueue, platform = 'telegram') {
  const trimmed = text.trim().toLowerCase()

  // --- /start or "hi" ---
  if (trimmed === '/start' || trimmed === 'hi' || trimmed === 'hello') {
    const user = await getOrCreateUser(userId, platform)
    return `Welcome to VoltCore! 🇳🇬\n\n${getMenuText()}`
  }

  // --- /balance ---
  if (trimmed === '/balance' || trimmed === 'balance') {
    const user = await getOrCreateUser(userId, platform)
    const wallet = await prisma.creditWallet.findUnique({
      where: { userId: user.id }
    })
    return `💼 Your balance: ₦${(wallet?.balance || 0).toLocaleString()}`
  }

  // --- /help ---
  if (trimmed === '/help' || trimmed === 'help') {
    return `🧠 VoltCore Commands:\n\n` +
      `/start – Show GPU menu\n` +
      `/balance – Check wallet\n` +
      `/infer – Run inference\n` +
      `/cancel – Cancel order\n` +
      `/help – Show this menu`
  }

  // --- GPU selection (1, 2, 3) ---
  if (/^[123]$/.test(trimmed)) {
    const user = await getOrCreateUser(userId, platform)
    const gpuMap = { 1: '3090', 2: '4090', 3: 'a100' }
    const gpuType = gpuMap[trimmed]
    const price = GPU_PRICING_NGN[gpuType]

    // Store in session (platform-specific)
    await storeSession(userId, platform, { selectedGpu: gpuType, pricePerHour: price })

    return `Selected ${gpuType.toUpperCase()} – ₦${price}/hour.\nHow many hours do you need? (minimum 1)`
  }

  // --- Hours input (number) ---
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const hours = parseFloat(trimmed)
    if (hours < 1) return 'Minimum 1 hour required.'

    const session = await getSession(userId, platform)
    if (!session?.selectedGpu) {
      return 'Please select a GPU first: send 1, 2, or 3.'
    }

    const user = await getOrCreateUser(userId, platform)
    const total = hours * session.pricePerHour

    const wallet = await prisma.creditWallet.findUnique({ where: { userId: user.id } })
    if (!wallet || wallet.balance < total) {
      return `⚠️ Insufficient balance. You have ₦${wallet?.balance || 0}. Need ₦${total}.\n\nUse /topup to add credits.`
    }

    const job = await prisma.job.create({
      data: {
        userId: user.id,
        gpuType: session.selectedGpu,
        requestedHours: hours,
        costPerHourNGN: session.pricePerHour,
        totalCostNGN: total,
        status: 'pending',
        jobType: 'gpu'
      }
    })

    await gpuQueue.add('provision-gpu', {
      jobId: job.id,
      gpuType: session.selectedGpu,
      hours,
      userId: user.id,
      userTelegramId: userId,
      jobType: 'gpu'
    })

    await clearSession(userId, platform)

    return `✅ Job ${job.id} queued!\n⏳ You'll receive SSH details shortly.`
  }

  return null // No handler matched
}

// --- Simple session store (Redis-backed in production) ---
const sessionCache = new Map()

async function getOrCreateUser(userId, platform) {
  let user = await prisma.user.findUnique({ where: { telegramId: String(userId) } })
  if (!user) {
    user = await prisma.user.create({
      data: {
        telegramId: String(userId),
        firstName: platform === 'whatsapp' ? 'WhatsApp User' : null,
        wallet: { create: { balance: 0 } }
      }
    })
  }
  return user
}

async function storeSession(userId, platform, data) {
  const key = `${platform}:${userId}`
  const existing = sessionCache.get(key) || {}
  sessionCache.set(key, { ...existing, ...data })
}

async function getSession(userId, platform) {
  return sessionCache.get(`${platform}:${userId}`) || null
}

async function clearSession(userId, platform) {
  sessionCache.delete(`${platform}:${userId}`)
}