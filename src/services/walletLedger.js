import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../db/prisma.js'

// ============================================================
// Wallet ledger: the ONLY place a wallet balance may change.
//
// Every change is one database transaction that
//   1. moves the balance with a conditional update (a debit never takes the balance
//      below zero: pre-pay only, no credit), and
//   2. writes a WalletLedger audit row whose `reference` is unique.
// Repeating a reference fails and changes nothing, so retries, duplicate webhooks
// and double clicks cannot apply the same money twice.
// ============================================================

export class InsufficientBalanceError extends Error {
  constructor(balance, required) {
    super(`Insufficient balance. Current: ₦${balance}, Required: ₦${required}`)
    this.name = 'InsufficientBalanceError'
    this.balance = balance
    this.required = required
  }
}

export class DuplicateReferenceError extends Error {
  constructor(reference) {
    super(`Wallet change already applied for reference ${reference}`)
    this.name = 'DuplicateReferenceError'
    this.reference = reference
  }
}

/**
 * Apply one wallet change with its audit row, atomically.
 * @param {string} userId
 * @param {string} type        ledger type, e.g. topup, job_debit, refund
 * @param {number} amountNGN   > 0 credits, < 0 debits
 * @param {object} options     { reference (required, unique per real event), description, metadata, tx }
 *                             Pass `tx` to join a caller's transaction, so the wallet change
 *                             commits or rolls back together with the caller's other writes.
 */
export async function applyWalletChange(userId, type, amountNGN, options = {}) {
  const { reference, description = null, metadata = null, tx } = options
  if (!reference) throw new Error('applyWalletChange: reference is required')
  if (!Number.isFinite(amountNGN) || amountNGN === 0) {
    throw new Error(`applyWalletChange: amount must be a non-zero number, got ${amountNGN}`)
  }

  const db = tx || prisma
  const metaJson = metadata ? JSON.stringify(metadata) : null

  // One SQL statement, so Postgres applies it atomically without holding a pooled
  // connection across round trips (interactive transactions starved the pool under
  // concurrent debits: Prisma P2028).
  //  - The UPDATE only matches when a debit is covered (balance >= amount). Concurrent
  //    debits queue on the row lock and each re-checks against the committed balance.
  //  - The INSERT uses the balance the UPDATE returned. If the reference already exists,
  //    the unique index fails the whole statement and the balance change is undone too.
  let rows
  try {
    rows = await db.$queryRaw(Prisma.sql`
      WITH w AS (
        UPDATE "CreditWallet"
           SET "balance" = "balance" + ${amountNGN}, "updatedAt" = now()
         WHERE "userId" = ${userId}
           AND (${amountNGN}::float8 >= 0 OR "balance" >= ${-amountNGN})
        RETURNING "balance"
      )
      INSERT INTO "WalletLedger" ("id", "userId", "type", "amountNGN", "balanceAfter", "reference", "description", "metadata", "createdAt")
      SELECT ${randomUUID()}, ${userId}, ${type}, ${amountNGN}, w."balance", ${reference}, ${description}, ${metaJson}, now()
        FROM w
      RETURNING "id", "balanceAfter"`)
  } catch (err) {
    if (isUniqueViolation(err)) throw new DuplicateReferenceError(reference)
    throw err
  }

  if (rows.length !== 1) {
    const wallet = await db.creditWallet.findUnique({ where: { userId } })
    if (!wallet) throw new Error('Wallet not found')
    throw new InsufficientBalanceError(wallet.balance, Math.abs(amountNGN))
  }

  const newBalance = rows[0].balanceAfter
  console.log(`💰 Ledger: ${type} ${amountNGN >= 0 ? '+' : ''}₦${amountNGN} → ₦${newBalance} (${reference})`)
  return { ledgerId: rows[0].id, newBalance }
}

function isUniqueViolation(err) {
  return err?.code === 'P2002' || err?.meta?.code === '23505' || /23505|unique constraint/i.test(String(err?.message))
}

/**
 * Older name for applyWalletChange, kept for existing callers (Paystack webhook).
 */
export async function recordTransaction(userId, type, amountNGN, options = {}) {
  return applyWalletChange(userId, type, amountNGN, options)
}

/** The ledger row for a reference, or null. */
export async function findLedgerEntry(reference, db = prisma) {
  return db.walletLedger.findUnique({ where: { reference } })
}

/**
 * Get user's transaction history
 */
export async function getTransactions(userId, limit = 50) {
  return await prisma.walletLedger.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit
  })
}

/**
 * Get user's total credited and debited
 */
export async function getLedgerSummary(userId) {
  const entries = await prisma.walletLedger.findMany({
    where: { userId },
    select: { amountNGN: true, type: true }
  })

  const credited = entries.filter(e => e.amountNGN > 0).reduce((s, e) => s + e.amountNGN, 0)
  const debited = entries.filter(e => e.amountNGN < 0).reduce((s, e) => s + Math.abs(e.amountNGN), 0)

  return {
    totalCredited: credited,
    totalDebited: debited,
    entryCount: entries.length
  }
}
