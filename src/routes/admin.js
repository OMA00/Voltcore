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
// GET /api/admin/stats
// ============================================================
router.get('/stats', authenticateAdmin, async (req, res) => {
  try {
    const [totalUsers, totalJobs, jobsByStatus, totalRevenue, totalWalletBalance, last24hJobs] = await Promise.all([
      prisma.user.count(),
      prisma.job.count(),
      prisma.job.groupBy({ by: ['status'], _count: true }),
      prisma.job.aggregate({ where: { status: 'completed' }, _sum: { totalCostNGN: true } }),
      prisma.creditWallet.aggregate({ _sum: { balance: true } }),
      prisma.job.count({ where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } })
    ])

    res.json({
      totalUsers,
      totalJobs,
      jobsByStatus: jobsByStatus.reduce((acc, item) => {
        acc[item.status] = item._count
        return acc
      }, {}),
      totalRevenueNGN: totalRevenue._sum.totalCostNGN || 0,
      totalWalletBalanceNGN: totalWalletBalance._sum.balance || 0,
      last24hJobs
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/admin/jobs
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
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { firstName: true, telegramId: true } } }
      }),
      prisma.job.count({ where })
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
// GET /api/admin/users
// ============================================================
router.get('/users', authenticateAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1
    const limit = parseInt(req.query.limit) || 20
    const skip = (page - 1) * limit

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        skip, take: limit,
        orderBy: { createdAt: 'desc' },
        include: { wallet: true, _count: { select: { jobs: true } } }
      }),
      prisma.user.count()
    ])

    res.json({
      users,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// POST /api/admin/users/:userId/credit
// ============================================================
router.post('/users/:userId/credit', authenticateAdmin, async (req, res) => {
  try {
    const { userId } = req.params
    const { amount, reason } = req.body
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' })

    const wallet = await prisma.creditWallet.update({
      where: { userId },
      data: { balance: { increment: amount } }
    })

    console.log(`💰 Admin credited ₦${amount} to ${userId}: ${reason || 'no reason'}`)
    res.json({ success: true, wallet, reason })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// POST /api/admin/jobs/:jobId/refund
// ============================================================
router.post('/jobs/:jobId/refund', authenticateAdmin, async (req, res) => {
  try {
    const { jobId } = req.params
    const job = await prisma.job.findUnique({ where: { id: jobId } })
    if (!job) return res.status(404).json({ error: 'Job not found' })
    if (job.status === 'refunded') return res.status(400).json({ error: 'Already refunded' })

    await prisma.$transaction([
      prisma.job.update({ where: { id: jobId }, data: { status: 'refunded', completedAt: new Date() } }),
      prisma.creditWallet.update({ where: { userId: job.userId }, data: { balance: { increment: job.totalCostNGN } } })
    ])

    res.json({ success: true, refunded: job.totalCostNGN })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// POST /api/admin/jobs/:jobId/cancel
// ============================================================
router.post('/jobs/:jobId/cancel', authenticateAdmin, async (req, res) => {
  try {
    const { jobId } = req.params
    const { handleJobCancellation } = await import('../services/failHandler.js')
    const result = await handleJobCancellation(jobId)

    if (!result.success) return res.status(400).json({ error: result.error })
    res.json({ success: true, refunded: result.refunded })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/admin/revenue
// ============================================================
router.get('/revenue', authenticateAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    const jobs = await prisma.job.findMany({
      where: { createdAt: { gte: since }, status: 'completed' },
      select: { gpuType: true, providerName: true, totalCostNGN: true, requestedHours: true }
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
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/admin/fx
// ============================================================
router.get('/fx', authenticateAdmin, async (req, res) => {
  try {
    const { getFxRate, getBufferedFxRate } = await import('../services/fx.js')
    const { getAllPricesNGN } = await import('../services/pricing.js')
    const rate = await getFxRate()
    const bufferedRate = await getBufferedFxRate()
    const prices = await getAllPricesNGN()
    res.json({ rawRate: rate, bufferedRate, buffer: '20%', pricesNGN: prices, timestamp: new Date().toISOString() })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/admin/health
// ============================================================
router.get('/health', authenticateAdmin, async (req, res) => {
  try {
    const { getProviderHealth } = await import('../services/healthCheck.js')
    const [runpod, vastai] = await Promise.all([
      getProviderHealth('runpod'),
      getProviderHealth('vastai')
    ])
    res.json({ runpod, vastai, timestamp: new Date().toISOString() })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// POST /api/admin/reconcile
// ============================================================
router.post('/reconcile', authenticateAdmin, async (req, res) => {
  try {
    const { runNightlyReconciliation } = await import('../services/reconciliation.js')
    const report = await runNightlyReconciliation()
    res.json({ success: true, report })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/admin/queue  (Day 11)
// ============================================================
router.get('/queue', authenticateAdmin, async (req, res) => {
  try {
    const { gpuQueue } = await import('../index.js').catch(() => ({}))
    if (!gpuQueue) return res.status(500).json({ error: 'Queue not available' })

    const counts = await gpuQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused')
    res.json(counts)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/admin/users/:userId/active-jobs  (Day 11)
// ============================================================
router.get('/users/:userId/active-jobs', authenticateAdmin, async (req, res) => {
  try {
    const { userId } = req.params
    const jobs = await prisma.job.findMany({
      where: { userId, status: { in: ['pending', 'provisioning', 'running'] } },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ jobs, count: jobs.length })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// POST /api/admin/users/:userId/set-limit  (Day 11)
// ============================================================
router.post('/users/:userId/set-limit', authenticateAdmin, async (req, res) => {
  try {
    const { userId } = req.params
    const { limit } = req.body
    if (!limit || limit < 1 || limit > 20) return res.status(400).json({ error: 'Limit must be between 1 and 20' })

    const user = await prisma.user.update({
      where: { id: userId },
      data: { maxConcurrentJobs: limit }
    })
    res.json({ success: true, maxConcurrentJobs: user.maxConcurrentJobs })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// POST /api/admin/users/:userId/cancel-all  (Day 11)
// ============================================================
router.post('/users/:userId/cancel-all', authenticateAdmin, async (req, res) => {
  try {
    const { userId } = req.params
    const { handleJobCancellation } = await import('../services/failHandler.js')

    const activeJobs = await prisma.job.findMany({
      where: { userId, status: { in: ['pending', 'provisioning', 'running'] } }
    })

    const results = []
    for (const job of activeJobs) {
      const result = await handleJobCancellation(job.id)
      results.push({ jobId: job.id, ...result })
    }

    res.json({
      success: true,
      cancelled: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// DLQ ROUTES  (Day 10)
// ============================================================
router.get('/dlq', authenticateAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1
    const limit = parseInt(req.query.limit) || 20
    const skip = (page - 1) * limit
    const reviewed = req.query.reviewed === 'true' ? true : req.query.reviewed === 'false' ? false : undefined
    const where = reviewed !== undefined ? { reviewed } : {}

    const [jobs, total] = await Promise.all([
      prisma.deadLetterJob.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
      prisma.deadLetterJob.count({ where })
    ])

    res.json({ jobs, pagination: { page, limit, total, pages: Math.ceil(total / limit) } })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/admin/models
// ============================================================
router.get('/models', authenticateAdmin, async (req, res) => {
  try {
    const models = await prisma.model.findMany({
      include: {
        _count: { select: { fineTuneJobs: true } }
      }
    })
    res.json({ models })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/admin/fine-tune-jobs
// ============================================================
router.get('/fine-tune-jobs', authenticateAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1
    const limit = parseInt(req.query.limit) || 20
    const skip = (page - 1) * limit

    const [jobs, total] = await Promise.all([
      prisma.fineTuneJob.findMany({
        skip, take: limit,
        orderBy: { createdAt: 'desc' },
        include: { model: true }
      }),
      prisma.fineTuneJob.count()
    ])

    res.json({ jobs, pagination: { page, limit, total, pages: Math.ceil(total / limit) } })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/admin/smes
// ============================================================
router.get('/smes', authenticateAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1
    const limit = parseInt(req.query.limit) || 20
    const skip = (page - 1) * limit

    const [smes, total] = await Promise.all([
      prisma.sme.findMany({
        skip, take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { firstName: true, telegramId: true } },
          _count: { select: { datasets: true, customModels: true } }
        }
      }),
      prisma.sme.count()
    ])

    res.json({ smes, pagination: { page, limit, total, pages: Math.ceil(total / limit) } })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/admin/smes/:id
// ============================================================
router.get('/smes/:id', authenticateAdmin, async (req, res) => {
  try {
    const sme = await prisma.sme.findUnique({
      where: { id: req.params.id },
      include: {
        user: true,
        datasets: true,
        customModels: { include: { fineTuneJob: true } }
      }
    })
    if (!sme) return res.status(404).json({ error: 'SME not found' })
    res.json({ sme })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/admin/sme-usage
// ============================================================
router.get('/sme-usage', authenticateAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    const usage = await prisma.smeUsage.groupBy({
      by: ['smeId'],
      where: { createdAt: { gte: since } },
      _sum: { tokens: true, costNGN: true },
      _count: true
    })

    // Enrich with SME names
    const smeIds = usage.map(u => u.smeId)
    const smes = await prisma.sme.findMany({
      where: { id: { in: smeIds } },
      select: { id: true, name: true }
    })

    const smeMap = Object.fromEntries(smes.map(s => [s.id, s.name]))

    const enriched = usage.map(u => ({
      smeId: u.smeId,
      smeName: smeMap[u.smeId] || 'unknown',
      requests: u._count,
      tokens: u._sum.tokens || 0,
      costNGN: u._sum.costNGN || 0
    }))

    res.json({
      period: `Last ${days} days`,
      totalSmes: enriched.length,
      totalTokens: enriched.reduce((s, u) => s + u.tokens, 0),
      totalCostNGN: enriched.reduce((s, u) => s + u.costNGN, 0),
      bySme: enriched.sort((a, b) => b.costNGN - a.costNGN)
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/admin/smes/:id/usage
// ============================================================
router.get('/smes/:id/usage', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const days = parseInt(req.query.days) || 30
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    const [sme, usage, recentLogs] = await Promise.all([
      prisma.sme.findUnique({ where: { id } }),
      prisma.smeUsage.aggregate({
        where: { smeId: id, createdAt: { gte: since } },
        _sum: { tokens: true, costNGN: true },
        _count: true
      }),
      prisma.smeUsage.findMany({
        where: { smeId: id },
        orderBy: { createdAt: 'desc' },
        take: 20
      })
    ])

    if (!sme) return res.status(404).json({ error: 'SME not found' })

    res.json({
      sme,
      period: `Last ${days} days`,
      requests: usage._count,
      tokens: usage._sum.tokens || 0,
      costNGN: usage._sum.costNGN || 0,
      recentLogs
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/admin/api-usage
// ============================================================
router.get('/api-usage', authenticateAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    const usage = await prisma.apiUsage.aggregate({
      where: { createdAt: { gte: since } },
      _sum: { tokens: true, costNGN: true },
      _count: true
    })

    res.json({
      period: `Last ${days} days`,
      totalRequests: usage._count,
      totalTokens: usage._sum.tokens || 0,
      totalCostNGN: usage._sum.costNGN || 0
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

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

router.post('/dlq/:id/retry', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const dlqJob = await prisma.deadLetterJob.findUnique({ where: { id } })
    if (!dlqJob) return res.status(404).json({ error: 'DLQ job not found' })

    const originalJob = await prisma.job.update({
      where: { id: dlqJob.originalJobId },
      data: { status: 'pending', retryCount: 0, isDeadLetter: false, lastError: null, failedAt: null }
    })

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
// GET /api/admin/errors – Recent errors
// ============================================================
router.get('/errors', authenticateAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1
    const limit = parseInt(req.query.limit) || 50
    const skip = (page - 1) * limit
    const level = req.query.level
    const where = level ? { level } : {}

    const [errors, total] = await Promise.all([
      prisma.errorLog.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' }
      }),
      prisma.errorLog.count({ where })
    ])

    res.json({
      errors,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// DELETE /api/admin/errors – Clear old errors
// ============================================================
router.delete('/errors', authenticateAdmin, async (req, res) => {
  try {
    const olderThanDays = parseInt(req.query.days) || 7
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)

    const result = await prisma.errorLog.deleteMany({
      where: { createdAt: { lt: cutoff } }
    })

    res.json({ success: true, deleted: result.count })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/admin/metrics – Prometheus text (for dashboards)
// ============================================================
router.get('/metrics', authenticateAdmin, async (req, res) => {
  try {
    const { getMetrics } = await import('../services/metrics.js')
    const metrics = await getMetrics()
    res.type('text/plain').send(metrics)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router