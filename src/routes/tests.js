const express = require('express')
const { z } = require('zod')
const prisma = require('../lib/prisma')
const { verifyJWT, requireRole } = require('../middleware/auth')
const { programIsolation } = require('../middleware/programIsolation')
const {
  isProgramLearningComplete,
  recomputeAttendancePct,
  POSTTEST_THRESHOLD,
  ATTENDANCE_THRESHOLD,
} = require('../services/enrollment.service')

const router = express.Router()

const TEST_KIND = { pretest: 'PRETEST', posttest: 'POSTTEST' }
const MAX_PRETEST_ATTEMPTS = 1
const MAX_POSTTEST_ATTEMPTS = 2

// GET /api/v1/tests/programs/:pid/learning-gain — must come BEFORE /:kind to avoid pattern collision
router.get(
  '/programs/:pid/learning-gain',
  verifyJWT,
  programIsolation,
  async (req, res, next) => {
    try {
      const enrollment = await prisma.programEnrollment.findFirst({
        where: { user_id: req.user.id, program_id: req.programId },
      })
      if (!enrollment) return res.status(404).json({ error: 'Not enrolled' })

      const pretest = enrollment.pretest_score
      const posttest = enrollment.posttest_score
      const gain = pretest != null && posttest != null ? posttest - pretest : null
      const gainPct =
        pretest != null && posttest != null && pretest > 0
          ? ((posttest - pretest) / pretest) * 100
          : null

      res.json({ pretest, posttest, gain, gainPct })
    } catch (err) {
      next(err)
    }
  }
)

