import express from 'express'
import { validateApiKey, logUsage } from '../services/apiKeys.js'
import { runSmeInference, getSmeUsage } from '../services/smeInference.js'
import { listModels } from '../services/modelRegistry.js'
import { prisma } from '../db/prisma.js'

const router = express.Router()

// ============================================================
// API VERSION MIDDLEWARE
// ============================================================
router.use((req, res, next) => {
  res.setHeader('X-VoltCore-API-Version', 'v1')
  res.setHeader('X-VoltCore-Docs', 'https://voltcore.africa/docs/api')
  next()
})

// ============================================================
// API KEY AUTH
// ============================================================
async function auth(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key
  if (!apiKey) return res.status(401).json({ error: 'Missing API key. Get one at /developers' })

  const keyData = await validateApiKey(apiKey)
  if (!keyData) return res.status(401).json({ error: 'Invalid or revoked API key' })

  req.apiKey = keyData
  req.user = keyData.user
  next()
}

// ============================================================
// GET /api/v1/health
// ============================================================
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: 'v1',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  })
})

// ============================================================
// GET /api/v1/models
// ============================================================
router.get('/models', auth, async (req, res) => {
  try {
    const models = await listModels()
    res.json({
      models: models.map(m => ({
        id: m.name,
        name: m.displayName,
        context: m.contextLength,
        pricePer1kTokens: m.pricePer1kTokens,
        description: m.description
      }))
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// POST /api/v1/chat/completions
// ============================================================
router.post('/chat/completions', auth, async (req, res) => {
  try {
    const {
      model = 'micro-gpt',
      prompt,
      messages,
      max_tokens = 500,
      temperature = 0.7
    } = req.body

    // Accept both prompt (simple) and messages (OpenAI-compatible)
    let inputPrompt = prompt
    if (!inputPrompt && Array.isArray(messages)) {
      inputPrompt = messages.map(m => `${m.role}: ${m.content}`).join('\n')
    }
    if (!inputPrompt) {
      return res.status(400).json({ error: 'Missing prompt or messages' })
    }

    // Check wallet
    const wallet = await prisma.creditWallet.findUnique({
      where: { userId: req.user.id }
    })

    const estimatedCost = (max_tokens / 1000) * 2
    if (!wallet || wallet.balance < estimatedCost) {
      return res.status(402).json({
        error: 'Insufficient balance',
        balance: wallet?.balance || 0,
        estimatedCost
      })
    }

    // Run inference
    const result = await runSmeInference(
      null, // no SME – use default model
      inputPrompt,
      null,
      max_tokens,
      'api'
    )

    // Log usage
    await logUsage(req.apiKey.id, model, result.tokens, result.costNGN)

    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: result.text },
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: Math.ceil(inputPrompt.length / 4),
        completion_tokens: result.tokens,
        total_tokens: result.tokens
      },
      voltcore: {
        costNGN: result.costNGN,
        balanceRemaining: wallet.balance - result.costNGN
      }
    })
  } catch (err) {
    console.error('API v1 chat error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/v1/usage
// ============================================================
router.get('/usage', auth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    const usage = await prisma.apiUsage.aggregate({
      where: { apiKeyId: req.apiKey.id, createdAt: { gte: since } },
      _sum: { tokens: true, costNGN: true },
      _count: true
    })

    res.json({
      period: `Last ${days} days`,
      requests: usage._count,
      tokens: usage._sum.tokens || 0,
      costNGN: usage._sum.costNGN || 0
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router