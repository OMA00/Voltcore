import { provisionRunPod, getRunPodStatus } from './runpod.js'
import { provisionVastai, getVastaiStatus } from './vastai.js'

// Price cache (refreshed every 5 minutes)
let priceCache = {}
let lastPriceRefresh = 0

/**
 * Get current prices from all providers
 */
async function refreshPrices() {
  const now = Date.now()
  if (now - lastPriceRefresh < 300000) { // 5 minutes
    return priceCache
  }

  try {
    // In production: query both providers' APIs for real-time pricing
    // For now: mock prices
    priceCache = {
      '3090': { runpod: 0.22, vastai: 0.17 },
      '4090': { runpod: 0.38, vastai: 0.34 },
      'a100': { runpod: 1.42, vastai: 1.20 }
    }
    lastPriceRefresh = now
    console.log('📊 Price cache refreshed')
  } catch (error) {
    console.error('Failed to refresh prices:', error)
  }

  return priceCache
}

/**
 * Get the cheapest provider for a given GPU type
 */
export async function getCheapestProvider(gpuType) {
  const prices = await refreshPrices()
  const gpuPrices = prices[gpuType]

  if (!gpuPrices) {
    // Fallback: use RunPod
    return { name: 'runpod', price: 0.99 }
  }

  // Determine cheapest
  let cheapest = 'runpod'
  let cheapestPrice = gpuPrices.runpod || Infinity

  if (gpuPrices.vastai && gpuPrices.vastai < cheapestPrice) {
    cheapest = 'vastai'
    cheapestPrice = gpuPrices.vastai
  }

  return { name: cheapest, price: cheapestPrice }
}

export { provisionRunPod, getRunPodStatus }
export { provisionVastai, getVastaiStatus }