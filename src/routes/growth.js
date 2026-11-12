import express from 'express'
import { requireAuth } from '../services/auth.js'
import {
  registerAmbassador, getAmbassadorDashboard, getLeaderboard,
  recordAmbassadorEvent, createWorkshop, completeWorkshop
} from '../services/ambassadors.js'
import { calculateKFactor, getGrowthTrends } from '../services/growth.js'

const router = express.Router()

// ============================================================
// POST /api/growth/ambassador/register
// ============================================================
router.post('/ambassador/register', requireAuth, async (req, res) => {
  try {
    const { university, city } = req.body
    const ambassador = await registerAmbassador(req.user.id, university, city)
    res.json({ success: true, ambassador })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ============================================================
// GET /api/growth/ambassador/me
// ============================================================
router.get('/ambassador/me', requireAuth, async (req, res) => {
  try {
    const dashboard = await getAmbassadorDashboard(req.user.id)
    if (!dashboard) return res.status(404).json({ error: 'Not an ambassador' })
    res.json(dashboard)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// POST /api/growth/ambassador/event
// ============================================================
router.post('/ambassador/event', requireAuth, async (req, res) => {
  try {
    const { ambassadorId, eventType, description, attendees, rewardNGN } = req.body
    const event = await recordAmbassadorEvent(ambassadorId, eventType, {
      description, attendees, rewardNGN
    })
    res.json({ success: true, event })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ============================================================
// GET /api/growth/leaderboard (public)
// ============================================================
router.get('/leaderboard', async (req, res) => {
  try {
    const leaderboard = await getLeaderboard(20)
    res.json({
      leaderboard: leaderboard.map((a, i) => ({
        rank: i + 1,
        name: a.user.firstName || 'Anonymous',
        referrals: a.totalReferrals,
        tier: a.tier,
        university: a.university
      }))
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// POST /api/growth/workshop
// ============================================================
router.post('/workshop', requireAuth, async (req, res) => {
  try {
    const workshop = await createWorkshop(req.body)
    res.json({ success: true, workshop })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ============================================================
// POST /api/growth/workshop/:id/complete
// ============================================================
router.post('/workshop/:id/complete', requireAuth, async (req, res) => {
  try {
    const { attendees } = req.body
    const workshop = await completeWorkshop(req.params.id, attendees)
    res.json({ success: true, workshop })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ============================================================
// GET /api/growth/k-factor
// ============================================================
router.get('/k-factor', async (req, res) => {
  try {
    const data = await calculateKFactor()
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/growth/trends
// ============================================================
router.get('/trends', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30
    const trends = await getGrowthTrends(days)
    res.json({ trends })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router