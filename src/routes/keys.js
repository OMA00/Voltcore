import express from 'express'
import { prisma } from '../db/prisma.js'
import { generateApiKey, listApiKeys, revokeApiKey, getUsageStats } from '../services/apiKeys.js'

const router = express.Router()

/**
 * Simple auth – for now, use admin key or session (extend with proper auth later)
 */
function authenticateAdmin(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key
  if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

// ============================================================
// POST /api/keys
// ============================================================
router.post('/', authenticateAdmin, async (req, res) => {
  try {
    const { userId, name } = req.body
    if (!userId) return res.status(400).json({ error: 'Missing userId' })

    const apiKey = await generateApiKey(userId, name || 'default')
    res.json({ success: true, apiKey })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/keys?userId=...
// ============================================================
router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const { userId } = req.query
    if (!userId) return res.status(400).json({ error: 'Missing userId' })

    const keys = await listApiKeys(userId)
    const stats = await Promise.all(keys.map(k => getUsageStats(k.id)))

    res.json({
      keys: keys.map((k, i) => ({
        ...k,
        usage: stats[i]
      }))
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// DELETE /api/keys/:id
// ============================================================
router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const { userId } = req.query
    if (!userId) return res.status(400).json({ error: 'Missing userId' })

    await revokeApiKey(id, userId)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router