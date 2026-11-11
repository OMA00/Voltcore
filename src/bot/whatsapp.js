import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode-terminal'
import { prisma } from '../db/prisma.js'
import { getAllPricesNGN } from '../services/pricing.js'
import { buildGpuMenu, renderForWhatsApp, detectLanguage } from '../services/ux.js'
import { handleUserMessage } from '../services/messageHandler.js'

let sock = null
let qrShown = false

export async function initWhatsAppBot(gpuQueue) {
  const { state, saveCreds } = await useMultiFileAuthState('wa-auth')

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['VoltCore', 'Chrome', '1.0.0']
  })

  sock.ev.on('creds.update', saveCreds)

  // ============================================================
  // CONNECTION HANDLER
  // ============================================================
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr && !qrShown) {
      console.log('\n📱 Scan this QR code with WhatsApp:\n')
      qrcode.generate(qr, { small: true })
      qrShown = true
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true

      console.log('WhatsApp connection closed. Reconnecting:', shouldReconnect)

      if (shouldReconnect) {
        initWhatsAppBot(gpuQueue)
      } else {
        console.log('WhatsApp logged out. Delete wa-auth folder and restart.')
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp bot connected')
    }
  })

  // ============================================================
  // MESSAGE HANDLER (text + list + button + voice)
  // ============================================================
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    const sessionKey = `whatsapp:${from}`
    if (type !== 'notify') return

    for (const msg of messages) {
      // At the start of messages.upsert loop:
const { checkRateLimit } = await import('../services/rateLimiter.js')
const rateCheck = await checkRateLimit(from, 'whatsapp')
if (!rateCheck.allowed) {
  await sock.sendMessage(from, { text: `⏳ Too many requests. Please wait ${rateCheck.resetIn}s.` })
  continue
}
      if (!msg.message || msg.key.fromMe) continue

      const from = msg.key.remoteJid

      // ========================================================
      // VOICE NOTE HANDLING
      // ========================================================
      if (msg.message.audioMessage || msg.message.pttMessage) {
        const audioMsg = msg.message.audioMessage || msg.message.pttMessage
        console.log(`🎤 Voice note from ${from} (${audioMsg.seconds}s)`)

        try {
          await sock.sendMessage(from, {
            text: '🎤 Processing voice note...'
          })

          // MVP: voice transcription coming later
          // For now, ask user to send text
          await sock.sendMessage(from, {
            text:
              '🎤 *Voice notes are coming soon!*\n\n' +
              'For now, please type your request as text.\n\n' +
              'Examples:\n' +
              '• /start — GPU menu\n' +
              '• /balance — Wallet balance\n' +
              '• /help — Commands'
          })
        } catch (err) {
          console.error('Voice note error:', err.message)
          await sock.sendMessage(from, {
            text: '🎤 Could not process voice note. Please send text.'
          })
        }
        continue
      }

      // ========================================================
      // EXTRACT USER INPUT (text / list / button)
      // ========================================================
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        ''

      const listResponse =
        msg.message.listResponseMessage?.singleSelectReply?.selectedRowId

      const buttonResponse =
        msg.message.buttonsResponseMessage?.selectedButtonId

      const userInput = text || listResponse || buttonResponse

      if (!userInput) continue

      try {
        // ======================================================
        // LANGUAGE DETECTION
        // ======================================================
        const lang = detectLanguage(userInput)
        console.log(`📱 WhatsApp from ${from} [${lang}]: ${userInput}`)

        // ======================================================
        // /start (rich list menu)
        // ======================================================
        if (
          userInput === '/start' ||
          /^(hi|hello|hey|start)$/i.test(userInput.trim())
        ) {
          const prices = await getAllPricesNGN()
          const menu = buildGpuMenu(lang, prices)
          const waMsg = renderForWhatsApp(menu)
          await sendListMessage(from, waMsg)
          continue
        }

        // ======================================================
        // SHARED HANDLER (balance, jobs, referral, GPU, hours)
        // ======================================================
        const reply = await handleUserMessage(
          from,
          userInput,
          gpuQueue,
          'whatsapp',
          lang
        )

        if (reply) {
          await sock.sendMessage(from, { text: reply })
        }
      } catch (err) {
        console.error('WhatsApp message error:', err.message)
        await sock.sendMessage(from, {
          text: 'Something went wrong. Please try again.'
        })
      }
    }
  })

  return sock
}

// ============================================================
// RICH MESSAGE SENDER (list menu)
// ============================================================
async function sendListMessage(to, payload) {
  if (!sock) return

  if (payload.type === 'list') {
    await sock.sendMessage(to, {
      text: payload.body,
      footer: 'VoltCore',
      title: payload.title,
      buttonText: payload.buttonText,
      sections: payload.sections
    })
  } else {
    await sock.sendMessage(to, { text: payload.text })
  }
}

// ============================================================
// EXPORTED SENDER (for notifications from other services)
// ============================================================
export async function sendWhatsAppMessage(to, text) {
  if (!sock) {
    console.error('WhatsApp bot not initialized')
    return
  }
  try {
    await sock.sendMessage(to, { text })
  } catch (err) {
    console.error('WhatsApp send error:', err.message)
  }
}

// ============================================================
// VOICE TRANSCRIPTION (placeholder – Day 9 MVP)
// ============================================================
async function transcribeAudio(buffer, mimetype) {
  // TODO (Day 10+): integrate Whisper on RunPod
  // const endpoint = process.env.WHISPER_ENDPOINT
  // const res = await axios.post(endpoint, buffer, { headers: { 'Content-Type': mimetype } })
  // return res.data.text
  return null
}