// Shared helpers for money-path tests. Every test creates its own users, so tests
// never depend on each other's data.
import { prisma } from '../src/db/prisma.js'

let n = 0
export async function makeUser(balance = 0) {
  n++
  return prisma.user.create({
    data: {
      telegramId: `test-${process.pid}-${Date.now()}-${n}`,
      firstName: 'Test',
      wallet: { create: { balance } }
    }
  })
}

export async function balanceOf(userId) {
  const w = await prisma.creditWallet.findUnique({ where: { userId } })
  return w.balance
}

export async function ledgerOf(userId) {
  return prisma.walletLedger.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })
}

export { prisma }
