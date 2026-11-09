import { provisionRunPod, getRunPodStatus, terminateRunPod } from './runpod.js'
import { provisionVastai, getVastaiStatus, terminateVastai } from './vastai.js'

// Price cache
let priceCache = {}
let lastRefresh = 0

/**
 * Fetch real prices from providers (or use cached)
 */
async function refreshPrices() {
  const now = Date.now()
  if (now - lastRefresh < 300000) return priceCache // 5 min cache

  try {
    priceCache = {
      '3090': { runpod: 0.22, vastai: 0.17 },
      '4090': { runpod: 0.38, vastai: 0.34 },
      'a100': { runpod: 1.42, vastai: 1.20 }
    }
    lastRefresh = now
    console.log('📊 Price cache refreshed')
  } catch (error) {
    console.error('Price refresh failed:', error)
  }

  return priceCache
}

/**
 * Get cheapest provider for a GPU type
 */
export async function getCheapestProvider(gpuType) {
  const prices = await refreshPrices()
  const gpuPrices = prices[gpuType]

  if (!gpuPrices) {
    return { name: 'runpod', price: 0.99 }
  }

  let cheapest = 'runpod'
  let cheapestPrice = gpuPrices.runpod || Infinity

  if (gpuPrices.vastai && gpuPrices.vastai < cheapestPrice) {
    cheapest = 'vastai'
    cheapestPrice = gpuPrices.vastai
  }

  console.log(`📡 Cheapest for ${gpuType}: ${cheapest} at $${cheapestPrice}/hr`)
  return { name: cheapest, price: cheapestPrice }
}

// Re-export all provider functions
export { provisionRunPod, getRunPodStatus, terminateRunPod }
export { provisionVastai, getVastaiStatus, terminateVastai }