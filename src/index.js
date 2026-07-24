import 'dotenv/config'
import express from 'express'
import { initTelegramBot } from './bot/telegram.js'
import { prisma } from './db/prisma.js'

const REQUIRED_ENV = ['TELEGRAM_BOT_TOKEN', 'DATABASE_URL', 'REDIS_URL']
REQUIRED_ENV.forEach(key => {
  if (!process.env[key]) throw new Error(`Missing mandatory environment variable: ${key}`)
})

const app = express()
app.use(express.json())

app.get('/health', (req, res) => res.sendStatus(200))

app.post('/webhook/paystack', async (req, res) => {
  console.log('Paystack webhook received', req.body)
  res.sendStatus(200)
})

const bot = await initTelegramBot(process.env.TELEGRAM_BOT_TOKEN, process.env.REDIS_URL)
bot.launch().then(() => console.log("VoltCore Telegram bot active via polling."))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`VoltCore server running on port ${PORT}`))

const shutdown = async () => {
  console.log("Shutting down VoltCore...")
  await bot.stop()
  await prisma.$disconnect()
  process.exit(0)
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
