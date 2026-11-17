import { prisma } from '../db/prisma.js'
import { sendEmail, templates } from './email.js'
import { sendWebPush } from './push.js'

/**
 * Check user preference for a channel
 */
async function shouldNotify(userId, channel) {
  const pref = await prisma.notificationPreference.findUnique({ where: { userId } })
  if (!pref) return true // default ON
  return pref[channel] !== false
}

/**
 * Send a notification through all channels
 */
export async function notify(userId, type, title, body, options = {}) {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) return

    // 1. Store in-app notification
    const notification = await prisma.notification.create({
      data: {
        userId,
        type,
        title,
        body,
        link: options.link || null
      }
    })

    // 2. Send email
    if (user.email && (await shouldNotify(userId, 'email'))) {
      const template = options.emailTemplate || {
        subject: title,
        html: `<p>${body}</p>`
      }
      await sendEmail(user.email, template)
    }

    // 3. Send push
    if (await shouldNotify(userId, 'push')) {
      await sendWebPush(userId, { title, body, link: options.link })
    }

    // 4. Send to Telegram
    if (user.telegramId && (await shouldNotify(userId, 'telegram'))) {
      try {
        const { initTelegramBot } = await import('../bot/telegram.js')
        const bot = await initTelegramBot(process.env.TELEGRAM_BOT_TOKEN, process.env.REDIS_URL, null)
        await bot.telegram.sendMessage(user.telegramId, `*${title}*\n\n${body}`, { parse_mode: 'Markdown' })
      } catch (e) {
        console.error('Telegram notify failed:', e.message)
      }
    }

    return notification
  } catch (err) {
    console.error('Notify error:', err)
  }
}

/**
 * Get user notifications
 */
export async function getUserNotifications(userId, limit = 20) {
  return await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit
  })
}

/**
 * Get unread count
 */
export async function getUnreadCount(userId) {
  return await prisma.notification.count({
    where: { userId, read: false }
  })
}

/**
 * Mark notification as read
 */
export async function markAsRead(notificationId, userId) {
  return await prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { read: true, readAt: new Date() }
  })
}

/**
 * Mark all as read
 */
export async function markAllAsRead(userId) {
  return await prisma.notification.updateMany({
    where: { userId, read: false },
    data: { read: true, readAt: new Date() }
  })
}

/**
 * Get/update preferences
 */
export async function getPreferences(userId) {
  let pref = await prisma.notificationPreference.findUnique({ where: { userId } })
  if (!pref) {
    pref = await prisma.notificationPreference.create({
      data: { userId }
    })
  }
  return pref
}

export async function updatePreferences(userId, data) {
  return await prisma.notificationPreference.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data
  })
}

// ============================================================
// SPECIFIC NOTIFICATIONS
// ============================================================
export async function notifyWelcome(user) {
  return await notify(
    user.id,
    'welcome',
    'Welcome to VoltCore!',
    'Your account is ready. Explore GPU compute, Micro-GPT, and AI School.',
    { link: '/dashboard', emailTemplate: templates.welcome(user) }
  )
}

export async function notifyInvoice(user, invoice) {
  return await notify(
    user.id,
    'invoice',
    `Invoice ${invoice.number}`,
    `New invoice for ₦${invoice.amountNGN.toLocaleString()}`,
    { link: `/invoices/${invoice.id}`, emailTemplate: templates.invoice(user, invoice) }
  )
}

export async function notifyJobComplete(user, job) {
  return await notify(
    user.id,
    'job_complete',
    `Job ${job.id.slice(0, 8)} Complete`,
    `Your GPU job has finished. Cost: ₦${job.totalCostNGN.toLocaleString()}`,
    { link: '/dashboard', emailTemplate: templates.jobComplete(user, job) }
  )
}

export async function notifyLowBalance(user, balance) {
  return await notify(
    user.id,
    'low_balance',
    'Low Balance',
    `Your wallet balance is ₦${balance.toLocaleString()}. Top up to continue.`,
    { link: '/dashboard', emailTemplate: templates.lowBalance(user, balance) }
  )
}

export async function notifyReferral(user, referrer, bonus) {
  return await notify(
    user.id,
    'referral',
    '🎁 Referral Bonus',
    `${referrer.firstName || 'Your friend'} earned you ₦${bonus.toLocaleString()}.`,
    { link: '/dashboard', emailTemplate: templates.referral(user, referrer, bonus) }
  )
}

export async function notifyCourseCompletion(user, course, certificate) {
  return await notify(
    user.id,
    'course',
    `🎓 Completed: ${course.title}`,
    `Certificate: ${certificate}`,
    { link: '/school', emailTemplate: templates.courseCompletion(user, course, certificate) }
  )
}