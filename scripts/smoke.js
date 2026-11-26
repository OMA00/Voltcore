#!/usr/bin/env node
/**
 * VoltCore smoke test:  npm run smoke
 *
 * Boots the real app (src/index.js) against a LOCAL throwaway Postgres + Redis,
 * with fake provider keys and a fake Telegram Bot API, then checks:
 *   1. "VoltCore Telegram bot active", "VoltCore server on port" and "Job poller started" are logged
 *   2. GET /health returns 200
 *   3. /start replies with the GPU menu; /balance and /transactions reply
 *   4. No runtime errors are logged
 *
 * Needs Postgres and Redis running locally. Defaults:
 *   SMOKE_DATABASE_URL=postgresql://voltcore@localhost:55432/voltcore_smoke
 *   SMOKE_REDIS_URL=redis://127.0.0.1:56379
 *
 * Safety: refuses to run unless the database is on localhost and its name ends in
 * "_smoke", because it resets that database and flushes that Redis. The app's real
 * .env is never loaded, so no real keys or production URLs are used.
 */
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Redis } from 'ioredis'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATABASE_URL = process.env.SMOKE_DATABASE_URL || 'postgresql://voltcore@localhost:55432/voltcore_smoke'
const REDIS_URL = process.env.SMOKE_REDIS_URL || 'redis://127.0.0.1:56379'
const APP_PORT = Number(process.env.SMOKE_PORT || 3999)
const BOOT_TIMEOUT_MS = 90_000
const REPLY_TIMEOUT_MS = 20_000
const SETTLE_MS = 35_000 // the job poller first runs 30s after start; wait for one full cycle
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
const SMOKE_USER = { id: 424242, first_name: 'Smoke', language_code: 'en', is_bot: false }

// ---------- safety guard ----------
const db = new URL(DATABASE_URL)
const rd = new URL(REDIS_URL)
if (!LOCAL_HOSTS.has(db.hostname) || !db.pathname.slice(1).endsWith('_smoke')) {
  console.error('Refusing to run: SMOKE_DATABASE_URL must be on localhost and the database name must end in "_smoke".')
  process.exit(2)
}
if (!LOCAL_HOSTS.has(rd.hostname)) {
  console.error('Refusing to run: SMOKE_REDIS_URL must be on localhost.')
  process.exit(2)
}

const results = []
const record = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- fake Telegram Bot API ----------
const updates = []
const sent = []
let nextUpdateId = 1
let waiters = []

function fakeResult(method, body) {
  switch (method) {
    case 'getMe':
      return { id: 999000, is_bot: true, first_name: 'VoltCore Smoke', username: 'voltcore_smoke_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false }
    case 'sendMessage': {
      sent.push({ chatId: String(body.chat_id), text: String(body.text || ''), at: Date.now() })
      return { message_id: sent.length, date: Math.floor(Date.now() / 1000), chat: { id: Number(body.chat_id), type: 'private' }, text: body.text }
    }
    default:
      return true
  }
}

const fakeApi = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', async () => {
    const method = req.url.split('/').pop().split('?')[0]
    let body = {}
    try { body = raw ? JSON.parse(raw) : {} } catch { body = {} }
    const reply = result => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })) }

    if (method === 'getUpdates') {
      const offset = Number(body.offset || 0)
      const pending = () => updates.filter(u => u.update_id >= offset)
      if (pending().length === 0) {
        await new Promise(resolve => { const t = setTimeout(resolve, 1000); waiters.push(() => { clearTimeout(t); resolve() }) })
      }
      return reply(pending())
    }
    reply(fakeResult(method, body))
  })
})

function sendCommand(text) {
  const command = text.split(' ')[0]
  updates.push({
    update_id: nextUpdateId++,
    message: {
      message_id: nextUpdateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: SMOKE_USER.id, type: 'private', first_name: SMOKE_USER.first_name },
      from: SMOKE_USER,
      text,
      entities: [{ type: 'bot_command', offset: 0, length: command.length }]
    }
  })
  const w = waiters; waiters = []; w.forEach(fn => fn())
}

async function waitForReply(sinceIndex, predicate) {
  const deadline = Date.now() + REPLY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const hit = sent.slice(sinceIndex).find(m => m.chatId === String(SMOKE_USER.id) && predicate(m.text))
    if (hit) return hit
    await sleep(200)
  }
  return null
}

// ---------- prepare local infra ----------
function run(cmd, args, env) {
  const r = spawnSync(cmd, args, { cwd: ROOT, env, encoding: 'utf8', shell: process.platform === 'win32' })
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}` }
}

const baseEnv = {}
for (const k of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'windir']) {
  if (process.env[k]) baseEnv[k] = process.env[k]
}

console.log(`Smoke DB: ${db.hostname}:${db.port}/${db.pathname.slice(1)}  Redis: ${rd.hostname}:${rd.port}`)

// Mirror the Docker build, which runs `prisma generate`, so a stale local client cannot hide or fake errors.
const gen = run('npx', ['prisma', 'generate'], { ...baseEnv, DATABASE_URL })
record('prisma client generated (as in the Docker build)', gen.ok, gen.ok ? '' : gen.out.trim().split('\n').slice(-3).join(' | '))
if (!gen.ok) finish()

const push = run('npx', ['prisma', 'db', 'push', '--skip-generate', '--force-reset'], { ...baseEnv, DATABASE_URL })
record('schema applied to local smoke database', push.ok, push.ok ? '' : push.out.trim().split('\n').slice(-3).join(' | '))
if (!push.ok) finish()

try {
  const r = new Redis(REDIS_URL, { family: 0, lazyConnect: true, maxRetriesPerRequest: 1 })
  await r.connect(); await r.flushdb(); r.disconnect()
  record('local smoke Redis reachable and flushed', true)
} catch (e) {
  record('local smoke Redis reachable and flushed', false, e.message)
  finish()
}

await new Promise(r => fakeApi.listen(0, '127.0.0.1', r))
const apiRoot = `http://127.0.0.1:${fakeApi.address().port}`

