// Create calls are never retried; unknown outcomes are resolved by looking the pod up by name.
// fake-runpod.js must be the first import: it points runpod.js at a local fake before it loads.
import { calls, mode, resetCalls, closeFakeRunPod } from './fake-runpod.js'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import * as runpod from '../src/providers/runpod.js'
import { handleProvisionJob } from '../src/services/gpujobs.js'
import { createJobWithHold } from '../src/services/billing.js'
import { makeUser, balanceOf, prisma } from './helpers.js'

after(async () => { closeFakeRunPod(); await prisma.$disconnect() })
const setMode = m => { for (const k of Object.keys(mode)) delete mode[k]; Object.assign(mode, m) }

const posts = () => calls.filter(c => c.method === 'POST').length

test('slow-reply create: the call fails as "unknown outcome" and is NOT retried (no second pod)', async () => {
  resetCalls(); setMode({ create: 'slow' })
  await assert.rejects(runpod.provisionRunPod('3090', 1, { podName: 'voltcore-slow' }), err => err.ambiguous === true)
  await new Promise(r => setTimeout(r, 2500)) // longer than any retry backoff would take
  assert.equal(posts(), 1, 'exactly one create request reached RunPod')
})

test('a 5xx on create is "unknown outcome" and not retried; a 4xx is a clean failure', async () => {
  resetCalls(); setMode({ create: '503' })
  await assert.rejects(runpod.provisionRunPod('3090', 1, {}), err => err.ambiguous === true)
  await new Promise(r => setTimeout(r, 2500))
  assert.equal(posts(), 1)
  resetCalls(); setMode({ create: '401' })
  await assert.rejects(runpod.provisionRunPod('3090', 1, {}), err => err.ambiguous === false)
  assert.equal(posts(), 1)
})

test('read-only calls are still retried (status check survives one 503)', async () => {
  resetCalls(); setMode({ status: 'flaky' })
  const s = await runpod.getRunPodStatus('pod-x')
  assert.equal(s.status, 'RUNNING')
  assert.equal(calls.filter(c => c.method === 'GET').length, 2)
})

// ---------- worker: handleProvisionJob with fake providers ----------

function fakes({ provisionError = null, provisionResult = null, lookups = [], failure = null } = {}) {
  const log = { provision: 0, find: 0, failure: 0, admins: 0, queued: [] }
  return {
    log,
    queue: { add: async (name, data, opts) => { log.queued.push({ name, id: opts?.jobId }) } },
    deps: {
      getCheapestProvider: async () => ({ name: 'runpod', price: 0.22 }),
      provision: {
        runpod: async () => { log.provision++; if (provisionError) throw provisionError; return provisionResult },
        vastai: async () => { throw new Error('vast must not be called') }
      },
      findPodsByName: async () => {
        log.find++
        const next = lookups.length ? lookups.shift() : []
        if (next === 'throw') throw new Error('listing failed')
        return next
      },
      terminatePod: async () => true,
      handleJobFailure: async () => { log.failure++; if (!failure) throw new Error('handleJobFailure must not be called'); return failure },
      sendToUser: async () => {},
      sendToAdmins: async () => { log.admins++ },
      sleep: async () => {},
      lookupDelayMs: 0
    }
  }
}

const ambiguousError = () => Object.assign(new Error('RunPod error: timeout of 300ms exceeded'), { ambiguous: true })

async function heldJob(balance = 1000) {
  const u = await makeUser(balance)
  const job = await createJobWithHold({ userId: u.id, gpuType: '3090', hours: 2, pricePerHourNGN: 100 })
  return { u, job }
}

test('ambiguous create, then the pod is found by name: it is adopted, no retry, no refund', async () => {
  const { u, job } = await heldJob()
  const f = fakes({ provisionError: ambiguousError(), lookups: [[{ providerName: 'runpod', podId: 'pod-adopted' }]] })
  const r = await handleProvisionJob({ jobId: job.id }, f.queue, f.deps)
  assert.equal(r.adopted, true)
  assert.equal(f.log.provision, 1, 'create was called once')
  assert.equal(f.log.failure, 0)
  const saved = await prisma.job.findUnique({ where: { id: job.id } })
  assert.equal(saved.status, 'running')
  assert.equal(saved.providerJobId, 'pod-adopted')
  assert.equal(await balanceOf(u.id), 800, 'hold kept: the user is using the GPU')
  assert.ok(f.log.queued.some(q => q.name === 'meter-usage'))
})

test('ambiguous create and no pod after two lookups: handled as a clean failure (retry queued once)', async () => {
  const { job } = await heldJob()
  const f = fakes({ provisionError: ambiguousError(), lookups: [[], []], failure: { action: 'retry', retryCount: 1, retryDelay: 0 } })
  const r = await handleProvisionJob({ jobId: job.id }, f.queue, f.deps)
  assert.equal(r.action, 'retry')
  assert.equal(f.log.find, 2)
  assert.equal(f.log.provision, 1)
  assert.deepEqual(f.log.queued.map(q => q.id), [`provision-${job.id}-1`])
})

test('ambiguous create and the lookup itself fails: nothing provisioned again, left for the sweep', async () => {
  const { u, job } = await heldJob()
  const f = fakes({ provisionError: ambiguousError(), lookups: ['throw'] })
  const r = await handleProvisionJob({ jobId: job.id }, f.queue, f.deps)
  assert.equal(r.skipped, 'unknown-outcome')
  assert.equal(f.log.failure, 0)
  assert.equal(f.log.admins, 1)
  assert.equal((await prisma.job.findUnique({ where: { id: job.id } })).status, 'provisioning')
  assert.equal(await balanceOf(u.id), 800, 'money stays held until the sweep decides')
})

test('clean failure (401): no lookup, no adoption, job refunded in full', async () => {
  const { u, job } = await heldJob()
  const clean = Object.assign(new Error('RunPod authentication failed'), { ambiguous: false, response: { status: 401 } })
  const f = fakes({ provisionError: clean })
  const { handleJobFailure } = await import('../src/services/failHandler.js')
  f.deps.handleJobFailure = async (...a) => { f.log.failure++; return handleJobFailure(...a) } // the real one
  const r = await handleProvisionJob({ jobId: job.id }, f.queue, f.deps)
  assert.equal(r.action, 'dlq')
  assert.equal(f.log.find, 0, 'no lookup after a clear "no"')
  assert.equal(f.log.provision, 1)
  assert.equal((await prisma.job.findUnique({ where: { id: job.id } })).status, 'failed')
  assert.equal(await balanceOf(u.id), 1000)
})

test('a retry attempt first adopts a pod left by the previous attempt, without creating another', async () => {
  const { job } = await heldJob()
  await prisma.job.update({ where: { id: job.id }, data: { retryCount: 1 } })
  const f = fakes({ provisionResult: { id: 'must-not-be-created' }, lookups: [[{ providerName: 'runpod', podId: 'pod-from-attempt-1' }]] })
  const r = await handleProvisionJob({ jobId: job.id }, f.queue, f.deps)
  assert.equal(r.adopted, true)
  assert.equal(f.log.provision, 0)
  assert.equal((await prisma.job.findUnique({ where: { id: job.id } })).providerJobId, 'pod-from-attempt-1')
})
