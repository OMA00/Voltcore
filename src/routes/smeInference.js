import express from 'express'
import { validateSmeApiKey, runSmeInference } from '../services/smeInference.js'
import { prisma } from '../db/prisma.js'

const router = express.Router()

/**
 * SME API key authentication
 */
async function authenticateSme(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API key' })
  }

  const sme = await validateSmeApiKey(apiKey)
  if (!sme) {
    return res.status(401).json({ error: 'Invalid API key' })
  }

  req.sme = sme
  next()
}

// ============================================================
// POST /api/sme/chat
// ============================================================
router.post('/chat', authenticateSme, async (req, res) => {
  try {
    const { prompt, maxTokens = 500, modelId = null } = req.body
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' })

    const result = await runSmeInference(
      req.sme.id,
      prompt,
      modelId,
      maxTokens,
      'api'
    )

    res.json({
      success: true,
      response: result.text,
      tokens: result.tokens,
      costNGN: result.costNGN,
      sme: req.sme.name
    })
  } catch (err) {
    console.error('SME inference error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/sme/usage
// ============================================================
router.get('/usage', authenticateSme, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30
    const { getSmeUsage } = await import('../services/smeInference.js')
    const usage = await getSmeUsage(req.sme.id, days)

    res.json({
      sme: req.sme.name,
      totalTokens: req.sme.totalTokens,
      totalSpentNGN: req.sme.totalSpentNGN,
      ...usage
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/sme/models
// ============================================================
router.get('/models', authenticateSme, async (req, res) => {
  try {
    const models = await prisma.customModel.findMany({
      where: { smeId: req.sme.id, status: 'ready' }
    })

    res.json({ models })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router