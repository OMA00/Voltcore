// Vast.ai client against a local fake that returns Vast's documented response shapes.
// This checks our parsing and request format; it cannot prove the live API matches.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

let server, requests = [], vast, pods, putMode = 'ok'
const instances = { 111: { id: 111, actual_status: 'running', label: 'voltcore-jobA' }, 222: { id: 222, actual_status: 'exited', label: 'other' } }

before(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      requests.push({ method: req.method, path: url.pathname, q: url.searchParams.get('q'), body: raw })
      const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
      let m
      if (req.method === 'GET' && url.pathname === '/bundles/') return send(200, { offers: [{ id: 9001, dph_total: 0.19 }] })
      if (req.method === 'PUT' && url.pathname === '/asks/9001/') {
        if (putMode === 'hang') return setTimeout(() => send(200, { success: true, new_contract: 777 }), 1500)
        if (putMode === 'refused') return send(200, { success: false })
        return send(200, { success: true, new_contract: 555 })
      }
      if (req.method === 'GET' && url.pathname === '/instances/') return send(200, { instances: Object.values(instances) })
      if ((m = url.pathname.match(/^\/instances\/(\d+)\/$/))) {
        const inst = instances[m[1]]
        if (req.method === 'DELETE') return inst ? send(200, { success: true }) : send(404, {})
        return inst ? send(200, { instances: inst }) : send(404, {})
      }
      send(404, {})
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  process.env.VAST_API_URL = `http://127.0.0.1:${server.address().port}`
  process.env.VAST_API_KEY = 'vast-test-fake'
  process.env.VAST_TIMEOUT_MS = '300'
  vast = await import('../src/providers/vastai.js')
  pods = await import('../src/providers/pods.js')
})
after(() => server.close())

test('status is read from the wrapped instance, and maps to running/exited', async () => {
  assert.equal(await vast.getVastaiStatus(111), 'running')
  assert.equal(await pods.getPodState('vastai', '111'), 'running')
  assert.equal(await pods.getPodState('vastai', '222'), 'exited')
  assert.equal(await pods.getPodState('vastai', '999'), 'exited', 'a missing instance counts as gone')
})

test('provisioning filters by GPU in the q parameter and returns the contract id, with no made-up SSH details', async () => {
  requests = []
  const r = await vast.provisionVastai('3090', 2, { label: 'voltcore-jobX' })
  assert.equal(r.id, '555')
  assert.equal(r.sshDetails, null)
  assert.equal(r.costPerHourUSD, 0.19)
  const search = requests.find(x => x.path === '/bundles/')
  assert.deepEqual(JSON.parse(search.q).gpu_name, { eq: 'RTX 3090' })
  const create = requests.find(x => x.method === 'PUT')
  assert.equal(JSON.parse(create.body).label, 'voltcore-jobX')
})

test('terminate returns true when deleted or already gone; list finds by label', async () => {
  assert.equal(await pods.terminatePod('vastai', '111'), true)
  assert.equal(await pods.terminatePod('vastai', '999'), true)
  const all = await vast.listVastaiInstances()
  assert.ok(all.some(i => i.name === 'voltcore-jobA' && i.id === 111))
})

test('create that times out is "unknown outcome" and sent only once; a refusal is a clean failure', async () => {
  requests = []; putMode = 'hang'
  await assert.rejects(vast.provisionVastai('3090', 1, { label: 'voltcore-slow' }), err => err.ambiguous === true)
  await new Promise(r => setTimeout(r, 2000))
  assert.equal(requests.filter(x => x.method === 'PUT').length, 1, 'no second rental')

  requests = []; putMode = 'refused'
  await assert.rejects(vast.provisionVastai('3090', 1, {}), err => err.ambiguous === false)
  putMode = 'ok'
})
