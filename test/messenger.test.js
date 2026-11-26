import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startFakeTelegram } from './fake-telegram.js'
import { prisma } from './helpers.js'

let tg, sendToUser
before(async () => {
  tg = await startFakeTelegram()
  process.env.TELEGRAM_API_ROOT = tg.apiRoot // read lazily by the messenger
  ;({ sendToUser } = await import('../src/services/messenger.js'))
})
after(async () => { tg.close(); await prisma.$disconnect() })

test('a user is messaged at their Telegram chat id, never their database id', async () => {
  const user = await prisma.user.create({ data: { telegramId: '770011', wallet: { create: { balance: 0 } } } })
  const ok = await sendToUser(user.id, 'Job failed, refunded')
  assert.equal(ok, true)
  const last = tg.sent.at(-1)
  assert.equal(last.chatId, '770011')
  assert.notEqual(last.chatId, user.id)
})

test('a user with no platform id is not messaged', async () => {
  const user = await prisma.user.create({ data: { email: `nochat-${Date.now()}@example.test`, wallet: { create: { balance: 0 } } } })
  const before = tg.sent.length
  assert.equal(await sendToUser(user.id, 'hello'), false)
  assert.equal(tg.sent.length, before)
})
