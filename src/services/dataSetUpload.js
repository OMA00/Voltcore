import { prisma } from '../db/prisma.js'
import fs from 'fs/promises'
import path from 'path'

const UPLOAD_DIR = path.join(process.cwd(), 'uploads')

/**
 * Ensure upload directory exists
 */
async function ensureUploadDir() {
  try {
    await fs.mkdir(UPLOAD_DIR, { recursive: true })
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
}

/**
 * Save dataset file and create database record
 */
export async function saveDataset(smeId, fileName, fileBuffer, format = 'jsonl') {
  await ensureUploadDir()

  const timestamp = Date.now()
  const safeName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_')
  const savedName = `${smeId}-${timestamp}-${safeName}`
  const filePath = path.join(UPLOAD_DIR, savedName)

  // Write file
  await fs.writeFile(filePath, fileBuffer)

  // Count rows
  let rowCount = 0
  try {
    const content = fileBuffer.toString('utf8')
    rowCount = format === 'csv' 
      ? content.split('\n').filter(l => l.trim()).length - 1
      : content.split('\n').filter(l => l.trim()).length
  } catch (err) {
    console.error('Row count error:', err)
  }

  // Create DB record
  const dataset = await prisma.dataset.create({
    data: {
      smeId,
      name: fileName,
      fileUrl: filePath,
      fileSize: fileBuffer.length,
      rowCount,
      format,
      status: 'uploaded'
    }
  })

  console.log(`📂 Dataset saved: ${fileName} (${rowCount} rows) for SME ${smeId}`)

  return dataset
}

/**
 * Validate dataset format
 */
export async function validateDataset(datasetId) {
  const dataset = await prisma.dataset.findUnique({ where: { id: datasetId } })
  if (!dataset) throw new Error('Dataset not found')

  try {
    const content = await fs.readFile(dataset.fileUrl, 'utf8')
    const lines = content.split('\n').filter(l => l.trim())

    if (lines.length < 10) {
      throw new Error('Dataset must have at least 10 rows')
    }

    // Validate JSONL format
    if (dataset.format === 'jsonl') {
      for (const line of lines.slice(0, 5)) {
        JSON.parse(line)
      }
    }

    await prisma.dataset.update({
      where: { id: datasetId },
      data: { status: 'validated' }
    })

    console.log(`✅ Dataset ${datasetId} validated (${lines.length} rows)`)
    return { valid: true, rowCount: lines.length }
  } catch (err) {
    await prisma.dataset.update({
      where: { id: datasetId },
      data: { status: 'error', error: err.message }
    })
    throw err
  }
}

/**
 * Get datasets for an SME
 */
export async function getSmeDatasets(smeId) {
  return await prisma.dataset.findMany({
    where: { smeId },
    orderBy: { createdAt: 'desc' }
  })
}