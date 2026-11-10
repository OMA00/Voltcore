import { prisma } from '../db/prisma.js'

const DEFAULT_MODELS = [
  {
    name: 'micro-gpt',
    displayName: 'Micro-GPT (SME)',
    provider: 'nemotron',
    baseModel: 'nemotron-nano',
    contextLength: 4096,
    pricePer1kTokens: 2,
    description: 'Fine-tuned for Nigerian SMEs – customer service, sales, docs'
  },
  {
    name: 'nemotron-nano',
    displayName: 'Nemotron Nano 8B',
    provider: 'nemotron',
    baseModel: 'nemotron-nano',
    contextLength: 4096,
    pricePer1kTokens: 2,
    description: 'Fast, efficient model for general tasks'
  },
  {
    name: 'nemotron-super',
    displayName: 'Nemotron Super 49B',
    provider: 'nemotron',
    baseModel: 'nemotron-super',
    contextLength: 8192,
    pricePer1kTokens: 4,
    description: 'Powerful model for complex reasoning'
  }
]

/**
 * Seed default models into the database
 */
export async function seedModels() {
  for (const model of DEFAULT_MODELS) {
    await prisma.model.upsert({
      where: { name: model.name },
      update: {},
      create: model
    })
  }
  console.log('✅ Models seeded')
}

/**
 * List all active models
 */
export async function listModels() {
  return await prisma.model.findMany({
    where: { status: 'active' },
    orderBy: { name: 'asc' }
  })
}

/**
 * Get model by name
 */
export async function getModel(name) {
  return await prisma.model.findUnique({ where: { name } })
}