import { prisma } from '../db/prisma.js'
import { getGpuPriceNGN, getMenuText } from './pricing.js'
import { t, detectLanguage } from './ux.js'

/**
 * Shared message handler for both Telegram and WhatsApp
 * Supports multi-language
 */
export async function handleUserMessage(userId, text, gpuQueue, platform = 'telegram', lang = 'en') {
  const trimmed = text.trim().toLowerCase()

  // Auto-detect language if not provided
  if (!lang || lang === 'auto') {
    lang = detectLanguage(text)
  }

  // ============================================================
  // COMMANDS
  // ============================================================
  if (trimmed === '/start' || trimmed === 'hi' || trimmed === 'hello') {
    const user = await getOrCreateUser(userId, platform, lang)
    const menuText = await getMenuText()
    return `${t(lang, 'welcome')}, ${user.firstName || 'there'}! 🇳🇬\n\n${menuText}`
  }

  if (trimmed === '/balance' || trimmed === 'balance') {
    const user = await getOrCreateUser(userId, platform, lang)
    const wallet = await prisma.creditWallet.findUnique({
      where: { userId: user.id }
    })
    return `💼 ${t(lang, 'balance')}: ₦${(wallet?.balance || 0).toLocaleString()}`
  }

  if (trimmed === '/help' || trimmed === 'help') {
    return `🧠 VoltCore Commands:\n\n` +
      `/start – ${t(lang, 'gpuMenu')}\n` +
      `/balance – ${t(lang, 'balance')}\n` +
      `/referral – ${t(lang, 'refer')}\n` +
      `/jobs – ${t(lang, 'jobs')}\n` +
      `/help – ${t(lang, 'help')}`
  }

  if (trimmed === '/cancel' || trimmed === 'cancel') {
    return `❌ ${t(lang, 'cancelled')}`
  }

  // ============================================================
  // GPU SELECTION (1, 2, 3)
  // ============================================================
  if (/^[123]$/.test(trimmed)) {
    const user = await getOrCreateUser(userId, platform, lang)
    const gpuMap = { 1: '3090', 2: '4090', 3: 'a100' }
    const gpuType = gpuMap[trimmed]
    const price = await getGpuPriceNGN(gpuType)

    await storeSession(userId, platform, { selectedGpu: gpuType, pricePerHour: price, lang })

    return `${t(lang, 'selected')} ${gpuType.toUpperCase()} – ₦${price}/hour.\n${t(lang, 'hoursPrompt')}`
  }

  // ============================================================
  // HOURS INPUT
  // ============================================================
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const hours = parseFloat(trimmed)
    if (hours < 1) return 'Minimum 1 hour required.'

    const session = await getSession(userId, platform)
    if (!session?.selectedGpu) {
      return 'Please select a GPU first: send 1, 2, or 3.'
    }

    const user = await getOrCreateUser(userId, platform, lang)
    const total = hours * session.pricePerHour

    const wallet = await prisma.creditWallet.findUnique({ where: { userId: user.id } })
    if (!wallet || wallet.balance < total) {
      return `⚠️ ${t(lang, 'insufficient')}.\nYou have ₦${wallet?.balance || 0}. Need ₦${total}.\n\n${t(lang, 'topup')}: /topup`
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

    return `✅ Job ${job.id} queued!\n⏳ ${t(lang, 'processing')}`
  }

  return null
}

// ============================================================
// SESSION STORE (Redis-backed in production)
// ============================================================
const sessionCache = new Map()

async function getOrCreateUser(userId, platform, lang) {
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