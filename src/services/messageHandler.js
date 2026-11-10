import { prisma } from '../db/prisma.js'
import { getGpuPriceNGN, getMenuText } from './pricing.js'
import { t, detectLanguage } from './ux.js'
import { canStartJob, getActiveJobs } from './concurrency.js'

// ============================================================
// SHARED MESSAGE HANDLER
// Used by both Telegram and WhatsApp
// ============================================================
export async function handleUserMessage(
  userId,
  text,
  gpuQueue,
  platform = 'telegram',
  lang = 'en'
) {
  const trimmed = text.trim().toLowerCase()

  // Auto-detect language if not provided
  if (!lang || lang === 'auto') {
    lang = detectLanguage(text)
  }

  // ==========================================================
  // COMMANDS
  // ==========================================================

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
    return (
      `🧠 VoltCore Commands:\n\n` +
      `/start – ${t(lang, 'gpuMenu')}\n` +
      `/balance – ${t(lang, 'balance')}\n` +
      `/activejobs – Active jobs\n` +
      `/cancelall – Cancel all jobs\n` +
      `/jobs – ${t(lang, 'jobs')}\n` +
      `/referral – ${t(lang, 'refer')}\n` +
      `/help – ${t(lang, 'help')}`
    )
  }

  if (trimmed === '/cancel' || trimmed === 'cancel') {
    await clearSession(userId, platform)
    return `❌ ${t(lang, 'cancelled')}`
  }

  // ==========================================================
  // /activejobs – Show active jobs (Day 11)
  // ==========================================================
  if (trimmed === '/activejobs' || trimmed === 'activejobs') {
    const user = await getOrCreateUser(userId, platform, lang)
    const jobs = await getActiveJobs(user.id)

    if (jobs.length === 0) {
      return `📭 You have no active jobs.\n\nUse /start to create one.`
    }

    const limit = user.maxConcurrentJobs || 3
    const list = jobs
      .map((j) => {
        const emoji =
          j.status === 'running'
            ? '🚀'
            : j.status === 'provisioning'
            ? '⏳'
            : '📋'
        return `${emoji} ${j.id.slice(0, 8)} · ${j.gpuType.toUpperCase()} · ${j.requestedHours}h · ₦${j.totalCostNGN.toLocaleString()}`
      })
      .join('\n')

    return `📊 Active Jobs (${jobs.length}/${limit}):\n\n${list}\n\nUse /canceljob <id> to cancel one.`
  }

  // ==========================================================
  // GPU SELECTION (1, 2, 3)
  // ==========================================================
  if (/^[123]$/.test(trimmed)) {
    const user = await getOrCreateUser(userId, platform, lang)
    const gpuMap = { 1: '3090', 2: '4090', 3: 'a100' }
    const gpuType = gpuMap[trimmed]
    const price = await getGpuPriceNGN(gpuType)

    await storeSession(userId, platform, {
      selectedGpu: gpuType,
      pricePerHour: price,
      lang
    })

    return `${t(lang, 'selected')} ${gpuType.toUpperCase()} – ₦${price}/hour.\n${t(lang, 'hoursPrompt')}`
  }

  // ==========================================================
  // HOURS INPUT – WITH CONCURRENCY CHECK (Day 11)
  // ==========================================================
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const hours = parseFloat(trimmed)
    if (hours < 1) return 'Minimum 1 hour required.'

    const session = await getSession(userId, platform)
    if (!session?.selectedGpu) {
      return 'Please select a GPU first: send 1, 2, or 3.'
    }

    const user = await getOrCreateUser(userId, platform, lang)

    // --------------------------------------------------------
    // CONCURRENCY CHECK
    // --------------------------------------------------------
    const concurrency = await canStartJob(user.id)
    if (!concurrency.allowed) {
      return (
        `⚠️ ${concurrency.reason}\n\n` +
        `Active jobs: ${concurrency.currentCount}/${concurrency.limit}\n\n` +
        `Use /activejobs to see them, or /canceljob <id> to cancel one.`
      )
    }

    // --------------------------------------------------------
    // WALLET CHECK
    // --------------------------------------------------------
    const total = hours * session.pricePerHour
    const wallet = await prisma.creditWallet.findUnique({
      where: { userId: user.id }
    })

    if (!wallet || wallet.balance < total) {
      return (
        `⚠️ ${t(lang, 'insufficient')}.\n` +
        `You have ₦${wallet?.balance || 0}. Need ₦${total}.\n\n` +
        `${t(lang, 'topup')}: /topup`
      )
    }

    // --------------------------------------------------------
    // CREATE JOB
    // --------------------------------------------------------
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

    // --------------------------------------------------------
    // QUEUE JOB
    // --------------------------------------------------------
    await gpuQueue.add('provision-gpu', {
      jobId: job.id,
      gpuType: session.selectedGpu,
      hours,
      userId: user.id,
      userTelegramId: userId,
      jobType: 'gpu'
    })

    // Clear session state
    await clearSession(userId, platform)

    // --------------------------------------------------------
    // RETURN CONFIRMATION WITH CONCURRENCY STATUS
    // --------------------------------------------------------
    const activeJobs = await getActiveJobs(user.id)

    return (
      `✅ Job ${job.id} queued!\n\n` +
      `📊 Active jobs: ${activeJobs.length}/${concurrency.limit}\n` +
      `⏳ ${t(lang, 'processing')}`
    )
  }

  // No handler matched
  return null
}

// ============================================================
// SESSION STORE
// (In production: Redis-backed, but Map is fine for MVP)
// ============================================================
const sessionCache = new Map()

async function getOrCreateUser(userId, platform, lang) {
  let user = await prisma.user.findUnique({
    where: { telegramId: String(userId) }
  })

  if (!user) {
    user = await prisma.user.create({
      data: {
        telegramId: String(userId),
        firstName: platform === 'whatsapp' ? 'WhatsApp User' : null,
        wallet: { create: { balance: 0 } }
      }
    })
  }

  // Update last active
  await prisma.user.update({
    where: { id: user.id },
    data: { lastActiveAt: new Date() }
  })

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