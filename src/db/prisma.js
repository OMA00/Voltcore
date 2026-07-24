import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

// Create the adapter using the DATABASE_URL from environment
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
})

// Instantiate PrismaClient with the adapter
export const prisma = new PrismaClient({ adapter })
