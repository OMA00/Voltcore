import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import express from 'express'
import paystackRouter, { captureRawBody } from '../src/routes/paystack.js'
import { makeUser, balanceOf, ledgerOf, prisma } from './helpers.js'

const SECRET = process.env.PAYSTACK_SECRET_KEY // fake key set by scripts/test.js
let server, base

before(async () => {
  const app = express()
  app.use(express.json({ verify: captureRawBody })) // same parser setup as src/index.js
  app.use('/webhook', paystackRouter)
  server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => { server.close(); await prisma.$disconnect() })

const sign = raw => crypto.createHmac('sha512', SECRET).update(raw).digest('hex')
const post = (raw, signature = sign(raw)) => fetch(`${base}/webhook/paystack`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-paystack-signature': signature }, body: raw
})
const charge = (user, reference, kobo) => ({
  event: 'charge.success',
  data: { reference, amount: kobo, currency: 'NGN', metadata: { userId: user.id, telegramId: user.telegramId } }
})

test('valid signature over the RAW body is accepted, even when re-serialised JSON would differ', async () => {
  const u = await makeUser(0)
  // Extra whitespace and a float written as 500000.0: JSON.stringify(JSON.parse(raw)) !== raw,
  // so the old check (HMAC of the re-serialised body) would have rejected this real webhook.
  const raw = `{ "event" : "charge.success",\n  "data": { "reference": "ps_raw_${u.id}", "amount": 500000.0, ` +
              `"metadata": { "userId": "${u.id}" } } }`
  assert.notEqual(JSON.stringify(JSON.parse(raw)), raw)
  const res = await post(raw)
  assert.equal(res.status, 200)
  assert.equal(await balanceOf(u.id), 5000)
})

test('a body changed after signing is rejected and credits nothing', async () => {
  const u = await makeUser(0)
  const original = JSON.stringify(charge(u, `ps_tamper_${u.id}`, 100000))
  const tampered = original.replace('100000', '9900000')
  const res = await post(tampered, sign(original))
  assert.equal(res.status, 401)
  assert.equal(await balanceOf(u.id), 0)
})

test('missing or wrong-length signature is rejected', async () => {
  const u = await makeUser(0)
  const raw = JSON.stringify(charge(u, `ps_nosig_${u.id}`, 100000))
  assert.equal((await post(raw, '')).status, 401)
  assert.equal((await post(raw, 'abc')).status, 401)
  assert.equal(await balanceOf(u.id), 0)
})

test('duplicate webhook (Paystack retry) credits once', async () => {
  const u = await makeUser(0)
  const raw = JSON.stringify(charge(u, `ps_dup_${u.id}`, 250000))
  assert.equal((await post(raw)).status, 200)
  assert.equal((await post(raw)).status, 200)
  assert.equal(await balanceOf(u.id), 2500)
  assert.equal((await ledgerOf(u.id)).length, 1)
})

test('concurrent duplicate webhooks credit once', async () => {
  const u = await makeUser(0)
  const raw = JSON.stringify(charge(u, `ps_race_${u.id}`, 100000))
  const results = await Promise.all(Array.from({ length: 5 }, () => post(raw)))
  assert.ok(results.every(r => r.status === 200))
  assert.equal(await balanceOf(u.id), 1000)
  assert.equal((await ledgerOf(u.id)).length, 1)
  const tx = await prisma.paystackTransaction.findUnique({ where: { reference: `ps_race_${u.id}` } })
  assert.equal(tx.status, 'success')
})

test('if the credit fails, the payment is not marked success, so a retry can still credit it', async () => {
  const u = await makeUser(0)
  const ref = `ps_retry_${u.id}`
  const raw = JSON.stringify(charge(u, ref, 300000))
  await prisma.creditWallet.delete({ where: { userId: u.id } }) // force the credit to fail
  assert.equal((await post(raw)).status, 500, 'Paystack is told to retry')
  assert.equal(await prisma.paystackTransaction.findUnique({ where: { reference: ref } }), null)

  await prisma.creditWallet.create({ data: { userId: u.id, balance: 0 } })
  assert.equal((await post(raw)).status, 200)
  assert.equal(await balanceOf(u.id), 3000)
})
