import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { chargeUsage } from '../src/services/walletLedger.js'
import { completeReferral } from '../src/services/referral.js'
import { makeUser, balanceOf, ledgerOf, prisma } from './helpers.js'

after(() => prisma.$disconnect())

test('usage charge writes an audit row', async () => {
  const u = await makeUser(100)
  const r = await chargeUsage(u.id, 'inference', 4, { reference: `infer_t_${u.id}` })
  assert.equal(r.charged, true)
  assert.equal(await balanceOf(u.id), 96)
  assert.equal((await ledgerOf(u.id))[0].type, 'inference')
})

test('usage the balance cannot cover is not debited (no negative balance), reported as unbilled', async () => {
  const u = await makeUser(1)
  const r = await chargeUsage(u.id, 'inference', 5, { reference: `infer_t2_${u.id}` })
  assert.equal(r.charged, false)
  assert.equal(r.unbilledNGN, 5)
  assert.equal(await balanceOf(u.id), 1)
})

test('referrer bonus is paid once even if completeReferral runs twice', async () => {
  const referrer = await makeUser(0)
  const referee = await makeUser(5000)
  const referral = await prisma.referral.create({ data: { referrerId: referrer.id, refereeId: referee.id, status: 'pending' } })
  // referee has spent enough to qualify
  await prisma.job.create({ data: { userId: referee.id, gpuType: '3090', requestedHours: 10, costPerHourNGN: 180, totalCostNGN: 1800, status: 'completed' } })
  const results = await Promise.all([completeReferral(referee.id), completeReferral(referee.id)])
  assert.equal(results.filter(Boolean).length, 1)
  assert.equal(await balanceOf(referrer.id), 5000)
  assert.equal((await ledgerOf(referrer.id)).filter(r => r.reference === `referral_reward_${referral.id}`).length, 1)
})
