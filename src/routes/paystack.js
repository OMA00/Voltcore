import express from 'express'
import crypto from 'crypto'
import { prisma } from '../db/prisma.js'
import { applyWalletChange, DuplicateReferenceError } from '../services/walletLedger.js'
import { notify } from '../services/notifications.js'

const router = express.Router()

/**
 * express.json `verify` hook: keep the exact bytes Paystack sent. The signature is an
 * HMAC of those bytes; re-serialising the parsed JSON can change spacing, key order or
 * number formatting, so valid webhooks were rejected.
 */
export function captureRawBody(req, res, buf) {
  req.rawBody = buf
}

/**
 * Verify Paystack signature: HMAC-SHA512 of the raw body with the secret key,
 * compared in constant time.
 */
export function verifySignature(req, secret = process.env.PAYSTACK_SECRET_KEY) {
  const header = req.headers['x-paystack-signature']
  if (!secret || !req.rawBody || typeof header !== 'string') return false
  const expected = crypto.createHmac('sha512', secret).update(req.rawBody).digest('hex')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(header, 'utf8')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// ============================================================
// POST /webhook/paystack
// ============================================================
router.post('/paystack', async (req, res) => {
  if (!verifySignature(req)) {
    console.error('❌ Invalid Paystack signature')
    return res.sendStatus(401)
  }

  const event = req.body
  console.log(`🔔 Paystack: ${event.event}`)

  // Process, then answer. A 500 makes Paystack retry, which is safe: the credit is
  // keyed on the Paystack reference and can only apply once. (Before, the webhook
  // answered 200 first, so a failed credit was never retried.)
  try {
    if (event.event === 'charge.success') {
      await handleChargeSuccess(event.data)
    } else {
      console.log(`⏭️ Ignoring event: ${event.event}`)
    }
    res.sendStatus(200)
  } catch (err) {
    console.error('Webhook processing error:', err.message)
    res.sendStatus(500)
  }
})

/**
 * Credit a successful charge exactly once (ledger ref = Paystack reference), and only
 * then mark the PaystackTransaction 'success'. Before, 'success' was written first, so
 * if the credit then failed, Paystack's retries were skipped as duplicates and the
 * payment was lost.
 */
export async function handleChargeSuccess(data) {
  const { reference, amount, metadata, customer } = data
  if (!reference || !(amount > 0)) throw new Error('charge.success without reference or amount')

  let user = null
  if (metadata?.userId) user = await prisma.user.findUnique({ where: { id: metadata.userId } })
  if (!user && metadata?.telegramId) user = await prisma.user.findUnique({ where: { telegramId: String(metadata.telegramId) } })
  if (!user && customer?.email) user = await prisma.user.findUnique({ where: { email: customer.email } })

  if (!user) {
    console.error(`❌ User not found for Paystack reference ${reference}`)
    await prisma.paystackTransaction.upsert({
      where: { reference },
      create: { reference, userId: 'unknown', amountNGN: amount / 100, status: 'failed', paystackData: JSON.stringify(data) },
      update: {}
    })
    return { credited: false, reason: 'user-not-found' }
  }

  const nairaAmount = amount / 100
  const markSuccess = () => prisma.paystackTransaction.upsert({
    where: { reference },
    create: { reference, userId: user.id, amountNGN: nairaAmount, status: 'success', paystackData: JSON.stringify(data), processedAt: new Date() },
    update: { userId: user.id, status: 'success', paystackData: JSON.stringify(data), processedAt: new Date() }
  })

  // 1. Credit: one atomic statement keyed on the Paystack reference (can only apply once).
  // 2. Then record success. If we crash between the two, Paystack's retry lands in the
  //    duplicate branch, which records success without crediting again.
  try {
    await applyWalletChange(user.id, 'topup', nairaAmount, {
      reference,
      description: `Paystack top-up (${reference})`,
      metadata: { paystackReference: reference }
    })
  } catch (err) {
    if (err instanceof DuplicateReferenceError) {
      console.log(`⏭️ Duplicate webhook: ${reference} already credited`)
      await markSuccess()
      return { credited: false, reason: 'duplicate' }
    }
    throw err
  }
  await markSuccess()

  try {
    await notify(user.id, 'payment', '💳 Payment Received',
      `₦${nairaAmount.toLocaleString()} credited to your wallet.\nReference: ${reference}`, { link: '/dashboard' })
  } catch (e) {
    console.error('Notify failed:', e.message)
  }

  console.log(`✅ Top-up complete: ${user.id} +₦${nairaAmount} (${reference})`)
  return { credited: true }
}

export default router
