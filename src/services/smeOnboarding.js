import { prisma } from '../db/prisma.js'

/**
 * Create a new SME for a user
 */
export async function createSme(userId, name, industry = null, description = null) {
  const sme = await prisma.sme.create({
    data: {
      userId,
      name,
      industry,
      description,
      status: 'onboarding'
    }
  })

  console.log(`🏢 SME created: ${name} for ${userId}`)
  return sme
}

/**
 * Get user's SMEs
 */
export async function getUserSmes(userId) {
  return await prisma.sme.findMany({
    where: { userId },
    include: {
      _count: { select: { datasets: true, customModels: true } }
    },
    orderBy: { createdAt: 'desc' }
  })
}

/**
 * Get SME details with datasets and models
 */
export async function getSmeDetails(smeId, userId) {
  return await prisma.sme.findFirst({
    where: { id: smeId, userId },
    include: {
      datasets: true,
      customModels: {
        include: { fineTuneJob: true }
      }
    }
  })
}

/**
 * Update SME status
 */
export async function updateSmeStatus(smeId, status) {
  return await prisma.sme.update({
    where: { id: smeId },
    data: { status }
  })
}