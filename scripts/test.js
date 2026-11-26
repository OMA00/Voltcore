#!/usr/bin/env node
/**
 * VoltCore money-path tests:  npm test
 *
 * Runs test/*.test.js with node:test against a LOCAL throwaway Postgres database.
 * Default: postgresql://voltcore@localhost:55432/voltcore_test_smoke  (override: TEST_DATABASE_URL)
 *
 * Safety: refuses unless the database is on localhost and named *_smoke, because the schema
 * is force-reset before the run. The real .env is shadowed (names only are read), so no
 * real keys or production URLs reach the tests.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://voltcore@localhost:55432/voltcore_test_smoke'
const db = new URL(DATABASE_URL)
const dbName = db.pathname.slice(1)

if (!['localhost', '127.0.0.1', '::1'].includes(db.hostname) || !dbName.endsWith('_smoke')) {
  console.error('Refusing to run: TEST_DATABASE_URL must be on localhost and the database name must end in "_smoke".')
  process.exit(2)
}

if (process.env.TEST_REDIS_URL && !['localhost', '127.0.0.1', '::1'].includes(new URL(process.env.TEST_REDIS_URL).hostname)) {
  console.error('Refusing to run: TEST_REDIS_URL must be on localhost.')
  process.exit(2)
}

// Create the test database if it does not exist.
const admin = new URL(DATABASE_URL); admin.pathname = '/postgres'
const client = new pg.Client({ connectionString: admin.toString() })
await client.connect()
const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])
if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`)
await client.end()

const env = {}
for (const k of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'windir']) {
  if (process.env[k]) env[k] = process.env[k]
}
Object.assign(env, {
  DOTENV_CONFIG_PATH: path.join(ROOT, 'scripts', '.smoke-no-dotenv'),
  NODE_ENV: 'test',
  DATABASE_URL,
  // Local smoke Redis, database 1 (the smoke test uses database 0). Only the bot-lock test uses it.
  REDIS_URL: process.env.TEST_REDIS_URL || 'redis://127.0.0.1:56379/1',
  PAYSTACK_SECRET_KEY: 'sk_test_money_path_fake',
  TELEGRAM_BOT_TOKEN: '123456:TEST-FAKE',
  TELEGRAM_API_ROOT: 'http://127.0.0.1:9', // nothing listens here: tests never reach the real Telegram API
  JWT_SECRET: 'test-fake-jwt-secret'
})
// @prisma/client loads .env on import; shadow every real name so none leak in.
try {
  for (const line of readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (m && !(m[1] in env)) env[m[1]] = ''
  }
} catch {}

const shell = process.platform === 'win32'
const push = spawnSync('npx', ['prisma', 'db', 'push', '--force-reset', '--skip-generate'], { cwd: ROOT, env, encoding: 'utf8', shell })
if (push.status !== 0) {
  console.error('Could not prepare the test database:\n' + (push.stdout || '') + (push.stderr || ''))
  process.exit(1)
}

const files = readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js')).map(f => path.join('test', f))
const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: ROOT, env, stdio: 'inherit' })
process.exit(run.status ?? 1)
