// ============================================================
// Shared Redis connection factory
// ------------------------------------------------------------
// Every Redis connection in the app is built here, so the Railway-specific
// options live in one place:
//
//   family: 0  Railway's private network (*.railway.internal) resolves over
//              IPv6. ioredis defaults to IPv4 only (family 4), which fails with
//              ENOTFOUND. family: 0 lets DNS return either.
//
//   maxRetriesPerRequest: null  Required by BullMQ for its blocking
//              connections. Without it, workers throw when Redis blips.
//
// Before this file, BullMQ was given `{ url: REDIS_URL }`. Neither BullMQ nor
// ioredis reads a `url` option, so every queue and worker silently connected
// to localhost:6379 instead of REDIS_URL.
// ============================================================
import { Redis as IORedis } from 'ioredis'
import { createClient } from 'redis'
import { Redis as TelegrafRedisStore } from '@telegraf/session/redis'

function redisUrl() {
  const url = process.env.REDIS_URL
  if (!url) throw new Error('REDIS_URL is not set')
  return url
}

/** General-purpose ioredis client (caches, app sessions). */
export function createRedis(options = {}) {
  return new IORedis(redisUrl(), { family: 0, ...options })
}

/**
 * Connection for a BullMQ Queue or Worker. Give each Worker its own:
 * workers hold blocking commands open, so they cannot share one connection.
 */
export function createBullConnection() {
  return createRedis({ maxRetriesPerRequest: null })
}

let telegrafStore = null

/**
 * Telegraf session store, created once per process.
 * @telegraf/session uses the `redis` (node-redis) package, not ioredis, so the
 * IPv6 option is socket.family there. The store calls connect() when it is
 * built, so it must be a singleton: initTelegramBot() runs in several places.
 */
export function getTelegrafSessionStore() {
  if (!telegrafStore) {
    const client = createClient({ url: redisUrl(), socket: { family: 0 } })
    client.on('error', err => console.error('Telegraf session Redis error:', err.message))
    telegrafStore = TelegrafRedisStore({ client })
  }
  return telegrafStore
}
