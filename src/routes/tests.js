const express = require('express')
const { z } = require('zod')
const prisma = require('../lib/prisma')
const { verifyJWT } = require('../middleware/auth')
const { programIsolation } = require('../middleware/programIsolation')

const router = express.Router()

const TEST_KIND = { pretest: 'PRETEST', posttest: 'POSTTEST' }

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

    // Check whether the user already submitted
    const existing = await prisma.testAttempt.findFirst({
      where: {
        user_id: req.user.id,
        test_id: test.id,
        submitted_at: { not: null },
      },
    })
    res.json({ ...test, alreadySubmitted: !!existing, previousScore: existing?.score ?? null })
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

      // Auto-score MCQ. Essay needs manual grading later.
      let earned = 0
      let total = 0
      for (const q of test.questions) {
        total += q.points
        if (q.type === 'MCQ' && answers[q.id] === q.correct_answer) {
          earned += q.points
        }
      }
      const score = total > 0 ? (earned / total) * 100 : 0

      const attempt = await prisma.testAttempt.create({
        data: {
          user_id: req.user.id,
          test_id: test.id,
          program_id: req.programId,
          answers,
          score,
          submitted_at: new Date(),
        },
      })

      // Update enrollment score
      const field = type === 'PRETEST' ? 'pretest_score' : 'posttest_score'
      await prisma.programEnrollment.updateMany({
        where: { user_id: req.user.id, program_id: req.programId },
        data: { [field]: score },
      })

      // If posttest, recompute cert eligibility (attendance ≥ 80, posttest ≥ 70)
      if (type === 'POSTTEST') {
        const enrollment = await prisma.programEnrollment.findFirst({
          where: { user_id: req.user.id, program_id: req.programId },
        })
        if (enrollment) {
          const eligible =
            (enrollment.attendance_pct ?? 0) >= 80 && score >= 70
          await prisma.programEnrollment.update({
            where: { id: enrollment.id },
            data: { cert_eligible: eligible },
          })
        }
      }

      res.status(201).json({ id: attempt.id, score, earned, total })
    } catch (err) {
      next(err)
    }
  }
)

module.exports = router
