import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { applyWalletChange, InsufficientBalanceError, DuplicateReferenceError } from '../src/services/walletLedger.js'
import { makeUser, balanceOf, ledgerOf, prisma } from './helpers.js'

after(() => prisma.$disconnect())

test('credit and debit each write one audit row with the balance after', async () => {
  const u = await makeUser(0)
  await applyWalletChange(u.id, 'topup', 5000, { reference: `t-${u.id}-1` })
  await applyWalletChange(u.id, 'job_debit', -1800, { reference: `t-${u.id}-2` })
  assert.equal(await balanceOf(u.id), 3200)
  const rows = await ledgerOf(u.id)
  assert.deepEqual(rows.map(r => [r.amountNGN, r.balanceAfter]), [[5000, 5000], [-1800, 3200]])
})

test('a debit larger than the balance is refused and changes nothing', async () => {
  const u = await makeUser(1000)
  await assert.rejects(
    applyWalletChange(u.id, 'job_debit', -1001, { reference: `t-${u.id}-over` }),
    InsufficientBalanceError
  )
  assert.equal(await balanceOf(u.id), 1000)
  assert.equal((await ledgerOf(u.id)).length, 0)
})

test('the same reference is applied once; the repeat fails and moves no money', async () => {
  const u = await makeUser(0)
  await applyWalletChange(u.id, 'topup', 2000, { reference: `t-${u.id}-dup` })
  await assert.rejects(applyWalletChange(u.id, 'topup', 2000, { reference: `t-${u.id}-dup` }), DuplicateReferenceError)
  assert.equal(await balanceOf(u.id), 2000)
  assert.equal((await ledgerOf(u.id)).length, 1)
})

test('concurrent debits on a balance that covers one: exactly one succeeds, never negative', async () => {
  const u = await makeUser(1000)
  const attempts = Array.from({ length: 8 }, (_, i) =>
    applyWalletChange(u.id, 'job_debit', -1000, { reference: `t-${u.id}-race-${i}` })
  )
  const results = await Promise.allSettled(attempts)
  const ok = results.filter(r => r.status === 'fulfilled').length
  const refused = results.filter(r => r.status === 'rejected' && r.reason instanceof InsufficientBalanceError).length
  assert.equal(ok, 1, 'exactly one debit should succeed')
  assert.equal(refused, 7, 'the rest should be refused for insufficient balance')
  assert.equal(await balanceOf(u.id), 0)
  assert.equal((await ledgerOf(u.id)).length, 1)
})

test('a wallet change inside a caller transaction rolls back with it', async () => {
  const u = await makeUser(500)
  await assert.rejects(prisma.$transaction(async tx => {
    await applyWalletChange(u.id, 'topup', 100, { reference: `t-${u.id}-rb`, tx })
    throw new Error('caller failed after the wallet change')
  }))
  assert.equal(await balanceOf(u.id), 500)
  assert.equal((await ledgerOf(u.id)).length, 0)
})
