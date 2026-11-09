import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode-terminal'
import { prisma } from '../db/prisma.js'
import { GPU_PRICING_NGN, getMenuText } from '../services/pricing.js'
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

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue

      const from = msg.key.remoteJid
      const text = msg.message.conversation
        || msg.message.extendedTextMessage?.text
        || ''

      if (!text) continue

      try {
        // Route through shared message handler
        const reply = await handleUserMessage(from, text, gpuQueue, 'whatsapp')
        if (reply) {
          await sock.sendMessage(from, { text: reply })
        }
      } catch (err) {
        console.error('WhatsApp message error:', err)
        await sock.sendMessage(from, { text: 'Something went wrong. Please try again.' })
      }
    }
  })

  return sock
}

export async function sendWhatsAppMessage(to, text) {
  if (!sock) {
    console.error('WhatsApp bot not initialized')
    return
  }
  try {
    await sock.sendMessage(to, { text })
  } catch (err) {
    console.error('WhatsApp send error:', err)
  }
}