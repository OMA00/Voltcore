export const GPU_PRICING_NGN = {
  "3090": 180,
  "4090": 350,
  "a100": 1200
}

/**
 * Price per hour in NGN for one GPU type. Reads GPU_PRICING_NGN only.
 * Added in the Day 23 audit: telegram.js, whatsapp.js, messageHandler.js and
 * admin.js imported these helpers, but they had never been written.
 */
export function getGpuPriceNGN(gpuType) {
  const price = GPU_PRICING_NGN[gpuType]
  if (price === undefined) throw new Error(`Unknown GPU type: ${gpuType}`)
  return price
}

/** All prices per hour in NGN, keyed by GPU type. */
export function getAllPricesNGN() {
  return { ...GPU_PRICING_NGN }
}

export function getMenuText() {
  return `VoltCore GPU Menu (₦/hour):
1️⃣ RTX 3090 24GB – ₦180/hr
2️⃣ RTX 4090 24GB – ₦350/hr
3️⃣ A100 80GB – ₦1200/hr

Reply with the number (1,2,3) to continue.`
}
