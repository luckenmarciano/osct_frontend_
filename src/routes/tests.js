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
const { auditLog } = require('../services/audit.service')
const { createNotif } = require('../services/notification.service')

const router = express.Router()

const TEST_KIND = { pretest: 'PRETEST', posttest: 'POSTTEST' }

// FR-7.3 default attempt caps used when a CourseTest row was created
// before max_attempts existed, or when the field is null for any reason.
function defaultMaxAttempts(type) {
  return type === 'PRETEST' ? 1 : 2
}

// ─── FR-7.5 cohort learning-gain ─────────────────────────────────────────────
// Must come before /:kind so 'learning-gain' isn't captured as kind="learning-gain".
router.get(
  '/programs/:pid/learning-gain/cohort',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      const enrollments = await prisma.programEnrollment.findMany({
        where: { program_id: req.programId },
        include: { user: { select: { id: true, full_name: true, email: true } } },
        orderBy: { enrolled_at: 'asc' },
      })

      // Latest submitted posttest attempt per user (for submittedAt timestamp)
      const posttestAttempts = await prisma.testAttempt.findMany({
        where: {
          program_id: req.programId,
          submitted_at: { not: null },
          test: { type: 'POSTTEST' },
        },
        select: { user_id: true, submitted_at: true },
        orderBy: { submitted_at: 'desc' },
      })
      const lastSubmitByUser = new Map()
      for (const a of posttestAttempts) {
        if (!lastSubmitByUser.has(a.user_id)) {
          lastSubmitByUser.set(a.user_id, a.submitted_at)
        }
      }

      const participants = enrollments.map((e) => {
        const pre = e.pretest_score
        const post = e.posttest_score
        const gain = pre != null && post != null ? post - pre : null
        return {
          userId: e.user.id,
          name: e.user.full_name,
          email: e.user.email,
          pretest: pre,
          posttest: post,
          gain,
          submittedAt: lastSubmitByUser.get(e.user.id) || null,
        }
      })

      const withGain = participants.filter((p) => p.gain != null)
      const withPre = participants.filter((p) => p.pretest != null)
      const withPost = participants.filter((p) => p.posttest != null)

      const avg = (arr, key) =>
        arr.length ? arr.reduce((s, p) => s + p[key], 0) / arr.length : 0

      const buckets = {
        high: withGain.filter((p) => p.gain >= 30).length,
        mid: withGain.filter((p) => p.gain >= 15 && p.gain < 30).length,
        low: withGain.filter((p) => p.gain < 15).length,
        pending: participants.length - withGain.length,
      }

      res.json({
        total: participants.length,
        avg: {
          pretest: Number(avg(withPre, 'pretest').toFixed(2)),
          posttest: Number(avg(withPost, 'posttest').toFixed(2)),
          gain: Number(avg(withGain, 'gain').toFixed(2)),
        },
        buckets,
        participants,
      })
    } catch (err) {
      next(err)
    }
  }
)

