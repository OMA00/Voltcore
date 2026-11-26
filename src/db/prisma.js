import { PrismaClient } from '@prisma/client'

// Standard Prisma client. The connection string comes from `url = env("DATABASE_URL")`
// in prisma/schema.prisma.
//
// This used to wrap @prisma/adapter-pg, which could not work as written: in Prisma 5.22
// PrismaPg must be given a pg.Pool (not a config object), and adapters also require
// previewFeatures = ["driverAdapters"] in the schema, which was never set.
export const prisma = new PrismaClient()
