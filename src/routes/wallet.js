import express from 'express'
import { requireAuth } from '../services/auth.js'
import { getTransactions, getLedgerSummary } from '../services/walletLedger.js'
import { prisma } from '../db/prisma.js'

const router = express.Router()

// ============================================================
// GET /api/wallet/transactions
// ============================================================
router.get('/transactions', requireAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50
    const transactions = await getTransactions(req.user.id, limit)
    const summary = await getLedgerSummary(req.user.id)
    const wallet = await prisma.creditWallet.findUnique({ where: { userId: req.user.id } })

    res.json({
      balance: wallet?.balance || 0,
      summary,
      transactions
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// POST /api/wallet/topup
// ============================================================
router.post('/topup', requireAuth, async (req, res) => {
  try {
    const amount = parseInt(req.body.amount) || 5000

    if (amount < 1000) {
      return res.status(400).json({ error: 'Minimum top-up is ₦1,000' })
    }

    const axios = (await import('axios')).default
    const reference = `vc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email: req.user.email || `${req.user.telegramId}@voltcore.africa`,
        amount: amount * 100,
        reference,
        metadata: {
          userId: req.user.id,
          telegramId: req.user.telegramId,
          purpose: 'wallet_topup'
        },
        callback_url: `${process.env.BASE_URL || 'http://localhost:3000'}/dashboard?topup=success`
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    )

    res.json({
      success: true,
      authorizationUrl: response.data.data.authorization_url,
      reference: response.data.data.reference
    })
  } catch (err) {
    console.error('Topup init error:', err.response?.data || err.message)
    res.status(500).json({ error: 'Failed to initialize payment' })
  }
})

export default router