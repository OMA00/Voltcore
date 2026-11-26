// web-push v4 is an ES module with named exports only (no default export).
import * as webpush from 'web-push'
import { prisma } from '../db/prisma.js'

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || 'noreply@voltcore.africa'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  )
} else {
  console.warn('⚠️ VAPID keys not configured – push notifications disabled')
}

/**
 * Send push notification to all user's subscriptions
 */
export async function sendWebPush(userId, payload) {
  if (!process.env.VAPID_PUBLIC_KEY) return

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId }
  })

  const results = []
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      }, JSON.stringify({
        title: payload.title,
        body: payload.body,
        link: payload.link,
        icon: '/icon-192.png',
        badge: '/badge-72.png'
      }))
      results.push({ endpoint: sub.endpoint, success: true })
    } catch (err) {
      console.error('Push failed:', err.statusCode, sub.endpoint)
      // 404 or 410 = subscription expired
      if (err.statusCode === 404 || err.statusCode === 410) {
        await prisma.pushSubscription.delete({ where: { id: sub.id } })
      }
      results.push({ endpoint: sub.endpoint, success: false, error: err.message })
    }
  }

  return results
}

/**
 * Save push subscription
 */
export async function saveSubscription(userId, subscription, userAgent = null) {
  return await prisma.pushSubscription.upsert({
    where: { endpoint: subscription.endpoint },
    create: {
      userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent
    },
    update: {
      userId,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent
    }
  })
}

/**
 * Remove subscription
 */
export async function removeSubscription(endpoint) {
  return await prisma.pushSubscription.deleteMany({ where: { endpoint } })
}

/**
 * Get VAPID public key (for client registration)
 */
export function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || ''
}