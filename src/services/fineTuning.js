import { prisma } from '../db/prisma.js'
import { deployInferencePod } from './inference.js'

/**
 * Queue a fine-tuning job
 */
export async function queueFineTuneJob(userId, modelName, datasetUrl, datasetSize) {
  const model = await prisma.model.findUnique({ where: { name: modelName } })
  if (!model) throw new Error(`Model not found: ${modelName}`)

  const job = await prisma.fineTuneJob.create({
    data: {
      modelId: model.id,
      userId,
      datasetUrl,
      datasetSize,
      status: 'pending'
    }
  })

  console.log(`🎓 Fine-tune job queued: ${job.id} for ${modelName}`)
  return job
}

/**
 * Process a fine-tuning job (called by worker)
 */
export async function processFineTuneJob(jobId) {
  const job = await prisma.fineTuneJob.findUnique({
    where: { id: jobId },
    include: { model: true }
  })

  if (!job) throw new Error(`Fine-tune job not found: ${jobId}`)

  console.log(`🎓 Processing fine-tune job: ${jobId}`)

  await prisma.fineTuneJob.update({
    where: { id: jobId },
    data: { status: 'training', startedAt: new Date(), progress: 10 }
  })

  try {
    // Step 1: Deploy training pod
    const pod = await deployInferencePod(job.model.baseModel, 'a100')

    await prisma.fineTuneJob.update({
      where: { id: jobId },
      data: { progress: 30, providerJobId: pod.id }
    })

    // Step 2: Download dataset, train
    // (In production: use RunPod API with training script)
    await new Promise(resolve => setTimeout(resolve, 5000)) // Simulate training

    await prisma.fineTuneJob.update({
      where: { id: jobId },
      data: { progress: 70 }
    })

    // Step 3: Save model (simulated)
    await new Promise(resolve => setTimeout(resolve, 5000))

    // Step 4: Mark complete
    await prisma.fineTuneJob.update({
      where: { id: jobId },
      data: {
        status: 'completed',
        progress: 100,
        completedAt: new Date()
      }
    })

    console.log(`✅ Fine-tune job completed: ${jobId}`)


    // In processFineTuneJob, after marking complete:

// If this is a custom model, activate it
const customModel = await prisma.customModel.findFirst({
  where: { fineTuneJobId: jobId }
})

if (customModel) {
  const { activateCustomModel } = await import('./customModel.js')
  await activateCustomModel(customModel.id, `https://${customModel.smeId}.voltcore.africa/v1`)
}

    // Notify user
    await notifyUser(job.userId,
      `✅ *Fine-tuning Complete!*\n\n` +
      `Model: ${job.model.displayName}\n` +
      `Job: ${job.id.slice(0, 8)}\n\n` +
      `Your custom model is now available.`
    )

    return { success: true }
  } catch (err) {
    await prisma.fineTuneJob.update({
      where: { id: jobId },
      data: { status: 'failed', error: err.message, completedAt: new Date() }
    })
    throw err
  }
}

// userId is the DATABASE id; the messenger sends to the user's platform id (Telegram chat
// id or WhatsApp JID) through one shared client. This used to send to the database id,
// which Telegram rejects, and built a new bot + Redis connection for every message.
async function notifyUser(userId, message) {
  const { sendToUser } = await import('./messenger.js')
  await sendToUser(userId, message)
}