// ---------- boot the app ----------
const appEnv = {
  ...baseEnv,
  DOTENV_CONFIG_PATH: path.join(ROOT, 'scripts', '.smoke-no-dotenv'), // never load the real .env
  NODE_ENV: 'development',
  PORT: String(APP_PORT),
  DATABASE_URL,
  REDIS_URL,
  TELEGRAM_BOT_TOKEN: '123456:SMOKE-FAKE-TOKEN',
  TELEGRAM_API_ROOT: apiRoot,
  WHATSAPP_ENABLED: 'false',
  ADMIN_TELEGRAM_IDS: '',
  PAYSTACK_SECRET_KEY: 'sk_test_smoke_fake',
  RUNPOD_API_KEY: 'smoke-fake',
  RUNPOD_API_URL: 'http://127.0.0.1:9', // nothing listens here: the smoke run never reaches RunPod
  VAST_API_URL: 'http://127.0.0.1:9',
  VAST_API_KEY: 'smoke-fake',
  OPENAI_API_KEY: 'smoke-fake',
  HF_TOKEN: 'smoke-fake',
  JWT_SECRET: 'smoke-fake-jwt-secret',
  ADMIN_API_KEY: 'smoke-fake'
}

// @prisma/client loads the project's .env by itself on import, which would quietly pull real
// values (VAPID, SMTP, ...) into the smoke run. dotenv-style loaders never override a variable
// that is already set, so every name in .env that is not faked above is set to empty.
// Only the NAMES are read from .env; values are never read or printed.
let blanked = 0
try {
  const { readFileSync } = await import('node:fs')
  for (const line of readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (m && !(m[1] in appEnv)) { appEnv[m[1]] = ''; blanked++ }
  }
} catch { /* no .env file: nothing to shadow */ }
console.log(`Real .env values shadowed: ${blanked} name(s) set empty; provider keys are fake.`)

const logs = []
const errors = []
const warnings = []
const ERROR_PATTERN = /error|ERR_|Unhandled|ReferenceError|TypeError|SyntaxError|ECONNREFUSED|ENOTFOUND|failed/i

const app = spawn(process.execPath, ['src/index.js'], { cwd: ROOT, env: appEnv })
let exited = null
app.on('exit', code => { exited = code })
const onLine = stream => data => {
  for (const line of String(data).split(/\r?\n/).filter(Boolean)) {
    logs.push(line)
    // The app's own config warnings ("⚠️ ...") are reported but do not fail the run.
    if (line.startsWith('⚠️')) warnings.push(line)
    else if (stream === 'stderr' || ERROR_PATTERN.test(line)) errors.push(`[${stream}] ${line}`)
  }
}
app.stdout.on('data', onLine('stdout'))
app.stderr.on('data', onLine('stderr'))

async function waitForLog(text) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline && exited === null) {
    if (logs.some(l => l.includes(text))) return true
    await sleep(250)
  }
  return logs.some(l => l.includes(text))
}

for (const marker of ['VoltCore Telegram bot active', 'VoltCore server on port', 'Job poller started']) {
  const ok = await waitForLog(marker)
  record(`log: "${marker}"`, ok, ok ? '' : exited !== null ? `(app exited with code ${exited})` : '(timed out)')
}

if (exited === null) {
  const health = await new Promise(resolve => {
    http.get(`http://127.0.0.1:${APP_PORT}/health`, res => resolve(res.statusCode)).on('error', e => resolve(e.message))
  })
  record('GET /health returns 200', health === 200, health === 200 ? '' : `got ${health}`)

  const checks = [
    ['/start', 'replies with the GPU menu', t => /GPU Menu/i.test(t)],
    ['/balance', 'replies with the wallet balance', t => /balance/i.test(t) && /₦/.test(t)],
    ['/transactions', 'replies with wallet history', t => /balance/i.test(t) && !/^Error/i.test(t)]
  ]
  for (const [cmd, label, predicate] of checks) {
    const since = sent.length
    sendCommand(cmd)
    const hit = await waitForReply(since, predicate)
    const other = hit ? '' : (sent.slice(since).map(m => m.text.split('\n')[0]).join(' / ') || 'no reply')
    record(`${cmd} ${label}`, Boolean(hit), hit ? '' : `got: ${other}`)
  }

  await sleep(SETTLE_MS) // let background jobs run once and surface errors
}

record('no runtime errors logged', errors.length === 0, errors.length ? `${errors.length} error line(s), listed below` : '')
finish()

function finish() {
  try { app?.kill() } catch {}
  try { fakeApi.close() } catch {}
  if (process.env.SMOKE_VERBOSE) {
    console.log('\nApp log:')
    for (const l of logs) console.log('  | ' + l)
  }
  if (warnings?.length) {
    console.log('\nConfig warnings (not failures):')
    for (const w of [...new Set(warnings)]) console.log('  ' + w)
  }
  if (errors.length) {
    console.log('\nRuntime errors:')
    for (const e of [...new Set(errors)]) console.log('  ' + e)
  }
  const failed = results.filter(r => !r.ok)
  console.log(`\nSmoke ${failed.length ? 'FAILED' : 'PASSED'}: ${results.length - failed.length}/${results.length} checks`)
  process.exit(failed.length ? 1 : 0)
}