// ─── FR-7.6 participant-facing notification flags ───────────────────────────
router.get(
  '/programs/:pid/notifications',
  verifyJWT,
  programIsolation,
  async (req, res, next) => {
    try {
      const enrollment = await prisma.programEnrollment.findFirst({
        where: { user_id: req.user.id, program_id: req.programId },
      })
      if (!enrollment) {
        return res.json({ posttestOpen: false, pretestPending: false })
      }

      const [pretest, posttest] = await Promise.all([
        prisma.courseTest.findUnique({
          where: { program_id_type: { program_id: req.programId, type: 'PRETEST' } },
          select: { id: true },
        }),
        prisma.courseTest.findUnique({
          where: { program_id_type: { program_id: req.programId, type: 'POSTTEST' } },
          select: { id: true },
        }),
      ])

      const pretestPending = !!pretest && enrollment.pretest_score == null

      let posttestOpen = false
      if (posttest) {
        const ready = await isProgramLearningComplete({
          userId: req.user.id,
          programId: req.programId,
        })
        if (ready) {
          const existingAttempt = await prisma.testAttempt.findFirst({
            where: {
              user_id: req.user.id,
              test_id: posttest.id,
              submitted_at: { not: null },
            },
            select: { id: true },
          })
          posttestOpen = !existingAttempt
        }
      }

      res.json({ posttestOpen, pretestPending })
    } catch (err) {
      next(err)
    }
  }
)

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

    const maxAttempts = test.max_attempts ?? defaultMaxAttempts(type)
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
      const maxAttempts = test.max_attempts ?? defaultMaxAttempts(type)
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

      auditLog({
        action: 'ESSAY_GRADED',
        userId: req.user.id,
        programId: attempt.program_id,
        resourceType: 'attempt',
        resourceId: attempt.id,
        metadata: { testType: attempt.test.type, score, gradedFor: attempt.user_id },
        req,
      })

      // Notify the participant that their essay was graded (non-fatal)
      const testLabel = attempt.test.type === 'PRETEST' ? 'pretest' : 'posttest'
      createNotif({
        userId:    attempt.user_id,
        type:      'ESSAY_GRADED',
        title:     `Esai ${testLabel} Anda sudah dinilai`,
        body:      `Skor Anda: ${Math.round(score)}. Buka halaman Tes untuk melihat hasil lengkap.`,
        programId: attempt.program_id,
        refId:     attempt.id,
      }).catch((e) => console.error('[essay-graded notif]', e.message))

      // If grading posttest made the participant cert-eligible, notify them (non-fatal)
      if (attempt.test.type === 'POSTTEST') {
        recomputeAttendancePct({ userId: attempt.user_id, programId: attempt.program_id })
          .then((r) => {
            if (r.justBecameEligible) {
              return createNotif({
                userId:    attempt.user_id,
                type:      'CERT_READY',
                title:     'Selamat! Anda memenuhi syarat sertifikat',
                body:      'Kunjungi halaman Sertifikat untuk mengklaim sertifikat Anda.',
                programId: attempt.program_id,
                refId:     `cert-ready-${attempt.user_id}-${attempt.program_id}`,
              })
            }
          })
          .catch((e) => console.error('[cert-ready notif from grading]', e.message))
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

// ─── FR-7.1 Admin/Trainer authoring ─────────────────────────────────────────

// GET /api/v1/tests/programs/:pid/:kind/admin — full test incl. correct answers
router.get(
  '/programs/:pid/:kind/admin',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      const type = TEST_KIND[req.params.kind]
      if (!type) return res.status(400).json({ error: 'Invalid test kind' })

      const test = await prisma.courseTest.findUnique({
        where: { program_id_type: { program_id: req.programId, type } },
        include: { questions: { orderBy: { order_index: 'asc' } } },
      })
      if (!test) return res.status(404).json({ error: 'Test not found' })

      res.json(test)
    } catch (err) {
      next(err)
    }
  }
)

// POST /api/v1/tests/programs/:pid/:kind — upsert test by (program_id, type)
router.post(
  '/programs/:pid/:kind',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      const type = TEST_KIND[req.params.kind]
      if (!type) return res.status(400).json({ error: 'Invalid test kind' })

      const data = z
        .object({
          title: z.string().min(1),
          time_limit: z.number().int().min(0).nullable().optional(),
          max_attempts: z.number().int().min(1).max(20).optional(),
        })
        .parse(req.body)

      const maxAttempts = data.max_attempts ?? defaultMaxAttempts(type)

      const test = await prisma.courseTest.upsert({
        where: { program_id_type: { program_id: req.programId, type } },
        update: {
          title: data.title,
          time_limit: data.time_limit ?? null,
          max_attempts: maxAttempts,
        },
        create: {
          program_id: req.programId,
          type,
          title: data.title,
          time_limit: data.time_limit ?? null,
          max_attempts: maxAttempts,
        },
      })

      auditLog({
        action: 'TEST_UPSERTED',
        userId: req.user.id,
        programId: req.programId,
        resourceType: 'course_test',
        resourceId: test.id,
        metadata: { type, title: test.title },
        req,
      })

      res.status(201).json(test)
    } catch (err) {
      next(err)
    }
  }
)

