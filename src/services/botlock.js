// ============================================================
// Telegram poller lock: only one running instance may poll Telegram.
//
// During a Railway deploy the old and new containers overlap for a while. Two pollers
// on one bot token make Telegram answer 409 Conflict, which crashed the launch. The new
// instance now waits for this Redis lock; the old one releases it on shutdown (or it
// expires LOCK_TTL_MS after a crash).
// ============================================================
import { randomUUID } from 'node:crypto'
import { createRedis } from '../db/redis.js'

const KEY = 'voltcore:telegram-poller-lock'
export const LOCK_TTL_MS = 30_000
const RENEW_MS = 10_000
const RETRY_MS = 5_000

const RENEW = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

/**
 * Wait until this instance holds the lock, then keep renewing it.
 * @param {{ onLost?: () => void }} options  called if another instance takes the lock
 * @returns {Promise<() => Promise<void>>} release function
 */
export async function acquireBotLock({ onLost = () => process.exit(1), redis = createRedis(), retryMs = RETRY_MS } = {}) {
  const id = randomUUID()
  let waitingLogged = false
  while (!(await redis.set(KEY, id, 'PX', LOCK_TTL_MS, 'NX'))) {
    if (!waitingLogged) { console.log('⏳ Another instance is polling Telegram; waiting for it to stop'); waitingLogged = true }
    await new Promise(r => setTimeout(r, retryMs))
  }

  const timer = setInterval(async () => {
    try {
      if ((await redis.eval(RENEW, 1, KEY, id, LOCK_TTL_MS)) === 0) {
        clearInterval(timer)
        console.error('Telegram poller lock was lost to another instance; stopping this one')
        onLost()
      }
    } catch (err) {
      console.error('Telegram poller lock renew failed:', err.message)
    }
  }, RENEW_MS)
  timer.unref?.()

  return async function release() {
    clearInterval(timer)
    try { await redis.eval(RELEASE, 1, KEY, id) } catch {}
  }
}
