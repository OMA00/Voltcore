import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { prisma } from '../db/prisma.js'

const JWT_SECRET = process.env.JWT_SECRET || 'voltcore-dev-secret'
const JWT_EXPIRES = '7d'
const SALT_ROUNDS = 10

/**
 * Register a new user via email/password
 */
export async function registerUser(email, password, firstName = null, lastName = null) {
  if (!email || !password) throw new Error('Email and password required')
  if (password.length < 8) throw new Error('Password must be at least 8 characters')

  const existing = await prisma.user.findUnique({ where: { email } })
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
  const user = await prisma.user.findUnique({ where: { email } })
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