// PUT /api/v1/tests/programs/:pid/:kind — partial update (does not create)
router.put(
  '/programs/:pid/:kind',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      const type = TEST_KIND[req.params.kind]
      if (!type) return res.status(400).json({ error: 'Invalid test kind' })

      const data = z
        .object({
          title: z.string().min(1).optional(),
          time_limit: z.number().int().min(0).nullable().optional(),
          max_attempts: z.number().int().min(1).max(20).optional(),
        })
        .parse(req.body)

      const existing = await prisma.courseTest.findUnique({
        where: { program_id_type: { program_id: req.programId, type } },
      })
      if (!existing) return res.status(404).json({ error: 'Test not found' })

      const updateData = {}
      if (data.title !== undefined) updateData.title = data.title
      if (data.time_limit !== undefined) updateData.time_limit = data.time_limit
      if (data.max_attempts !== undefined) updateData.max_attempts = data.max_attempts

      const test = await prisma.courseTest.update({
        where: { id: existing.id },
        data: updateData,
      })
      res.json(test)
    } catch (err) {
      next(err)
    }
  }
)

// DELETE /api/v1/tests/programs/:pid/:kind — delete test (cascades questions + attempts)
router.delete(
  '/programs/:pid/:kind',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      const type = TEST_KIND[req.params.kind]
      if (!type) return res.status(400).json({ error: 'Invalid test kind' })

      const existing = await prisma.courseTest.findUnique({
        where: { program_id_type: { program_id: req.programId, type } },
      })
      if (!existing) return res.status(404).json({ error: 'Test not found' })

      await prisma.courseTest.delete({ where: { id: existing.id } })

      auditLog({
        action: 'TEST_DELETED',
        userId: req.user.id,
        programId: req.programId,
        resourceType: 'course_test',
        resourceId: existing.id,
        metadata: { type, title: existing.title },
        req,
      })

      res.json({ ok: true })
    } catch (err) {
      next(err)
    }
  }
)

// POST /api/v1/tests/programs/:pid/:kind/questions — add a question
router.post(
  '/programs/:pid/:kind/questions',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      const type = TEST_KIND[req.params.kind]
      if (!type) return res.status(400).json({ error: 'Invalid test kind' })

      const data = z
        .object({
          body: z.string().min(1),
          type: z.enum(['MCQ', 'ESSAY']),
          options: z.any().optional(),
          correct_answer: z.string().nullable().optional(),
          points: z.number().int().min(1).default(1),
          order_index: z.number().int().default(0),
        })
        .parse(req.body)

      const test = await prisma.courseTest.findUnique({
        where: { program_id_type: { program_id: req.programId, type } },
      })
      if (!test) return res.status(404).json({ error: 'Test not found — create it first' })

      const question = await prisma.question.create({
        data: { ...data, test_id: test.id },
      })
      res.status(201).json(question)
    } catch (err) {
      next(err)
    }
  }
)

// Helper: load a question + its test and verify the caller has program access
async function getQuestionWithAccess(req, res) {
  const question = await prisma.question.findUnique({
    where: { id: req.params.qid },
    include: { test: { select: { id: true, program_id: true, type: true } } },
  })
  if (!question) {
    res.status(404).json({ error: 'Question not found' })
    return null
  }
  if (
    req.user.role !== 'SUPER_ADMIN' &&
    !req.user.programIds.includes(question.test.program_id)
  ) {
    res.status(403).json({ error: 'No access to this program' })
    return null
  }
  return question
}

// PUT /api/v1/tests/questions/:qid
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

      const question = await getQuestionWithAccess(req, res)
      if (!question) return

      const updated = await prisma.question.update({
        where: { id: question.id },
        data,
      })
      res.json(updated)
    } catch (err) {
      next(err)
    }
  }
)

// DELETE /api/v1/tests/questions/:qid
router.delete(
  '/questions/:qid',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  async (req, res, next) => {
    try {
      const question = await getQuestionWithAccess(req, res)
      if (!question) return

      await prisma.question.delete({ where: { id: question.id } })
      res.json({ ok: true })
    } catch (err) {
      next(err)
    }
  }
)

module.exports = router
