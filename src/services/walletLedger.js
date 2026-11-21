import { prisma } from '../db/prisma.js'

/**
 * Record a wallet transaction and update balance atomically
 */
export async function recordTransaction(userId, type, amountNGN, options = {}) {
  const { reference = null, description = null, metadata = null } = options

  return await prisma.$transaction(async (tx) => {
    // Get current wallet
    const wallet = await tx.creditWallet.findUnique({ where: { userId } })
    if (!wallet) throw new Error('Wallet not found')

    const newBalance = wallet.balance + amountNGN
    if (newBalance < 0) {
      throw new Error(`Insufficient balance. Current: ₦${wallet.balance}, Required: ₦${Math.abs(amountNGN)}`)
    }

    // Update wallet
    await tx.creditWallet.update({
      where: { userId },
      data: { balance: newBalance }
    })

    // Record ledger entry
    const ledger = await tx.walletLedger.create({
      data: {
        userId,
        type,
        amountNGN,
        balanceAfter: newBalance,
        reference,
        description,
        metadata: metadata ? JSON.stringify(metadata) : null
      }
    })

    console.log(`💰 Ledger: ${type} ${amountNGN >= 0 ? '+' : ''}₦${amountNGN} → ₦${newBalance}`)
    return { ledger, newBalance }
  })
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