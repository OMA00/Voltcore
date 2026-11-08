import axios from 'axios'
import { prisma } from '../db/prisma.js'

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY
const RUNPOD_API_URL = 'https://api.runpod.io/v2'

/**
 * Deploy an inference pod on RunPod
 * Uses vLLM for high-throughput serving
 */
export async function deployInferencePod(modelName, gpuType) {
  console.log(`🚀 Deploying inference pod: ${modelName} on ${gpuType}`)

  try {
    const gpuMap = {
      '3090': 'NVIDIA GeForce RTX 3090',
      '4090': 'NVIDIA GeForce RTX 4090',
      'a100': 'NVIDIA A100-SXM4-80GB'
    }

    const response = await axios.post(
      `${RUNPOD_API_URL}/pods`,
      {
        name: `voltcore-inference-${Date.now()}`,
        gpuTypeId: gpuMap[gpuType],
        containerDiskSize: 50,
        minVcpu: 4,
        minMemory: 16,
        dockerImage: 'vllm/vllm-openai:latest',
        dockerArgs: `--model ${modelName} --port 8000`,
        ports: '8000/http',
        env: [
          { key: 'HF_TOKEN', value: process.env.HF_TOKEN || '' }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${RUNPOD_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    )

    return {
      id: response.data.id,
      endpoint: `https://${response.data.id}-8000.proxy.runpod.net`,
      status: response.data.status
    }
  } catch (error) {
    console.error('Inference deployment error:', error.response?.data || error.message)
    throw new Error(`Inference deployment failed: ${error.message}`)
  }
}

/**
 * Run inference against a deployed pod
 */
export async function runInference(endpoint, prompt, maxTokens = 500) {
  try {
    const response = await axios.post(
      `${endpoint}/v1/completions`,
      {
        model: 'default',
        prompt,
        max_tokens: maxTokens,
        temperature: 0.7,
        stream: false
      },
      {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 120000
      }
    )

    return {
      text: response.data.choices[0].text,
      tokens: response.data.usage.total_tokens,
      model: response.data.model
    }
  } catch (error) {
    console.error('Inference error:', error.response?.data || error.message)
    throw new Error(`Inference failed: ${error.message}`)
  }
}

/**
 * Calculate inference cost in Naira
 */
export async function calculateInferenceCost(tokens) {
  // ₦2 per 1,000 tokens (base price)
  const costPerToken = 0.002
  return tokens * costPerToken
}

/**
 * Deduct credits for inference
 */
export async function deductInferenceCredits(userId, tokens) {
  const costNGN = await calculateInferenceCost(tokens)

  try {
    await prisma.creditWallet.update({
      where: { userId },
      data: { balance: { decrement: costNGN } }
    })

    return { success: true, costNGN, tokens }
  } catch (error) {
    console.error('Credit deduction error:', error)
    throw new Error(`Failed to deduct credits: ${error.message}`)
  }
}