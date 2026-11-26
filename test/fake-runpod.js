// Fake RunPod API for tests. Import this FIRST in a test file: ES module imports run before
// the file's own code, and runpod.js reads RUNPOD_API_URL / RUNPOD_API_KEY / RUNPOD_TIMEOUT_MS
// when it loads, so the environment must point here before anything imports it.
import http from 'node:http'

export const calls = []
export const mode = {}

// Set the environment SYNCHRONOUSLY, before any await: modules imported next to this one can
// finish loading while this module waits, so runpod.js may read the env before listen() resolves.
const PORT = 41000 + (process.pid % 2000)
process.env.RUNPOD_API_URL = `http://127.0.0.1:${PORT}`
process.env.RUNPOD_API_KEY = 'runpod-test-fake'
process.env.RUNPOD_TIMEOUT_MS = '300'

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    calls.push({ method: req.method, path: req.url })
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.method === 'POST' && req.url === '/pods') {
      if (mode.create === 'slow') return setTimeout(() => send(200, { id: 'pod-late', costPerHr: 0.3 }), 1500)
      if (mode.create === '503') return send(503, {})
      if (mode.create === '401') return send(401, {})
    }
    if (req.method === 'GET' && req.url.startsWith('/pods/')) {
      if (mode.status === 'flaky' && calls.filter(c => c.method === 'GET').length === 1) return send(503, {})
      return send(200, { id: 'pod-x', desiredStatus: 'RUNNING' })
    }
    send(404, {})
  })
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve) })

export function resetCalls() { calls.length = 0 }
export function closeFakeRunPod() { server.close() }
