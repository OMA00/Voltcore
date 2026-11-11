import { prisma } from '../db/prisma.js'
import { queueFineTuneJob } from './fineTuning.js'

/**
 * Create a custom model for an SME
 */
export async function createCustomModel(smeId, baseModel, displayName, datasetId) {
  // Validate dataset
  const dataset = await prisma.dataset.findUnique({ where: { id: datasetId } })
  if (!dataset) throw new Error('Dataset not found')
  if (dataset.status !== 'validated') throw new Error('Dataset must be validated first')

  // Check existing models for versioning
  const existing = await prisma.customModel.findFirst({
    where: { smeId, baseModel },
    orderBy: { version: 'desc' }
  })
  const version = existing ? existing.version + 1 : 1

  // Create custom model
  const customModel = await prisma.customModel.create({
    data: {
      smeId,
      baseModel,
      displayName,
      version,
      status: 'pending'
    }
  })

  // Queue fine-tuning job
  const fineTuneJob = await queueFineTuneJob(
    (await prisma.sme.findUnique({ where: { id: smeId } })).userId,
    baseModel,
    dataset.fileUrl,
    dataset.rowCount
  )

  // Link fine-tune job to custom model
  await prisma.customModel.update({
    where: { id: customModel.id },
    data: {
      fineTuneJobId: fineTuneJob.id,
      status: 'training'
    }
  })

  console.log(`🎨 Custom model created: ${displayName} v${version}`)

  return {
    ...customModel,
    fineTuneJob
  }
}

/**
 * Mark custom model as ready
 */
export async function activateCustomModel(customModelId, endpoint) {
  const model = await prisma.customModel.update({
    where: { id: customModelId },
    data: {
      status: 'ready',
      endpoint,
      activatedAt: new Date()
    }
  })

  console.log(`✅ Custom model activated: ${model.displayName} v${model.version}`)
  return model
}

/**
 * List custom models for an SME
 */
export async function getSmeCustomModels(smeId) {
  return await prisma.customModel.findMany({
    where: { smeId },
    include: { fineTuneJob: true },
    orderBy: { createdAt: 'desc' }
  })
}

/**
 * Get custom model details
 */
export async function getCustomModel(customModelId) {
  return await prisma.customModel.findUnique({
    where: { id: customModelId },
    include: {
      sme: true,
      fineTuneJob: true
    }
  })
}