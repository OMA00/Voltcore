import bcrypt from 'bcrypt'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { prisma } from '../db/prisma.js'

// Railway does not set NODE_ENV by itself, so its own environment variable also counts.
export const IS_PRODUCTION = process.env.NODE_ENV === 'production' ||
  Boolean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT)

// JWT_SECRET signs login tokens. It used to fall back to a fixed string written in this
// file, so anyone who read the code could forge a login for any user if the variable was
// missing. Production now refuses to start without it. Locally, a random secret is made
// per run (tokens stop working after a restart, which is fine for development).
if (!process.env.JWT_SECRET && IS_PRODUCTION) {
  throw new Error('JWT_SECRET is not set. Refusing to start in production without it.')
}
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex')
if (!process.env.JWT_SECRET) console.warn('⚠️ JWT_SECRET not set – using a random secret for this run (development only)')
const JWT_EXPIRES = '7d'
const SALT_ROUNDS = 10

/**
 * Register a new user via email/password
 */
export async function registerUser(email, password, firstName = null, lastName = null) {
  if (!email || !password) throw new Error('Email and password required')
  if (password.length < 8) throw new Error('Password must be at least 8 characters')

  const existing = await prisma.user.findFirst({ where: { email } })
  if (existing) throw new Error('Email already registered')

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS)

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      firstName,
      lastName,
      wallet: { create: { balance: 0 } }
    }
  })

  const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES
  })

  console.log(`👤 User registered: ${email}`)
  return { user, token }
}

/**
 * Login with email/password
 */
export async function loginUser(email, password) {
  const user = await prisma.user.findFirst({ where: { email } })
  if (!user || !user.passwordHash) throw new Error('Invalid credentials')

  const valid = await bcrypt.compare(password, user.passwordHash)
  if (!valid) throw new Error('Invalid credentials')

  await prisma.user.update({
    where: { id: user.id },
    data: { lastActiveAt: new Date() }
  })

  const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES
  })

  return { user, token }
}

/**
 * Verify JWT and return user
 */
export async function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } })
    return user
  } catch (err) {
    return null
  }
}

/**
 * Middleware: require auth
 */
export async function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '')

  if (!token) return res.status(401).json({ error: 'Unauthorized' })

  const user = await verifyToken(token)
  if (!user) return res.status(401).json({ error: 'Invalid or expired token' })

  req.user = user
  next()
}

export { JWT_SECRET }