import { prisma } from '../db/prisma.js'
import crypto from 'crypto'
import { applyWalletChange, InsufficientBalanceError, DuplicateReferenceError } from './walletLedger.js'

import { notifyCourseCompletion } from './notifications.js'
/**
 * List published courses
 */
export async function listCourses() {
  return await prisma.course.findMany({
    where: { status: 'published' },
    include: {
      _count: { select: { lessons: true, enrollments: true } }
    },
    orderBy: { createdAt: 'desc' }
  })
}

/**
 * Get course details with lessons
 */
export async function getCourse(slug) {
  return await prisma.course.findUnique({
    where: { slug },
    include: {
      lessons: { orderBy: { order: 'asc' } },
      _count: { select: { enrollments: true } }
    }
  })
}

/**
 * Enroll user in a course (charges credits if priced)
 */
export async function enrollUser(userId, courseId) {
  const course = await prisma.course.findUnique({ where: { id: courseId } })
  if (!course) throw new Error('Course not found')
  if (course.status !== 'published') throw new Error('Course not available')

  const existing = await prisma.enrollment.findUnique({
    where: { userId_courseId: { userId, courseId } }
  })
  if (existing) throw new Error('Already enrolled')

  // Charge credits if priced: enrollment and payment commit together, once per course.
  if (course.priceNGN > 0) {
    try {
      await prisma.$transaction(async tx => {
        await tx.enrollment.create({ data: { userId, courseId, status: 'active' } })
        await applyWalletChange(userId, 'course_payment', -course.priceNGN, {
          reference: `course_${userId}_${courseId}`,
          description: `Course: ${course.title}`,
          tx
        })
      })
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        throw new Error(`Insufficient balance. Need ₦${course.priceNGN.toLocaleString()}`)
      }
      throw err
    }
  } else {
    await prisma.enrollment.create({
      data: { userId, courseId, status: 'active' }
    })
  }

  console.log(`🎓 User ${userId} enrolled in ${course.title}`)
  return { success: true }
}


/**
 * Mark a lesson as completed
 */
export async function completeLesson(userId, lessonId) {
  const lesson = await prisma.lesson.findUnique({
    where: { id: lessonId },
    include: { course: true }
  })
  if (!lesson) throw new Error('Lesson not found')

  const enrollment = await prisma.enrollment.findUnique({
    where: { userId_courseId: { userId, courseId: lesson.courseId } }
  })
  if (!enrollment) throw new Error('Not enrolled in this course')

  // Mark lesson complete
  await prisma.lessonProgress.upsert({
    where: { lessonId_userId: { lessonId, userId } },
    create: { lessonId, userId, completed: true, completedAt: new Date() },
    update: { completed: true, completedAt: new Date() }
  })

  // Recalculate progress
  const totalLessons = await prisma.lesson.count({ where: { courseId: lesson.courseId } })
  const completedLessons = await prisma.lessonProgress.count({
    where: { userId, lesson: { courseId: lesson.courseId }, completed: true }
  })

  const progress = Math.round((completedLessons / totalLessons) * 100)

  // Update enrollment
  const status = progress === 100 ? 'completed' : 'active'
  await prisma.enrollment.update({
    where: { id: enrollment.id },
    data: {
      progress,
      status,
      completedAt: progress === 100 ? new Date() : null
    }
  })

  // Issue certificate on completion
  if (progress === 100) {
    const certCode = crypto.randomBytes(8).toString('hex').toUpperCase()
    await prisma.certificate.create({
      data: { userId, courseId: lesson.courseId, code: certCode }
    })

    // Reward credits on completion (once per course)
    await applyWalletChange(userId, 'course_reward', 500, {
      reference: `course_reward_${userId}_${lesson.courseId}`,
      description: `Completed: ${lesson.course.title}`
    }).catch(err => { if (!(err instanceof DuplicateReferenceError)) throw err })

    console.log(`🏆 User ${userId} completed ${lesson.course.title}. Certificate: ${certCode}`)

    // Moved here from module top level, where userId/lesson/certCode did not exist.
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } })
      if (user) await notifyCourseCompletion(user, lesson.course, certCode)
    } catch (e) {
      console.error('Course completion notification failed:', e.message)
    }

    return { success: true, progress, completed: true, certificate: certCode, reward: 500 }
  }

  return { success: true, progress, completed: false }
}

/**
 * Get user's enrollments
 */
export async function getUserEnrollments(userId) {
  return await prisma.enrollment.findMany({
    where: { userId },
    include: {
      course: { include: { _count: { select: { lessons: true } } } }
    },
    orderBy: { enrolledAt: 'desc' }
  })
}

/**
 * Get enrollment progress with lessons
 */
export async function getEnrollmentProgress(userId, courseId) {
  const enrollment = await prisma.enrollment.findUnique({
    where: { userId_courseId: { userId, courseId } },
    include: {
      course: {
        include: {
          lessons: {
            orderBy: { order: 'asc' },
            include: {
              progress: { where: { userId } }
            }
          }
        }
      }
    }
  })

  return enrollment
}

/**
 * Get certificate
 */
export async function getCertificate(code) {
  return await prisma.certificate.findUnique({
    where: { code },
    include: {
      user: { select: { firstName: true, lastName: true } }
    }
  })
}
