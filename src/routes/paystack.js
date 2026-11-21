import express from 'express'
import crypto from 'crypto'
import { prisma } from '../db/prisma.js'
import { recordTransaction } from '../services/walletLedger.js'
import { notify } from '../services/notifications.js'

const router = express.Router()

/**
 * Verify Paystack signature (HMAC SHA512)
 */
function verifySignature(req) {
  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(JSON.stringify(req.body))
    .digest('hex')
  return hash === req.headers['x-paystack-signature']
}

// ============================================================
// POST /webhook/paystack
// ============================================================
router.post('/paystack', async (req, res) => {
  // 1. Verify signature
  if (!verifySignature(req)) {
    console.error('❌ Invalid Paystack signature')
    return res.sendStatus(401)
  }

  // 2. Acknowledge immediately (Paystack expects 200 within 20s)
  res.sendStatus(200)

  // 3. Process asynchronously
  const event = req.body
  console.log(`🔔 Paystack: ${event.event}`)

  try {
    if (event.event === 'charge.success') {
      await handleChargeSuccess(event.data)
    } else {
      console.log(`⏭️ Ignoring event: ${event.event}`)
    }
  } catch (err) {
    console.error('Webhook processing error:', err)
  }
})

/**
 * Handle successful charge
 */
async function handleChargeSuccess(data) {
  const { reference, amount, metadata, customer } = data
  const telegramId = metadata?.telegramId
  const userId = metadata?.userId

  // --- 1. Idempotency check ---
  const existing = await prisma.paystackTransaction.findUnique({ where: { reference } })
  if (existing && existing.status === 'success') {
    console.log(`⏭️ Duplicate webhook: ${reference} already processed`)
    return
  }

  // --- 2. Find user ---
  let user
  if (userId) {
    user = await prisma.user.findUnique({ where: { id: userId } })
  } else if (telegramId) {
    user = await prisma.user.findUnique({ where: { telegramId } })
  } else if (customer?.email) {
    user = await prisma.user.findUnique({ where: { email: customer.email } })
  }

  if (!user) {
    console.error(`❌ User not found for reference ${reference}`)
    await prisma.paystackTransaction.upsert({
      where: { reference },
      create: { reference, userId: 'unknown', amountNGN: amount / 100, status: 'failed', paystackData: JSON.stringify(data) },
      update: { status: 'failed', paystackData: JSON.stringify(data) }
    })
    return
  }

  const nairaAmount = amount / 100

  // --- 3. Record Paystack transaction ---
  await prisma.paystackTransaction.upsert({
    where: { reference },
    create: {
      reference,
      userId: user.id,
      amountNGN: nairaAmount,
      status: 'success',
      paystackData: JSON.stringify(data),
      processedAt: new Date()
    },
    update: {
      status: 'success',
      paystackData: JSON.stringify(data),
      processedAt: new Date()
    }
  })

  // --- 4. Credit wallet via ledger ---
  try {
    await recordTransaction(user.id, 'topup', nairaAmount, {
      reference,
      description: `Paystack top-up (${reference})`,
      metadata: { paystackReference: reference, email: customer?.email }
    })
  } catch (err) {
    if (err.message.includes('Insufficient')) {
      console.error(`❌ Ledger error for ${reference}:`, err.message)
      return
    }
    throw err
  }

  // --- 5. Notify user ---
  try {
    await notify(
      user.id,
      'payment',
      '💳 Payment Received',
      `₦${nairaAmount.toLocaleString()} credited to your wallet.\nReference: ${reference}`,
      { link: '/dashboard' }
    )
  } catch (e) {
    console.error('Notify failed:', e.message)
  }

  console.log(`✅ Top-up complete: ${user.id} +₦${nairaAmount} (${reference})`)
}

export default router