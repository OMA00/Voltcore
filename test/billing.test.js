import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import {
  createJobWithHold, refundJob, refundPolicy, completeJob, sweepStuckJobs,
  claimForProvisioning, recordPod, holdReference, refundReference, STUCK_AFTER_MS, SWEEP_MARK
} from '../src/services/billing.js'
import { InsufficientBalanceError } from '../src/services/walletLedger.js'
import { makeUser, balanceOf, ledgerOf, prisma } from './helpers.js'

after(() => prisma.$disconnect())

const HOUR = 60 * 60 * 1000
const MIN = 60 * 1000

/** Fake provider + messenger. `log` records call order so tests can check terminate-before-refund. */
function fakeDeps({ terminateOk = true, orphans = [], now = new Date() } = {}) {
  const log = []
  return {
    log,
    deps: {
      now: () => now,
      terminatePod: async (p, id) => { log.push(`terminate:${p}:${id}`); return typeof terminateOk === 'function' ? terminateOk() : terminateOk },
      findPodsByName: async name => { log.push(`find:${name}`); return orphans },
      notifyUser: async (userId, text) => { log.push(`notify:${userId}`) },
      notifyAdmins: async text => { log.push('admins') }
    }
  }
}

async function runningJob(user, { hours = 4, price = 100, startedAgoMs = 0, now = new Date() } = {}) {
  const job = await createJobWithHold({ userId: user.id, gpuType: '3090', hours, pricePerHourNGN: price })
  assert.equal(await claimForProvisioning(job.id), true)
  assert.equal(await recordPod(job.id, { providerName: 'runpod', podId: `pod-${job.id}`, billedNGN: hours * price },
    new Date(now.getTime() - startedAgoMs)), true)
  return prisma.job.findUnique({ where: { id: job.id } })
}

// ---------------- hold ----------------

test('creating a job takes the full price as a hold with ledger ref job_<id>', async () => {
  const u = await makeUser(1000)
  const job = await createJobWithHold({ userId: u.id, gpuType: '3090', hours: 3, pricePerHourNGN: 180 })
  assert.equal(await balanceOf(u.id), 1000 - 540)
  const [row] = await ledgerOf(u.id)
  assert.equal(row.reference, holdReference(job.id))
  assert.equal(row.amountNGN, -540)
})

test('no job is created when the balance does not cover the hold', async () => {
  const u = await makeUser(100)
  await assert.rejects(createJobWithHold({ userId: u.id, gpuType: '3090', hours: 1, pricePerHourNGN: 180 }), InsufficientBalanceError)
  assert.equal(await prisma.job.count({ where: { userId: u.id } }), 0)
  assert.equal(await balanceOf(u.id), 100)
})

// ---------------- refund policy ----------------

test('refund policy: full before running, full on hard failure, unused whole hours when a running job is cancelled', () => {
  const now = new Date('2026-11-27T12:00:00Z')
  const base = { holdNGN: 400, pricePerHourNGN: 100, requestedHours: 4, now }
  assert.equal(refundPolicy({ ...base, reason: 'user_cancel', fromStatus: 'pending' }), 400)
  assert.equal(refundPolicy({ ...base, reason: 'user_cancel', fromStatus: 'provisioning' }), 400)
  assert.equal(refundPolicy({ ...base, reason: 'hard_failure', fromStatus: 'running', startedAt: new Date(now - 3 * HOUR) }), 400)
  // 1.5h used of 4h -> 2.5h unused -> 2 whole hours -> ₦200
  assert.equal(refundPolicy({ ...base, reason: 'user_cancel', fromStatus: 'running', startedAt: new Date(now - 1.5 * HOUR) }), 200)
  // 3h59 used -> 0.01h unused -> 0 whole hours
  assert.equal(refundPolicy({ ...base, reason: 'user_cancel', fromStatus: 'running', startedAt: new Date(now - (4 * HOUR - MIN)) }), 0)
  // more time used than paid for -> 0, never negative
  assert.equal(refundPolicy({ ...base, reason: 'user_cancel', fromStatus: 'running', startedAt: new Date(now - 9 * HOUR) }), 0)
  // never more than the hold
  assert.equal(refundPolicy({ ...base, holdNGN: 150, reason: 'user_cancel', fromStatus: 'running', startedAt: now }), 150)
  // no hold (job created before holds) -> nothing
  assert.equal(refundPolicy({ ...base, holdNGN: 0, reason: 'hard_failure', fromStatus: 'pending' }), 0)
})

