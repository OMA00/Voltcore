import express from 'express'
import { prisma } from '../db/prisma.js'
import { validateApiKey, logUsage } from '../services/apiKeys.js'
import { getModel } from '../services/modelRegistry.js'
import { deployInferencePod, runInference } from '../services/inference.js'

const router = express.Router()

// ============================================================
// API KEY AUTHENTICATION MIDDLEWARE
// ============================================================
async function authenticateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API key. Get one at /api/keys' })
  }

  const keyData = await validateApiKey(apiKey)
  if (!keyData) {
    return res.status(401).json({ error: 'Invalid or revoked API key' })
  }

  req.apiKey = keyData
  req.user = keyData.user
  next()
}

// ============================================================
// POST /api/inference/chat
// ============================================================
router.post('/chat', authenticateApiKey, async (req, res) => {
  try {
    const { prompt, maxTokens = 500, model: modelName = 'micro-gpt' } = req.body

    if (!prompt) return res.status(400).json({ error: 'Missing prompt' })

    // Check model exists
    const model = await getModel(modelName)
    if (!model) return res.status(404).json({ error: `Model not found: ${modelName}` })

    // Check wallet balance
    const wallet = await prisma.creditWallet.findUnique({
      where: { userId: req.user.id }
    })

    const estimatedCost = (maxTokens / 1000) * model.pricePer1kTokens
    if (!wallet || wallet.balance < estimatedCost) {
      return res.status(402).json({
        error: 'Insufficient balance',
        balance: wallet?.balance || 0,
        estimatedCost
      })
    }

    // Deploy pod (or reuse)
    const pod = await deployInferencePod(model.baseModel, '4090')

    // Run inference
    const result = await runInference(pod.endpoint, prompt, maxTokens)

    // Calculate cost
    const costNGN = (result.tokens / 1000) * model.pricePer1kTokens

    // Deduct credits
    await prisma.creditWallet.update({
      where: { userId: req.user.id },
      data: { balance: { decrement: costNGN } }
    })

    // Log usage
    await logUsage(req.apiKey.id, model.name, result.tokens, costNGN)

    res.json({
      success: true,
      response: result.text,
      tokens: result.tokens,
      model: model.name,
      costNGN
    })
  } catch (err) {
    console.error('Inference API error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// POST /api/inference/stream
// ============================================================
router.post('/stream', authenticateApiKey, async (req, res) => {
  try {
    const { prompt, maxTokens = 500, model: modelName = 'micro-gpt' } = req.body
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' })

    const model = await getModel(modelName)
    if (!model) return res.status(404).json({ error: `Model not found: ${modelName}` })

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    const pod = await deployInferencePod(model.baseModel, '4090')

    const response = await fetch(`${pod.endpoint}/v1/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'default',
        prompt,
        max_tokens: maxTokens,
        stream: true
      })
    })

    const reader = response.body.getReader()
    let totalTokens = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = new TextDecoder().decode(value)
      const lines = chunk.split('\n').filter(line => line.trim())

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6)
          if (data === '[DONE]') {
            res.write(`data: [DONE]\n\n`)
            break
          }
          try {
            const parsed = JSON.parse(data)
            if (parsed.choices?.[0]?.text) {
              totalTokens += parsed.usage?.total_tokens || 1
              res.write(`data: ${JSON.stringify(parsed)}\n\n`)
            }
          } catch (e) {}
        }
      }
    }

    // Deduct credits
    const costNGN = (totalTokens / 1000) * model.pricePer1kTokens
    await prisma.creditWallet.update({
      where: { userId: req.user.id },
      data: { balance: { decrement: costNGN } }
    })

    await logUsage(req.apiKey.id, model.name, totalTokens, costNGN)

    res.end()
  } catch (err) {
    console.error('Streaming error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/inference/models
// ============================================================
router.get('/models', authenticateApiKey, async (req, res) => {
  const models = await prisma.model.findMany({
    where: { status: 'active' },
    select: {
      name: true,
      displayName: true,
      contextLength: true,
      pricePer1kTokens: true,
      description: true
    }
  })

  res.json({ models })
})

export default router