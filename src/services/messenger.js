// ============================================================
// Messenger: send a plain message to a user by their DATABASE id.
//
// Looks up the user's platform id and sends on the right channel. Never sends to the
// internal database id (that silently failed before: Telegram rejects it, and every
// failure/refund notice was lost).
//
// Platform ids live in User.telegramId for both platforms:
//   - Telegram: the numeric chat id, e.g. "123456789"
//   - WhatsApp: the Baileys JID, e.g. "2348012345678@s.whatsapp.net"
//
// One Telegram API client is shared by the whole process; it only calls the HTTP API,
// so it does not start polling or open a Redis session store.
// ============================================================
import { Telegram } from 'telegraf'
import { prisma } from '../db/prisma.js'

let telegram = null
function telegramClient() {
  if (!telegram) {
    telegram = new Telegram(process.env.TELEGRAM_BOT_TOKEN,
      process.env.TELEGRAM_API_ROOT ? { apiRoot: process.env.TELEGRAM_API_ROOT } : {})
  }
  return telegram
}

const WHATSAPP_JID = /@(s\.whatsapp\.net|c\.us)$/

/** Send to a platform id directly (Telegram chat id or WhatsApp JID). */
export async function sendToPlatformId(platformId, text, { markdown = true } = {}) {
  const id = String(platformId || '')
  if (!id) return false
  try {
    if (WHATSAPP_JID.test(id)) {
      const { sendWhatsAppMessage } = await import('../bot/whatsapp.js')
      await sendWhatsAppMessage(id, text)
    } else {
      await telegramClient().sendMessage(id, text, markdown ? { parse_mode: 'Markdown' } : {})
    }
    return true
  } catch (err) {
    console.error(`Message to platform id failed: ${err.message}`)
    return false
  }
}

/** Send to a user by database id. Returns false if the user has no platform id. */
export async function sendToUser(userId, text, options) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { telegramId: true } })
  if (!user?.telegramId) {
    console.warn(`No platform id for user ${userId}; message not sent`)
    return false
  }
  return sendToPlatformId(user.telegramId, text, options)
}

/** Send to every id in ADMIN_TELEGRAM_IDS. */
export async function sendToAdmins(text, options) {
  const ids = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
  for (const id of ids) await sendToPlatformId(id, text, options)
}
