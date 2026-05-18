const express = require('express')
const prisma = require('../lib/prisma')
const { verifyJWT, requireRole } = require('../middleware/auth')
const { programIsolation } = require('../middleware/programIsolation')

const router = express.Router()

// GET /api/v1/reports/programs/:pid/progress — participants progress
router.get(
  '/programs/:pid/progress',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      const enrollments = await prisma.programEnrollment.findMany({
        where: { program_id: req.programId },
        include: {
          user: { select: { id: true, full_name: true, email: true } },
        },
      })

      const data = enrollments.map((e) => ({
        userId: e.user.id,
        name: e.user.full_name,
        email: e.user.email,
        pretest: e.pretest_score,
        posttest: e.posttest_score,
        gain:
          e.posttest_score != null && e.pretest_score != null
            ? e.posttest_score - e.pretest_score
            : null,
        attendance: e.attendance_pct,
        certEligible: e.cert_eligible,
      }))
      res.json(data)
    } catch (err) {
      next(err)
    }
  }
)

// GET /api/v1/reports/programs/:pid/analytics — aggregated stats
router.get(
  '/programs/:pid/analytics',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      const enrollments = await prisma.programEnrollment.findMany({
        where: { program_id: req.programId },
      })
      const total = enrollments.length
      const withPosttest = enrollments.filter((e) => e.posttest_score != null)
      const eligible = enrollments.filter((e) => e.cert_eligible).length
      const avgPretest =
        enrollments.reduce((s, e) => s + (e.pretest_score ?? 0), 0) / (total || 1)
      const avgPosttest =
        withPosttest.reduce((s, e) => s + (e.posttest_score ?? 0), 0) /
        (withPosttest.length || 1)
      const avgAttendance =
        enrollments.reduce((s, e) => s + (e.attendance_pct ?? 0), 0) / (total || 1)

      res.json({
        total,
        eligible,
        avgPretest: Number(avgPretest.toFixed(2)),
        avgPosttest: Number(avgPosttest.toFixed(2)),
        avgGain: Number((avgPosttest - avgPretest).toFixed(2)),
        avgAttendance: Number(avgAttendance.toFixed(2)),
      })
    } catch (err) {
      next(err)
    }
  }
)

module.exports = router