// ---------------- once-only refund ----------------

test('double refund attempt: second call refunds nothing', async () => {
  const u = await makeUser(1000)
  const job = await createJobWithHold({ userId: u.id, gpuType: '3090', hours: 2, pricePerHourNGN: 100 })
  const { deps } = fakeDeps()
  const first = await refundJob(job.id, 'user_cancel', {}, deps)
  const second = await refundJob(job.id, 'user_cancel', {}, deps)
  assert.equal(first.ok, true)
  assert.equal(first.refunded, 200)
  assert.equal(second.ok, false)
  assert.equal(await balanceOf(u.id), 1000)
  assert.equal((await ledgerOf(u.id)).filter(r => r.type === 'refund').length, 1)
})

test('concurrent refund attempts on one job: exactly one credit', async () => {
  const u = await makeUser(1000)
  const job = await createJobWithHold({ userId: u.id, gpuType: '3090', hours: 2, pricePerHourNGN: 100 })
  const { deps } = fakeDeps()
  const results = await Promise.all(Array.from({ length: 6 }, () => refundJob(job.id, 'user_cancel', {}, deps)))
  assert.equal(results.filter(r => r.ok).length, 1)
  assert.equal(await balanceOf(u.id), 1000)
  assert.equal((await ledgerOf(u.id)).filter(r => r.reference === refundReference(job.id)).length, 1)
})

test('refund without a hold (job created before holds): ₦0, job still cancelled', async () => {
  const u = await makeUser(500)
  const legacy = await prisma.job.create({
    data: { userId: u.id, gpuType: '3090', requestedHours: 2, costPerHourNGN: 100, totalCostNGN: 200, status: 'pending' }
  })
  const { deps } = fakeDeps()
  const r = await refundJob(legacy.id, 'user_cancel', {}, deps)
  assert.equal(r.ok, true)
  assert.equal(r.refunded, 0)
  assert.equal(r.legacy, true)
  assert.equal(await balanceOf(u.id), 500, 'no money appears from nowhere')
  assert.equal((await prisma.job.findUnique({ where: { id: legacy.id } })).status, 'cancelled')
})

test('cancelling a running job refunds unused whole hours, after terminating the pod', async () => {
  const now = new Date()
  const u = await makeUser(1000)
  const job = await runningJob(u, { hours: 4, price: 100, startedAgoMs: 1.5 * HOUR, now })
  const { deps, log } = fakeDeps({ now })
  const r = await refundJob(job.id, 'user_cancel', {}, deps)
  assert.equal(r.refunded, 200)
  assert.equal(await balanceOf(u.id), 1000 - 400 + 200)
  assert.deepEqual(log, [`terminate:runpod:pod-${job.id}`])
  assert.equal((await prisma.job.findUnique({ where: { id: job.id } })).status, 'cancelled')
})

test('if the pod will not terminate, no money moves; a later retry refunds once', async () => {
  const now = new Date()
  const u = await makeUser(1000)
  const job = await runningJob(u, { hours: 2, price: 100, startedAgoMs: 0, now })
  const failing = fakeDeps({ terminateOk: false, now })
  const r1 = await refundJob(job.id, 'hard_failure', {}, failing.deps)
  assert.equal(r1.ok, false)
  assert.equal(r1.pending, true)
  assert.equal(await balanceOf(u.id), 800, 'nothing refunded while the pod may still be billing')
  assert.equal((await prisma.job.findUnique({ where: { id: job.id } })).status, 'refunding')

  const ok = fakeDeps({ terminateOk: true, now })
  const r2 = await refundJob(job.id, null, {}, ok.deps) // resume uses the saved plan
  assert.equal(r2.ok, true)
  assert.equal(r2.refunded, 200)
  assert.equal(await balanceOf(u.id), 1000)
  assert.equal((await prisma.job.findUnique({ where: { id: job.id } })).status, 'failed')
})

// ---------------- completion ----------------

