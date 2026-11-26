// Jobs created before pre-pay holds existed must never get a GPU automatically.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { sweepStuckJobs, STUCK_AFTER_MS } from '../src/services/billing.js'
import { handleProvisionJob } from '../src/services/gpujobs.js'
import { makeUser, balanceOf, prisma } from './helpers.js'

after(() => prisma.$disconnect())

const legacyJob = user => prisma.job.create({
  data: { userId: user.id, gpuType: '3090', requestedHours: 2, costPerHourNGN: 100, totalCostNGN: 200, status: 'pending', jobType: 'gpu' }
})

test('sweep never re-enqueues or refunds an old pending job that has no hold', async () => {
  const u = await makeUser(300)
  const job = await legacyJob(u)
  const enqueued = []
  const deps = { now: () => new Date(Date.now() + 3 * STUCK_AFTER_MS), terminatePod: async () => true, findPodsByName: async () => [], notifyUser: async () => {}, notifyAdmins: async () => {} }
  for (let i = 0; i < 3; i++) await sweepStuckJobs({ enqueue: async j => enqueued.push(j.id) }, deps)
  assert.ok(!enqueued.includes(job.id))
  const after = await prisma.job.findUnique({ where: { id: job.id } })
  assert.equal(after.status, 'pending', 'left for an admin to decide')
  assert.equal(await balanceOf(u.id), 300)
})

test('a stale queue entry for a job with no hold is not provisioned (no provider call)', async () => {
  const u = await makeUser(0)
  const job = await legacyJob(u)
  const queue = { add: async () => { throw new Error('must not queue anything') } }
  const r = await handleProvisionJob({ jobId: job.id, gpuType: '3090', hours: 2 }, queue)
  assert.equal(r.skipped, 'legacy')
  const after = await prisma.job.findUnique({ where: { id: job.id } })
  assert.equal(after.status, 'pending')
  assert.equal(after.providerJobId, null)
  await prisma.job.update({ where: { id: job.id }, data: { status: 'cancelled' } }) // tidy for other sweeps
})
