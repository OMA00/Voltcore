import express from 'express'
import jwt from 'jsonwebtoken'
import { prisma } from '../db/prisma.js'
import { deployInferencePod, runInference, deductInferenceCredits } from '../services/inference.js'

const router = express.Router()

/**
 * Middleware: Authenticate API key
 */
function authenticateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key']

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API key' })
  }

  try {
    const decoded = jwt.verify(apiKey, process.env.JWT_SECRET || 'voltcore-secret')
    req.user = decoded
    next()
  } catch (error) {
    return res.status(401).json({ error: 'Invalid API key' })
  }
}

/**
 * POST /api/inference/chat
 * Run inference for a Micro-GPT client
 */
router.post('/chat', authenticateApiKey, async (req, res) => {
  try {
    const { prompt, maxTokens, model, gpuType } = req.body
    const userId = req.user.userId

    if (!prompt) {
      return res.status(400).json({ error: 'Missing prompt' })
    }

    // Check wallet balance
    const wallet = await prisma.creditWallet.findUnique({
      where: { userId }
    })

    const estimatedCost = (maxTokens || 500) * 0.002
    if (!wallet || wallet.balance < estimatedCost) {
      return res.status(402).json({ 
        error: 'Insufficient balance',
        balance: wallet?.balance || 0,
        estimatedCost
      })
    }

    // Deploy inference pod if not already running
    let endpoint = null
    const existingPod = await prisma.job.findFirst({
      where: {
        userId,
        gpuType: gpuType || '4090',
        status: 'running',
        providerJobId: { not: null }
      },
      orderBy: { createdAt: 'desc' }
    })

    if (existingPod && existingPod.sshDetails) {
      endpoint = existingPod.sshDetails.split('\n')[0].replace('ssh', 'https://')
    } else {
      const pod = await deployInferencePod(model || 'nemotron-nano', gpuType || '4090')
      endpoint = pod.endpoint
    }

    // Run inference
    const result = await runInference(endpoint, prompt, maxTokens)

    // Deduct credits
    await deductInferenceCredits(userId, result.tokens)

    // Return result
    res.json({
      success: true,
      response: result.text,
      tokens: result.tokens,
      model: result.model,
      costNGN: result.tokens * 0.002
    })
  } catch (error) {
    console.error('Inference API error:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/inference/stream
 * Stream inference tokens (for real-time UX)
 */
router.post('/stream', authenticateApiKey, async (req, res) => {
  try {
    const { prompt, maxTokens } = req.body
    const userId = req.user.userId

    if (!prompt) {
      return res.status(400).json({ error: 'Missing prompt' })
    }

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    // Deploy pod
    const pod = await deployInferencePod('nemotron-nano', '4090')

    // Stream from vLLM
    const response = await fetch(`${pod.endpoint}/v1/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'default',
        prompt,
        max_tokens: maxTokens || 500,
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
          } catch (e) {
            // Skip invalid chunks
          }
        }
      }
    }

    // Deduct credits
    await deductInferenceCredits(userId, totalTokens)

    res.end()
  } catch (error) {
    console.error('Streaming error:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/inference/models
 * List available models
 */
router.get('/models', authenticateApiKey, async (req, res) => {
  const models = [
    { id: 'nemotron-nano', name: 'Nemotron Nano 8B', context: 4096, pricePer1kTokens: 2 },
    { id: 'nemotron-super', name: 'Nemotron Super 49B', context: 8192, pricePer1kTokens: 4 },
    { id: 'micro-gpt', name: 'Micro-GPT (SME Fine-tuned)', context: 4096, pricePer1kTokens: 2 }
  ]

  res.json({ models })
})

export default router