test('completing a job moves no money and only happens once', async () => {
  const u = await makeUser(1000)
  const job = await runningJob(u, { hours: 1, price: 180 })
  assert.equal((await completeJob(job.id)).completed, true)
  assert.equal((await completeJob(job.id)).completed, false)
  assert.equal(await balanceOf(u.id), 820)
  assert.equal((await ledgerOf(u.id)).length, 1, 'only the hold')
})

// ---------------- sweep: crash between hold and enqueue ----------------

test('crash between hold and enqueue: sweep waits for the threshold, re-enqueues once, then refunds', async () => {
  const u = await makeUser(1000)
  const job = await createJobWithHold({ userId: u.id, gpuType: '3090', hours: 2, pricePerHourNGN: 100 })
  // Simulated crash: the job was never enqueued.
  const t0 = (await prisma.job.findUnique({ where: { id: job.id } })).createdAt.getTime()
  const enqueued = []
  const enqueue = async j => { if (j.id === job.id) enqueued.push(j.id) }
  const at = ms => fakeDeps({ now: new Date(t0 + ms) })

  let s = await sweepStuckJobs({ enqueue }, at(5 * MIN).deps)
  assert.ok(!s.requeued.includes(job.id), 'younger than the threshold: left alone')
  assert.equal(enqueued.length, 0)

  s = await sweepStuckJobs({ enqueue }, at(STUCK_AFTER_MS + MIN).deps)
  assert.ok(s.requeued.includes(job.id), 'first sweep after the threshold re-enqueues')
  assert.equal(enqueued.length, 1)
  assert.equal((await prisma.job.findUnique({ where: { id: job.id } })).lastError, SWEEP_MARK)

  s = await sweepStuckJobs({ enqueue }, at(STUCK_AFTER_MS + 5 * MIN).deps)
  assert.equal(enqueued.length, 1, 'not re-enqueued twice')
  assert.ok(!s.refunded.includes(job.id), 'waits a full threshold after the re-enqueue before refunding')

  const last = at(2 * STUCK_AFTER_MS + 2 * MIN)
  s = await sweepStuckJobs({ enqueue }, last.deps)
  assert.ok(s.refunded.includes(job.id), 'still stuck after re-enqueue: refunded')
  assert.equal(enqueued.length, 1)
  assert.equal(await balanceOf(u.id), 1000)
  assert.ok(last.log.includes(`notify:${u.id}`), 'user told about the refund')
})

test('sweep: crash mid-provisioning terminates the orphan pod found by name, then refunds', async () => {
  const u = await makeUser(1000)
  const job = await createJobWithHold({ userId: u.id, gpuType: '3090', hours: 2, pricePerHourNGN: 100 })
  const t0 = Date.now()
  await claimForProvisioning(job.id, new Date(t0)) // then "crash" before recordPod
  const { deps, log } = fakeDeps({ now: new Date(t0 + STUCK_AFTER_MS + MIN), orphans: [{ providerName: 'runpod', podId: 'orphan-1' }] })
  const s = await sweepStuckJobs({ enqueue: async () => {} }, deps)
  assert.ok(s.refunded.includes(job.id))
  assert.ok(log.includes(`find:voltcore-${job.id}`))
  assert.ok(log.indexOf('terminate:runpod:orphan-1') < log.indexOf(`notify:${u.id}`), 'pod stopped before the refund notice')
  assert.equal(await balanceOf(u.id), 1000)
})

test('sweep does not call provider APIs for jobs younger than the threshold', async () => {
  const u = await makeUser(1000)
  const job = await createJobWithHold({ userId: u.id, gpuType: '3090', hours: 1, pricePerHourNGN: 100 })
  const t0 = Date.now()
  await claimForProvisioning(job.id, new Date(t0))
  const { deps, log } = fakeDeps({ now: new Date(t0 + 2 * MIN) })
  await sweepStuckJobs({ enqueue: async () => {} }, deps)
  assert.ok(!log.includes(`find:voltcore-${job.id}`))
  assert.equal((await prisma.job.findUnique({ where: { id: job.id } })).status, 'provisioning')
  // tidy up so later sweeps in this file are not affected
  await refundJob(job.id, 'user_cancel', {}, deps)
})
