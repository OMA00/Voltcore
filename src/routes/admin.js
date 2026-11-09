import express from 'express'
import jwt from 'jsonwebtoken'
import { prisma } from '../db/prisma.js'

const router = express.Router()

/**
 * Admin authentication middleware
 */
function authenticateAdmin(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key

  if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  next()
}

/**
 * GET /api/admin/stats
 * Overall platform statistics
 */
router.get('/stats', authenticateAdmin, async (req, res) => {
  try {
    const totalUsers = await prisma.user.count()
    const totalJobs = await prisma.job.count()

    const jobsByStatus = await prisma.job.groupBy({
      by: ['status'],
      _count: true
    })

    const totalRevenue = await prisma.job.aggregate({
      where: { status: 'completed' },
      _sum: { totalCostNGN: true }
    })

    const totalWalletBalance = await prisma.creditWallet.aggregate({
      _sum: { balance: true }
    })

    const recentJobs = await prisma.job.count({
      where: {
        createdAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
        }
      }
    })

    res.json({
      totalUsers,
      totalJobs,
      jobsByStatus: jobsByStatus.reduce((acc, item) => {
        acc[item.status] = item._count
        return acc
      }, {}),
      totalRevenueNGN: totalRevenue._sum.totalCostNGN || 0,
      totalWalletBalanceNGN: totalWalletBalance._sum.balance || 0,
      last24hJobs: recentJobs
    })
  } catch (err) {
    console.error('Admin stats error:', err)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/admin/jobs
 * List all jobs with pagination
 */
router.get('/jobs', authenticateAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1
    const limit = parseInt(req.query.limit) || 20
    const status = req.query.status
    const skip = (page - 1) * limit

    const where = status ? { status } : {}

    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { firstName: true, telegramId: true } } }
      }),
      prisma.job.count({ where })
    ])

    res.json({
      jobs,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    })
  } catch (err) {
    console.error('Admin jobs error:', err)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/admin/users
 * List all users with wallet balances
 */
router.get('/users', authenticateAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1
    const limit = parseInt(req.query.limit) || 20
    const skip = (page - 1) * limit

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          wallet: true,
          _count: { select: { jobs: true } }
        }
      }),
      prisma.user.count()
    ])

    res.json({
      users,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    })
  } catch (err) {
    console.error('Admin users error:', err)
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/admin/users/:userId/credit
 * Manually credit a user's wallet
 */
router.post('/users/:userId/credit', authenticateAdmin, async (req, res) => {
  try {
    const { userId } = req.params
    const { amount, reason } = req.body

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' })
    }

    const wallet = await prisma.creditWallet.update({
      where: { userId },
      data: { balance: { increment: amount } }
    })

    console.log(`💰 Admin credited ₦${amount} to ${userId}: ${reason || 'no reason'}`)

    res.json({ success: true, wallet, reason })
  } catch (err) {
    console.error('Admin credit error:', err)
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/admin/jobs/:jobId/refund
 * Manually refund a job
 */
router.post('/jobs/:jobId/refund', authenticateAdmin, async (req, res) => {
  try {
    const { jobId } = req.params

    const job = await prisma.job.findUnique({ where: { id: jobId } })
    if (!job) return res.status(404).json({ error: 'Job not found' })

    if (job.status === 'refunded') {
      return res.status(400).json({ error: 'Already refunded' })
    }

    await prisma.$transaction([
      prisma.job.update({
        where: { id: jobId },
        data: { status: 'refunded', completedAt: new Date() }
      }),
      prisma.creditWallet.update({
        where: { userId: job.userId },
        data: { balance: { increment: job.totalCostNGN } }
      })
    ])

    console.log(`💸 Admin refunded job ${jobId}: ₦${job.totalCostNGN}`)

    res.json({ success: true, refunded: job.totalCostNGN })
  } catch (err) {
    console.error('Admin refund error:', err)
    res.status(500).json({ error: err.message })
  }
})

export default router