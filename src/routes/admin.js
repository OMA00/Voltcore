import express from 'express'
import { prisma } from '../db/prisma.js'

const router = express.Router()

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
function authenticateAdmin(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key

  if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  next()
}

// ============================================================
// GET /api/admin/stats – Overall platform statistics
// ============================================================
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

// ============================================================
// GET /api/admin/jobs – List all jobs (paginated)
// ============================================================
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

// ============================================================
// GET /api/admin/users – List all users
// ============================================================
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

// ============================================================
// POST /api/admin/users/:userId/credit – Manual credit
// ============================================================
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

// ============================================================
// POST /api/admin/jobs/:jobId/refund – Manual refund
// ============================================================
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

// ============================================================
// POST /api/admin/jobs/:jobId/cancel – Cancel with refund
// ============================================================
router.post('/jobs/:jobId/cancel', authenticateAdmin, async (req, res) => {
  try {
    const { jobId } = req.params
    const { handleJobCancellation } = await import('../services/failHandler.js')

    const result = await handleJobCancellation(jobId)

    if (!result.success) {
      return res.status(400).json({ error: result.error })
    }

    res.json({ success: true, refunded: result.refunded })
  } catch (err) {
    console.error('Admin cancel error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/admin/revenue – Revenue breakdown (Day 7)
// ============================================================
router.get('/revenue', authenticateAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    const jobs = await prisma.job.findMany({
      where: {
        createdAt: { gte: since },
        status: 'completed'
      },
      select: {
        gpuType: true,
        providerName: true,
        totalCostNGN: true,
        requestedHours: true
      }
    })

    const byProvider = {}
    const byGpu = {}
    let totalRevenue = 0
    let totalHours = 0

    for (const job of jobs) {
      const provider = job.providerName || 'unknown'
      const gpu = job.gpuType

      byProvider[provider] = byProvider[provider] || { count: 0, revenue: 0, hours: 0 }
      byProvider[provider].count++
      byProvider[provider].revenue += job.totalCostNGN
      byProvider[provider].hours += job.requestedHours

      byGpu[gpu] = byGpu[gpu] || { count: 0, revenue: 0, hours: 0 }
      byGpu[gpu].count++
      byGpu[gpu].revenue += job.totalCostNGN
      byGpu[gpu].hours += job.requestedHours

      totalRevenue += job.totalCostNGN
      totalHours += job.requestedHours
    }

    res.json({
      period: `Last ${days} days`,
      totalRevenue,
      totalJobs: jobs.length,
      totalHours,
      averageRevenuePerJob: jobs.length > 0 ? totalRevenue / jobs.length : 0,
      byProvider,
      byGpu
    })
  } catch (err) {
    console.error('Revenue API error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/admin/fx – Current FX rate and prices (Day 7)
// ============================================================
router.get('/fx', authenticateAdmin, async (req, res) => {
  try {
    const { getFxRate, getBufferedFxRate } = await import('../services/fx.js')
    const { getAllPricesNGN } = await import('../services/pricing.js')

    const rate = await getFxRate()
    const bufferedRate = await getBufferedFxRate()
    const prices = await getAllPricesNGN()

    res.json({
      rawRate: rate,
      bufferedRate,
      buffer: '20%',
      pricesNGN: prices,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('FX API error:', err)
    res.status(500).json({ error: err.message })
  }
})
// ============================================================
// GET /api/admin/dlq – List dead-letter jobs
// ============================================================
router.get('/dlq', authenticateAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1
    const limit = parseInt(req.query.limit) || 20
    const skip = (page - 1) * limit
    const reviewed = req.query.reviewed === 'true' ? true : req.query.reviewed === 'false' ? false : undefined

    const where = reviewed !== undefined ? { reviewed } : {}

    const [jobs, total] = await Promise.all([
      prisma.deadLetterJob.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' }
      }),
      prisma.deadLetterJob.count({ where })
    ])

    res.json({
      jobs,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// POST /api/admin/dlq/:id/review – Mark DLQ job as reviewed
// ============================================================
router.post('/dlq/:id/review', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const dlqJob = await prisma.deadLetterJob.update({
      where: { id },
      data: { reviewed: true, reviewedAt: new Date() }
    })
    res.json({ success: true, dlqJob })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// POST /api/admin/dlq/:id/retry – Manually retry a DLQ job
// ============================================================
router.post('/dlq/:id/retry', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const dlqJob = await prisma.deadLetterJob.findUnique({ where: { id } })
    if (!dlqJob) return res.status(404).json({ error: 'DLQ job not found' })

    // Reset original job
    const originalJob = await prisma.job.update({
      where: { id: dlqJob.originalJobId },
      data: {
        status: 'pending',
        retryCount: 0,
        isDeadLetter: false,
        lastError: null,
        failedAt: null
      }
    })

    // Re-queue
    const { gpuQueue } = await import('../index.js').catch(() => ({}))
    if (gpuQueue) {
      await gpuQueue.add('provision-gpu', {
        jobId: originalJob.id,
        gpuType: originalJob.gpuType,
        hours: originalJob.requestedHours,
        userId: originalJob.userId,
        userTelegramId: originalJob.userId,
        jobType: originalJob.jobType
      })
    }

    // Mark DLQ entry as reviewed
    await prisma.deadLetterJob.update({
      where: { id },
      data: { reviewed: true, reviewedAt: new Date() }
    })

    res.json({ success: true, retried: originalJob.id })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/admin/health – Provider health (Day 7)
// ============================================================
router.get('/health', authenticateAdmin, async (req, res) => {
  try {
    const { getProviderHealth } = await import('../services/healthCheck.js')
    const runpod = await getProviderHealth('runpod')
    const vastai = await getProviderHealth('vastai')

    res.json({
      runpod,
      vastai,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Health API error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// POST /api/admin/reconcile – Trigger reconciliation (Day 7)
// ============================================================
router.post('/reconcile', authenticateAdmin, async (req, res) => {
  try {
    const { runNightlyReconciliation } = await import('../services/reconciliation.js')
    const report = await runNightlyReconciliation()

    res.json({
      success: true,
      report
    })
  } catch (err) {
    console.error('Reconciliation API error:', err)
    res.status(500).json({ error: err.message })
  }
})

export default router