import express from 'express'
import { requireAuth } from '../services/auth.js'
import {
  listCourses, getCourse, enrollUser, completeLesson,
  getUserEnrollments, getEnrollmentProgress, getCertificate
} from '../services/courses.js'

const router = express.Router()

// ============================================================
// GET /api/courses – List published courses
// ============================================================
router.get('/', async (req, res) => {
  try {
    const courses = await listCourses()
    res.json({ courses })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/courses/:slug – Course details
// ============================================================
router.get('/:slug', async (req, res) => {
  try {
    const course = await getCourse(req.params.slug)
    if (!course) return res.status(404).json({ error: 'Course not found' })
    res.json({ course })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// POST /api/courses/:id/enroll – Enroll (auth required)
// ============================================================
router.post('/:id/enroll', requireAuth, async (req, res) => {
  try {
    const result = await enrollUser(req.user.id, req.params.id)
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ============================================================
// GET /api/courses/my/enrollments – User's enrollments
// ============================================================
router.get('/my/enrollments', requireAuth, async (req, res) => {
  try {
    const enrollments = await getUserEnrollments(req.user.id)
    res.json({ enrollments })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// GET /api/courses/my/:courseId – Progress detail
// ============================================================
router.get('/my/:courseId', requireAuth, async (req, res) => {
  try {
    const enrollment = await getEnrollmentProgress(req.user.id, req.params.courseId)
    if (!enrollment) return res.status(404).json({ error: 'Not enrolled' })
    res.json({ enrollment })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// POST /api/courses/lessons/:lessonId/complete
// ============================================================
router.post('/lessons/:lessonId/complete', requireAuth, async (req, res) => {
  try {
    const result = await completeLesson(req.user.id, req.params.lessonId)
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ============================================================
// GET /api/courses/certificates/:code – Public verify
// ============================================================
router.get('/certificates/:code', async (req, res) => {
  try {
    const cert = await getCertificate(req.params.code)
    if (!cert) return res.status(404).json({ error: 'Certificate not found' })
    res.json({ certificate: cert })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router