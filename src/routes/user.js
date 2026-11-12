import express from 'express'
import { requireAuth } from '../services/auth.js'
import { prisma } from '../db/prisma.js'

const router = express.Router()

// ============================================================
// GET /api/user/jobs
// ============================================================
router.get('/jobs', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1
    const limit = parseInt(req.query.limit) || 20
    const skip = (page - 1) * limit

    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where: { userId: req.user.id },
        skip, take: limit,
        orderBy: { createdAt: 'desc' }
      }),
      prisma.job.count({ where: { userId: req.user.id } })
    ])

    res.json({ jobs, pagination: { page, limit, total, pages: Math.ceil(total / limit) } })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/user/wallet
// ============================================================
router.get('/wallet', requireAuth, async (req, res) => {
  try {
    const wallet = await prisma.creditWallet.findUnique({
      where: { userId: req.user.id }
    })
    res.json({ wallet })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/user/invoices
// ============================================================
router.get('/invoices', requireAuth, async (req, res) => {
  try {
    const invoices = await prisma.invoice.findMany({
      where: { userId: req.user.id },
      orderBy: { issuedAt: 'desc' },
      take: 50
    })
    res.json({ invoices })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/user/referrals
// ============================================================
router.get('/referrals', requireAuth, async (req, res) => {
  try {
    const referrals = await prisma.referral.findMany({
      where: { referrerId: req.user.id },
      include: { referee: { select: { firstName: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' }
    })

    const completed = referrals.filter(r => r.status === 'completed').length
    const pending = referrals.filter(r => r.status === 'pending').length
    const totalEarned = referrals.reduce((s, r) => s + r.creditsAwarded, 0)

    res.json({
      referralCode: req.user.referralCode,
      stats: { total: referrals.length, completed, pending, totalEarned },
      referrals
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// POST /api/user/jobs/:id/cancel
// ============================================================
router.post('/jobs/:id/cancel', requireAuth, async (req, res) => {
  try {
    const job = await prisma.job.findFirst({
      where: { id: req.params.id, userId: req.user.id }
    })
    if (!job) return res.status(404).json({ error: 'Job not found' })

    const { handleJobCancellation } = await import('../services/failHandler.js')
    const result = await handleJobCancellation(job.id)

    if (!result.success) return res.status(400).json({ error: result.error })
    res.json({ success: true, refunded: result.refunded })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router 