import { v4 as uuidv4 } from 'uuid'
import { prisma } from '../db/prisma.js'

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'info']

/**
 * Structured logger with correlation ID
 */
export function createLogger(context = {}) {
  const correlationId = context.correlationId || uuidv4()

  function log(level, message, meta = {}) {
    if (LOG_LEVELS[level] < CURRENT_LEVEL) return

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      correlationId,
      ...context,
      ...meta
    }

    // Console output (Railway captures this)
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    fn(JSON.stringify(entry))

    // Store errors in DB for admin review
    if (level === 'error') {
      storeError(entry).catch(() => {})
    }
  }

  return {
    correlationId,
    debug: (msg, meta) => log('debug', msg, meta),
    info: (msg, meta) => log('info', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    error: (msg, meta) => log('error', msg, meta),
    child: (extra) => createLogger({ ...context, ...extra, correlationId })
  }
}

/**
 * Store error in database for admin review
 */
async function storeError(entry) {
  try {
    await prisma.errorLog.create({
      data: {
        level: entry.level,
        message: entry.message,
        correlationId: entry.correlationId,
        metadata: JSON.stringify(entry),
        createdAt: new Date()
      }
    })
  } catch (err) {
    // Silent fail – don't recurse
  }
}

// Default logger
export const logger = createLogger()