const express = require('express')
const { z } = require('zod')
const prisma = require('../lib/prisma')
const { verifyJWT, requireRole } = require('../middleware/auth')
const { auditLog } = require('../services/audit.service')

const router = express.Router()

// Helper: load lesson with its program for isolation checks
async function getLessonWithProgram(lessonId) {
  return prisma.lesson.findUnique({
    where: { id: lessonId },
    include: { module: { include: { course: { select: { program_id: true } } } } },
  })
}

function ensureProgramAccess(req, programId) {
  if (req.user.role === 'SUPER_ADMIN') return true
  return req.user.programIds.includes(programId)
}

// ─── Participant-facing ──────────────────────────────────────────────────────

// GET /api/v1/quizzes/lessons/:lessonId — fetch quiz, hide correct answers
router.get('/lessons/:lessonId', verifyJWT, async (req, res, next) => {
  try {
    const lesson = await getLessonWithProgram(req.params.lessonId)
    if (!lesson) return res.status(404).json({ error: 'Lesson not found' })
    const programId = lesson.module.course.program_id
    if (!ensureProgramAccess(req, programId)) {
      return res.status(403).json({ error: 'No access to this program' })
    }

    const quiz = await prisma.quiz.findUnique({
      where: { lesson_id: lesson.id },
      include: {
        questions: {
          orderBy: { order_index: 'asc' },
          select: {
            id: true,
            body: true,
            type: true,
            options: true,
            points: true,
            order_index: true,
          },
        },
      },
    })
    if (!quiz) return res.status(404).json({ error: 'No quiz for this lesson' })

    const attempts = await prisma.quizAttempt.count({
      where: {
        user_id: req.user.id,
        quiz_id: quiz.id,
        submitted_at: { not: null },
      },
    })
    const lastAttempt = await prisma.quizAttempt.findFirst({
      where: { user_id: req.user.id, quiz_id: quiz.id, submitted_at: { not: null } },
      orderBy: { submitted_at: 'desc' },
      select: { id: true, score: true, submitted_at: true },
    })

    res.json({
      ...quiz,
      programId,
      attemptsUsed: attempts,
      remainingAttempts: Math.max(0, quiz.max_attempts - attempts),
      lastAttempt,
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/quizzes/lessons/:lessonId/submit
router.post('/lessons/:lessonId/submit', verifyJWT, async (req, res, next) => {
  try {
    const { answers } = z.object({ answers: z.record(z.string()) }).parse(req.body)

    const lesson = await getLessonWithProgram(req.params.lessonId)
    if (!lesson) return res.status(404).json({ error: 'Lesson not found' })
    const programId = lesson.module.course.program_id
    if (!ensureProgramAccess(req, programId)) {
      return res.status(403).json({ error: 'No access to this program' })
    }

    const quiz = await prisma.quiz.findUnique({
      where: { lesson_id: lesson.id },
      include: { questions: true },
    })
    if (!quiz) return res.status(404).json({ error: 'No quiz for this lesson' })

    const prior = await prisma.quizAttempt.count({
      where: {
        user_id: req.user.id,
        quiz_id: quiz.id,
        submitted_at: { not: null },
      },
    })
    if (prior >= quiz.max_attempts) {
      return res.status(403).json({
        error: `Sudah maksimum ${quiz.max_attempts} percobaan.`,
        attemptsUsed: prior,
        maxAttempts: quiz.max_attempts,
      })
    }

    // Auto-grade MCQ; essays are deferred to trainer grading.
    let earned = 0
    let total = 0
    let hasEssay = false
    for (const q of quiz.questions) {
      total += q.points
      if (q.type === 'MCQ') {
        if (answers[q.id] === q.correct_answer) earned += q.points
      } else if (q.type === 'ESSAY') {
        hasEssay = true
      }
    }
    const score = total > 0 ? (earned / total) * 100 : 0

    const attempt = await prisma.quizAttempt.create({
      data: {
        quiz_id: quiz.id,
        user_id: req.user.id,
        program_id: programId,
        answers,
        score: hasEssay ? null : score,
        submitted_at: new Date(),
      },
    })

    // If passed (and no essay pending), mark the lesson as complete
    let lessonCompleted = false
    if (!hasEssay && score >= quiz.passing_score) {
      await prisma.lessonProgress.upsert({
        where: {
          user_id_lesson_id_program_id: {
            user_id: req.user.id,
            lesson_id: lesson.id,
            program_id: programId,
          },
        },
        update: { completed: true, completed_at: new Date() },
        create: {
          user_id: req.user.id,
          lesson_id: lesson.id,
          program_id: programId,
          completed: true,
          completed_at: new Date(),
        },
      })
      lessonCompleted = true
    }

    res.status(201).json({
      attemptId: attempt.id,
      score: attempt.score,
      earned,
      total,
      hasEssay,
      pendingEssayGrading: hasEssay,
      passed: !hasEssay && score >= quiz.passing_score,
      passingScore: quiz.passing_score,
      lessonCompleted,
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/quizzes/lessons/:lessonId/attempts — user's own history
router.get('/lessons/:lessonId/attempts', verifyJWT, async (req, res, next) => {
  try {
    const lesson = await getLessonWithProgram(req.params.lessonId)
    if (!lesson) return res.status(404).json({ error: 'Lesson not found' })
    if (!ensureProgramAccess(req, lesson.module.course.program_id)) {
      return res.status(403).json({ error: 'No access to this program' })
    }
    const quiz = await prisma.quiz.findUnique({ where: { lesson_id: lesson.id } })
    if (!quiz) return res.json([])
    const attempts = await prisma.quizAttempt.findMany({
      where: { user_id: req.user.id, quiz_id: quiz.id },
      orderBy: { started_at: 'desc' },
    })
    res.json(attempts)
  } catch (err) {
    next(err)
  }
})

// ─── Trainer/admin authoring ─────────────────────────────────────────────────

// POST /api/v1/quizzes/lessons/:lessonId — create or replace quiz settings
router.post(
  '/lessons/:lessonId',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  async (req, res, next) => {
    try {
      const data = z
        .object({
          title: z.string().min(1),
          passing_score: z.number().min(0).max(100).default(70),
          max_attempts: z.number().int().min(1).max(20).default(3),
        })
        .parse(req.body)

      const lesson = await getLessonWithProgram(req.params.lessonId)
      if (!lesson) return res.status(404).json({ error: 'Lesson not found' })
      const programId = lesson.module.course.program_id
      if (!ensureProgramAccess(req, programId)) {
        return res.status(403).json({ error: 'No access to this program' })
      }

      const quiz = await prisma.quiz.upsert({
        where: { lesson_id: lesson.id },
        update: data,
        create: { ...data, lesson_id: lesson.id },
      })
      auditLog({
        action: 'QUIZ_UPSERTED',
        userId: req.user.id,
        programId,
        resourceType: 'quiz',
        resourceId: quiz.id,
        req,
      })
      res.json(quiz)
    } catch (err) {
      next(err)
    }
  }
)

// PUT /api/v1/quizzes/:quizId
router.put(
  '/:quizId',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  async (req, res, next) => {
    try {
      const data = z
        .object({
          title: z.string().min(1).optional(),
          passing_score: z.number().min(0).max(100).optional(),
          max_attempts: z.number().int().min(1).max(20).optional(),
        })
        .parse(req.body)

      const quiz = await prisma.quiz.findUnique({
        where: { id: req.params.quizId },
        include: { lesson: { include: { module: { include: { course: true } } } } },
      })
      if (!quiz) return res.status(404).json({ error: 'Quiz not found' })
      if (!ensureProgramAccess(req, quiz.lesson.module.course.program_id)) {
        return res.status(403).json({ error: 'No access' })
      }
      const updated = await prisma.quiz.update({
        where: { id: quiz.id },
        data,
      })
      res.json(updated)
    } catch (err) {
      next(err)
    }
  }
)

// DELETE /api/v1/quizzes/:quizId
router.delete(
  '/:quizId',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  async (req, res, next) => {
    try {
      const quiz = await prisma.quiz.findUnique({
        where: { id: req.params.quizId },
        include: { lesson: { include: { module: { include: { course: true } } } } },
      })
      if (!quiz) return res.status(404).json({ error: 'Quiz not found' })
      if (!ensureProgramAccess(req, quiz.lesson.module.course.program_id)) {
        return res.status(403).json({ error: 'No access' })
      }
      await prisma.quiz.delete({ where: { id: quiz.id } })
      res.json({ ok: true })
    } catch (err) {
      next(err)
    }
  }
)

// POST /api/v1/quizzes/:quizId/questions — add a question
router.post(
  '/:quizId/questions',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  async (req, res, next) => {
    try {
      const data = z
        .object({
          body: z.string().min(1),
          type: z.enum(['MCQ', 'ESSAY']),
          options: z.any().optional(),
          correct_answer: z.string().optional(),
          points: z.number().int().min(1).default(1),
          order_index: z.number().int().default(0),
        })
        .parse(req.body)

      const quiz = await prisma.quiz.findUnique({
        where: { id: req.params.quizId },
        include: { lesson: { include: { module: { include: { course: true } } } } },
      })
      if (!quiz) return res.status(404).json({ error: 'Quiz not found' })
      if (!ensureProgramAccess(req, quiz.lesson.module.course.program_id)) {
        return res.status(403).json({ error: 'No access' })
      }
      const q = await prisma.quizQuestion.create({
        data: { ...data, quiz_id: quiz.id },
      })
      res.status(201).json(q)
    } catch (err) {
      next(err)
    }
  }
)

// PUT /api/v1/quizzes/questions/:qid
router.put(
  '/questions/:qid',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  async (req, res, next) => {
    try {
      const data = z
        .object({
          body: z.string().min(1).optional(),
          type: z.enum(['MCQ', 'ESSAY']).optional(),
          options: z.any().optional(),
          correct_answer: z.string().nullable().optional(),
          points: z.number().int().min(1).optional(),
          order_index: z.number().int().optional(),
        })
        .parse(req.body)

      const question = await prisma.quizQuestion.findUnique({
        where: { id: req.params.qid },
        include: { quiz: { include: { lesson: { include: { module: { include: { course: true } } } } } } },
      })
      if (!question) return res.status(404).json({ error: 'Question not found' })
      if (!ensureProgramAccess(req, question.quiz.lesson.module.course.program_id)) {
        return res.status(403).json({ error: 'No access' })
      }
      const updated = await prisma.quizQuestion.update({
        where: { id: question.id },
        data,
      })
      res.json(updated)
    } catch (err) {
      next(err)
    }
  }
)

// DELETE /api/v1/quizzes/questions/:qid
router.delete(
  '/questions/:qid',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  async (req, res, next) => {
    try {
      const question = await prisma.quizQuestion.findUnique({
        where: { id: req.params.qid },
        include: { quiz: { include: { lesson: { include: { module: { include: { course: true } } } } } } },
      })
      if (!question) return res.status(404).json({ error: 'Question not found' })
      if (!ensureProgramAccess(req, question.quiz.lesson.module.course.program_id)) {
        return res.status(403).json({ error: 'No access' })
      }
      await prisma.quizQuestion.delete({ where: { id: question.id } })
      res.json({ ok: true })
    } catch (err) {
      next(err)
    }
  }
)

// GET /api/v1/quizzes/lessons/:lessonId/admin — full quiz incl. correct answers (trainer only)
router.get(
  '/lessons/:lessonId/admin',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  async (req, res, next) => {
    try {
      const lesson = await getLessonWithProgram(req.params.lessonId)
      if (!lesson) return res.status(404).json({ error: 'Lesson not found' })
      if (!ensureProgramAccess(req, lesson.module.course.program_id)) {
        return res.status(403).json({ error: 'No access' })
      }
      const quiz = await prisma.quiz.findUnique({
        where: { lesson_id: lesson.id },
        include: { questions: { orderBy: { order_index: 'asc' } } },
      })
      if (!quiz) return res.status(404).json({ error: 'No quiz for this lesson' })
      res.json(quiz)
    } catch (err) {
      next(err)
    }
  }
)

// POST /api/v1/quizzes/attempts/:attemptId/grade-essays — trainer grade
router.post(
  '/attempts/:attemptId/grade-essays',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  async (req, res, next) => {
    try {
      const { grades } = z
        .object({ grades: z.record(z.coerce.number().min(0)) })
        .parse(req.body)

      const attempt = await prisma.quizAttempt.findUnique({
        where: { id: req.params.attemptId },
        include: { quiz: { include: { questions: true, lesson: { include: { module: { include: { course: true } } } } } } },
      })
      if (!attempt) return res.status(404).json({ error: 'Attempt not found' })
      const programId = attempt.quiz.lesson.module.course.program_id
      if (!ensureProgramAccess(req, programId)) {
        return res.status(403).json({ error: 'No access' })
      }

      let earned = 0
      let total = 0
      const answers = attempt.answers || {}
      for (const q of attempt.quiz.questions) {
        total += q.points
        if (q.type === 'MCQ') {
          if (answers[q.id] === q.correct_answer) earned += q.points
        } else if (q.type === 'ESSAY') {
          const awarded = grades[q.id]
          if (awarded != null) earned += Math.min(Math.max(0, awarded), q.points)
        }
      }
      const score = total > 0 ? (earned / total) * 100 : 0

      const updated = await prisma.quizAttempt.update({
        where: { id: attempt.id },
        data: { score },
      })

      // Mark lesson complete on pass
      if (score >= attempt.quiz.passing_score) {
        await prisma.lessonProgress.upsert({
          where: {
            user_id_lesson_id_program_id: {
              user_id: attempt.user_id,
              lesson_id: attempt.quiz.lesson_id,
              program_id: programId,
            },
          },
          update: { completed: true, completed_at: new Date() },
          create: {
            user_id: attempt.user_id,
            lesson_id: attempt.quiz.lesson_id,
            program_id: programId,
            completed: true,
            completed_at: new Date(),
          },
        })
      }

      auditLog({
        action: 'QUIZ_ESSAY_GRADED',
        userId: req.user.id,
        programId,
        resourceType: 'quiz_attempt',
        resourceId: attempt.id,
        metadata: { score, gradedFor: attempt.user_id },
        req,
      })

      res.json({ attemptId: updated.id, score, earned, total })
    } catch (err) {
      next(err)
    }
  }
)

module.exports = router
