const express = require('express')
const { z } = require('zod')
const prisma = require('../lib/prisma')
const { verifyJWT, requireRole } = require('../middleware/auth')
const { programIsolation } = require('../middleware/programIsolation')

const router = express.Router()

// GET /api/v1/courses/programs/:pid — list courses in a program
router.get('/programs/:pid', verifyJWT, programIsolation, async (req, res, next) => {
  try {
    const courses = await prisma.course.findMany({
      where: { program_id: req.programId, is_published: true },
      include: { _count: { select: { modules: true } } },
      orderBy: { order_index: 'asc' },
    })
    res.json(courses)
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/courses/programs/:pid/:id — course detail
router.get('/programs/:pid/:id', verifyJWT, programIsolation, async (req, res, next) => {
  try {
    const course = await prisma.course.findFirst({
      where: { id: req.params.id, program_id: req.programId },
      include: {
        modules: {
          orderBy: { order_index: 'asc' },
          include: {
            lessons: {
              orderBy: { order_index: 'asc' },
              include: { video: true },
            },
          },
        },
      },
    })
    if (!course) return res.status(404).json({ error: 'Course not found' })

    // Attach user progress
    const progress = await prisma.lessonProgress.findMany({
      where: { user_id: req.user.id, program_id: req.programId },
      select: { lesson_id: true, completed: true },
    })
    const progressMap = Object.fromEntries(progress.map((p) => [p.lesson_id, p.completed]))

    res.json({ ...course, progressMap })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/courses/programs/:pid — create course
router.post(
  '/programs/:pid',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      const data = z
        .object({
          title: z.string().min(1),
          description: z.string().default(''),
          order_index: z.number().int().default(0),
          is_published: z.boolean().default(false),
        })
        .parse(req.body)

      const course = await prisma.course.create({
        data: { ...data, program_id: req.programId },
      })
      res.status(201).json(course)
    } catch (err) {
      next(err)
    }
  }
)

// POST /api/v1/courses/programs/:pid/lessons/:lessonId/progress
router.post(
  '/programs/:pid/lessons/:lessonId/progress',
  verifyJWT,
  programIsolation,
  async (req, res, next) => {
    try {
      const { completed } = z.object({ completed: z.boolean() }).parse(req.body)

      const lesson = await prisma.lesson.findUnique({
        where: { id: req.params.lessonId },
        include: { module: { include: { course: true } } },
      })
      if (!lesson || lesson.module.course.program_id !== req.programId) {
        return res.status(404).json({ error: 'Lesson not found in this program' })
      }

      const progress = await prisma.lessonProgress.upsert({
        where: {
          user_id_lesson_id_program_id: {
            user_id: req.user.id,
            lesson_id: req.params.lessonId,
            program_id: req.programId,
          },
        },
        update: { completed, completed_at: completed ? new Date() : null },
        create: {
          user_id: req.user.id,
          lesson_id: req.params.lessonId,
          program_id: req.programId,
          completed,
          completed_at: completed ? new Date() : null,
        },
      })
      res.json(progress)
    } catch (err) {
      next(err)
    }
  }
)

module.exports = router
