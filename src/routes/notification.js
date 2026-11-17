import express from 'express'
import { requireAuth } from '../services/auth.js'
import {
  getUserNotifications, getUnreadCount, markAsRead, markAllAsRead,
  getPreferences, updatePreferences
} from '../services/notifications.js'
import { saveSubscription, removeSubscription, getVapidPublicKey } from '../services/push.js'

const router = express.Router()

// ============================================================
// GET /api/notifications
// ============================================================
router.get('/', requireAuth, async (req, res) => {
  try {
    const notifications = await getUserNotifications(req.user.id, 50)
    const unread = await getUnreadCount(req.user.id)
    res.json({ notifications, unread })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// POST /api/notifications/:id/read
// ============================================================
router.post('/:id/read', requireAuth, async (req, res) => {
  try {
    await markAsRead(req.params.id, req.user.id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// POST /api/notifications/read-all
// ============================================================
router.post('/read-all', requireAuth, async (req, res) => {
  try {
    await markAllAsRead(req.user.id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/notifications/preferences
// ============================================================
router.get('/preferences', requireAuth, async (req, res) => {
  try {
    const pref = await getPreferences(req.user.id)
    res.json({ preferences: pref })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// PUT /api/notifications/preferences
// ============================================================
router.put('/preferences', requireAuth, async (req, res) => {
  try {
    const { email, push, whatsapp, telegram } = req.body
    const pref = await updatePreferences(req.user.id, { email, push, whatsapp, telegram })
    res.json({ preferences: pref })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// POST /api/notifications/push/subscribe
// ============================================================
router.post('/push/subscribe', requireAuth, async (req, res) => {
  try {
    const { subscription } = req.body
    if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' })

    const result = await saveSubscription(req.user.id, subscription, req.headers['user-agent'])
    res.json({ success: true, subscription: result })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// DELETE /api/notifications/push/unsubscribe
// ============================================================
router.delete('/push/unsubscribe', requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body
    await removeSubscription(endpoint)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/notifications/push/vapid-key
// ============================================================
router.get('/push/vapid-key', (req, res) => {
  res.json({ publicKey: getVapidPublicKey() })
})

export default router