// GET /api/v1/tests/programs/:pid/:kind — pretest | posttest
router.get('/programs/:pid/:kind', verifyJWT, programIsolation, async (req, res, next) => {
  try {
    const type = TEST_KIND[req.params.kind]
    if (!type) return res.status(400).json({ error: 'Invalid test kind' })

    const test = await prisma.courseTest.findUnique({
      where: { program_id_type: { program_id: req.programId, type } },
      include: {
        questions: {
          orderBy: { order_index: 'asc' },
          // strip correct_answer from public response
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
    if (!test) return res.status(404).json({ error: 'Test not found' })

    // Gate posttest until all lessons completed
    if (type === 'POSTTEST') {
      const ready = await isProgramLearningComplete({
        userId: req.user.id,
        programId: req.programId,
      })
      if (!ready) {
        return res.status(403).json({
          error: 'Posttest belum tersedia. Selesaikan semua modul terlebih dahulu.',
          locked: true,
        })
      }
    }

    const submittedAttempts = await prisma.testAttempt.findMany({
      where: {
        user_id: req.user.id,
        test_id: test.id,
        submitted_at: { not: null },
      },
      orderBy: { submitted_at: 'desc' },
      select: { id: true, score: true, submitted_at: true },
    })

    const maxAttempts = type === 'PRETEST' ? MAX_PRETEST_ATTEMPTS : MAX_POSTTEST_ATTEMPTS
    const remaining = Math.max(0, maxAttempts - submittedAttempts.length)

    res.json({
      ...test,
      maxAttempts,
      attemptsUsed: submittedAttempts.length,
      remainingAttempts: remaining,
      alreadySubmitted: submittedAttempts.length > 0,
      previousScore: submittedAttempts[0]?.score ?? null,
      history: submittedAttempts,
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/tests/programs/:pid/:kind/submit
router.post(
  '/programs/:pid/:kind/submit',
  verifyJWT,
  programIsolation,
  async (req, res, next) => {
    try {
      const type = TEST_KIND[req.params.kind]
      if (!type) return res.status(400).json({ error: 'Invalid test kind' })

      const { answers } = z.object({ answers: z.record(z.string()) }).parse(req.body)

      const test = await prisma.courseTest.findUnique({
        where: { program_id_type: { program_id: req.programId, type } },
        include: { questions: true },
      })
      if (!test) return res.status(404).json({ error: 'Test not found' })

      // Enforce max attempts
      const prior = await prisma.testAttempt.count({
        where: {
          user_id: req.user.id,
          test_id: test.id,
          submitted_at: { not: null },
        },
      })
      const maxAttempts = type === 'PRETEST' ? MAX_PRETEST_ATTEMPTS : MAX_POSTTEST_ATTEMPTS
      if (prior >= maxAttempts) {
        return res.status(403).json({
          error: type === 'PRETEST'
            ? 'Pretest hanya bisa dikerjakan satu kali.'
            : `Posttest sudah maksimum ${maxAttempts} percobaan.`,
          attemptsUsed: prior,
          maxAttempts,
        })
      }

      // Gate posttest: all lessons must be completed
      if (type === 'POSTTEST') {
        const ready = await isProgramLearningComplete({
          userId: req.user.id,
          programId: req.programId,
        })
        if (!ready) {
          return res.status(403).json({
            error: 'Selesaikan semua modul sebelum mengerjakan posttest.',
            locked: true,
          })
        }
      }

      // Auto-score MCQ. Essay marked as ungraded (null) and added later by trainer.
      let earnedMcq = 0
      let totalPoints = 0
      let hasEssay = false
      for (const q of test.questions) {
        totalPoints += q.points
        if (q.type === 'MCQ') {
          if (answers[q.id] === q.correct_answer) earnedMcq += q.points
        } else if (q.type === 'ESSAY') {
          hasEssay = true
        }
      }
      // Partial score (only MCQ counted yet). For tests with no essay this equals final score.
      const partialScore = totalPoints > 0 ? (earnedMcq / totalPoints) * 100 : 0

      const attempt = await prisma.testAttempt.create({
        data: {
          user_id: req.user.id,
          test_id: test.id,
          program_id: req.programId,
          answers,
          // If essay exists, leave score null until trainer grades
          score: hasEssay ? null : partialScore,
          submitted_at: new Date(),
        },
      })

      // Update enrollment score only when score is final (no essay)
      if (!hasEssay) {
        const field = type === 'PRETEST' ? 'pretest_score' : 'posttest_score'
        await prisma.programEnrollment.updateMany({
          where: { user_id: req.user.id, program_id: req.programId },
          data: { [field]: partialScore },
        })

        if (type === 'POSTTEST') {
          await recomputeAttendancePct({
            userId: req.user.id,
            programId: req.programId,
          })
        }
      }

      res.status(201).json({
        id: attempt.id,
        score: attempt.score,
        partialScoreFromMcq: partialScore,
        earnedMcq,
        totalPoints,
        hasEssay,
        pendingEssayGrading: hasEssay,
      })
    } catch (err) {
      next(err)
    }
  }
)

// GET /api/v1/tests/programs/:pid/attempts/pending-grading — trainer/admin: essays awaiting grading
router.get(
  '/programs/:pid/attempts/pending-grading',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      const attempts = await prisma.testAttempt.findMany({
        where: {
          program_id: req.programId,
          submitted_at: { not: null },
          score: null, // null score = still pending essay grading
        },
        include: {
          user: { select: { id: true, full_name: true, email: true } },
          test: { select: { id: true, type: true, title: true } },
        },
        orderBy: { submitted_at: 'asc' },
      })
      res.json(attempts)
    } catch (err) {
      next(err)
    }
  }
)

// GET /api/v1/tests/attempts/:attemptId — trainer/admin: full attempt with questions
router.get(
  '/attempts/:attemptId',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  async (req, res, next) => {
    try {
      const attempt = await prisma.testAttempt.findUnique({
        where: { id: req.params.attemptId },
        include: {
          user: { select: { id: true, full_name: true, email: true } },
          test: { include: { questions: { orderBy: { order_index: 'asc' } } } },
        },
      })
      if (!attempt) return res.status(404).json({ error: 'Attempt not found' })
      if (
        req.user.role !== 'SUPER_ADMIN' &&
        !req.user.programIds.includes(attempt.program_id)
      ) {
        return res.status(403).json({ error: 'No access to this program' })
      }
      res.json(attempt)
    } catch (err) {
      next(err)
    }
  }
)

// POST /api/v1/tests/attempts/:attemptId/grade-essays — trainer/admin grade essay questions
router.post(
  '/attempts/:attemptId/grade-essays',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  async (req, res, next) => {
    try {
      const { grades } = z
        .object({
          // grades: { questionId: pointsAwarded }
          grades: z.record(z.coerce.number().min(0)),
        })
        .parse(req.body)

      const attempt = await prisma.testAttempt.findUnique({
        where: { id: req.params.attemptId },
        include: { test: { include: { questions: true } } },
      })
      if (!attempt) return res.status(404).json({ error: 'Attempt not found' })

      if (
        req.user.role !== 'SUPER_ADMIN' &&
        !req.user.programIds.includes(attempt.program_id)
      ) {
        return res.status(403).json({ error: 'No access to this program' })
      }

      // Recompute total: MCQ correct points + graded essay points, divided by total points.
      let earned = 0
      let total = 0
      const answers = attempt.answers || {}
      for (const q of attempt.test.questions) {
        total += q.points
        if (q.type === 'MCQ') {
          if (answers[q.id] === q.correct_answer) earned += q.points
        } else if (q.type === 'ESSAY') {
          const awarded = grades[q.id]
          if (awarded != null) {
            // Cap at question points
            earned += Math.min(Math.max(0, awarded), q.points)
          }
        }
      }
      const score = total > 0 ? (earned / total) * 100 : 0

      const updated = await prisma.testAttempt.update({
        where: { id: attempt.id },
        data: { score },
      })

      // Update enrollment score
      const field = attempt.test.type === 'PRETEST' ? 'pretest_score' : 'posttest_score'
      await prisma.programEnrollment.updateMany({
        where: { user_id: attempt.user_id, program_id: attempt.program_id },
        data: { [field]: score },
      })

      // Recompute cert eligibility if posttest
      if (attempt.test.type === 'POSTTEST') {
        await recomputeAttendancePct({
          userId: attempt.user_id,
          programId: attempt.program_id,
        })
      }

      res.json({
        attemptId: updated.id,
        score,
        earned,
        total,
      })
    } catch (err) {
      next(err)
    }
  }
)

module.exports = router
