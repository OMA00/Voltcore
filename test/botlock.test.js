import test from 'node:test'
import assert from 'node:assert/strict'
import { acquireBotLock } from '../src/services/botlock.js'
import { createRedis } from '../src/db/redis.js'

test('a second instance waits for the Telegram poller lock until the first releases it', async () => {
  const a = createRedis(), b = createRedis()
  await a.del('voltcore:telegram-poller-lock')
  try {
    const releaseFirst = await acquireBotLock({ redis: a, retryMs: 50, onLost: () => {} })
    let secondGotIt = false
    const second = acquireBotLock({ redis: b, retryMs: 50, onLost: () => {} }).then(r => { secondGotIt = true; return r })

    await new Promise(r => setTimeout(r, 300))
    assert.equal(secondGotIt, false, 'second instance must not poll while the first holds the lock')

    await releaseFirst()
    const releaseSecond = await second
    assert.equal(secondGotIt, true)
    await releaseSecond()
  } finally {
    a.disconnect(); b.disconnect()
  }
})
