import express from 'express'
import { registerUser, loginUser, requireAuth } from '../services/auth.js'
import { prisma } from '../db/prisma.js'

const router = express.Router()

// ============================================================
// POST /api/auth/register
// ============================================================
router.post('/register', async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' })
    }

    const { user, token } = await registerUser(email, password, firstName, lastName)

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    })

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName
      }
    })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ============================================================
// POST /api/auth/login
// ============================================================
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' })
    }

    const { user, token } = await loginUser(email, password)

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    })

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName
      }
    })
  } catch (err) {
    res.status(401).json({ error: err.message })
  }
})

// ============================================================
// POST /api/auth/logout
// ============================================================
router.post('/logout', (req, res) => {
  res.clearCookie('token')
  res.json({ success: true })
})

// ============================================================
// GET /api/auth/me
// ============================================================
router.get('/me', requireAuth, async (req, res) => {
  const wallet = await prisma.creditWallet.findUnique({
    where: { userId: req.user.id }
  })

  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      referralCode: req.user.referralCode,
      maxConcurrentJobs: req.user.maxConcurrentJobs,
      createdAt: req.user.createdAt
    },
    wallet: { balance: wallet?.balance || 0 }
  })
})

export default router