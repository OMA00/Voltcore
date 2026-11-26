import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

// Load services/auth.js in a fresh process with a controlled environment.
function loadAuth(extraEnv) {
  const env = { ...process.env, ...extraEnv }
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete env[k]
  return spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/services/auth.js'); console.log('loaded')"], { env, encoding: 'utf8' })
}

test('production refuses to start without JWT_SECRET (Railway sets no NODE_ENV)', () => {
  const r = loadAuth({ JWT_SECRET: '', NODE_ENV: undefined, RAILWAY_ENVIRONMENT_NAME: 'production' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /JWT_SECRET is not set/)
})

test('NODE_ENV=production also refuses without JWT_SECRET', () => {
  const r = loadAuth({ JWT_SECRET: '', NODE_ENV: 'production', RAILWAY_ENVIRONMENT_NAME: undefined })
  assert.notEqual(r.status, 0)
})

test('production starts when JWT_SECRET is set', () => {
  const r = loadAuth({ JWT_SECRET: 'test-only-secret', RAILWAY_ENVIRONMENT_NAME: 'production' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /loaded/)
})

test('development without JWT_SECRET starts with a per-run random secret, not a fixed one', () => {
  const r = loadAuth({ JWT_SECRET: '', NODE_ENV: 'development', RAILWAY_ENVIRONMENT_NAME: undefined, RAILWAY_ENVIRONMENT: undefined })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /random secret/)
})
