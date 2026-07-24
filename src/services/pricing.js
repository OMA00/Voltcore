export const GPU_PRICING_NGN = {
  "3090": 180,
  "4090": 350,
  "a100": 1200
}

export function getMenuText() {
  return `VoltCore GPU Menu (₦/hour):
1️⃣ RTX 3090 24GB – ₦180/hr
2️⃣ RTX 4090 24GB – ₦350/hr
3️⃣ A100 80GB – ₦1200/hr

Reply with the number (1,2,3) to continue.`
}
