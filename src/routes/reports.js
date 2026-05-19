const express = require('express')
const prisma = require('../lib/prisma')
const { verifyJWT, requireRole } = require('../middleware/auth')
const { programIsolation } = require('../middleware/programIsolation')

const router = express.Router()

function escapeCsv(value) {
  if (value == null) return ''
  const s = String(value)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function fmtNum(n) {
  if (n == null) return ''
  return Number.isFinite(n) ? Number(n).toFixed(2) : ''
}

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

// GET /api/v1/reports/programs/:pid/progress.csv — same as progress, exported as CSV
router.get(
  '/programs/:pid/progress.csv',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      const [program, enrollments] = await Promise.all([
        prisma.oPRCProgram.findUnique({ where: { id: req.programId } }),
        prisma.programEnrollment.findMany({
          where: { program_id: req.programId },
          include: { user: { select: { full_name: true, email: true } } },
          orderBy: { enrolled_at: 'asc' },
        }),
      ])

      const headers = [
        'Nama', 'Email', 'Pretest', 'Posttest', 'Learning Gain',
        'Attendance %', 'Cert Eligible', 'Enrolled At',
      ]
      const rows = enrollments.map((e) => {
        const gain =
          e.posttest_score != null && e.pretest_score != null
            ? e.posttest_score - e.pretest_score
            : null
        return [
          e.user.full_name,
          e.user.email,
          fmtNum(e.pretest_score),
          fmtNum(e.posttest_score),
          fmtNum(gain),
          fmtNum(e.attendance_pct),
          e.cert_eligible ? 'Yes' : 'No',
          e.enrolled_at.toISOString(),
        ].map(escapeCsv).join(',')
      })
      const csv = '﻿' + [headers.join(','), ...rows].join('\r\n') + '\r\n'

      const safeName = (program?.code || 'program').replace(/[^a-zA-Z0-9-]/g, '-')
      const dateStr = new Date().toISOString().slice(0, 10)
      const filename = `progress-${safeName}-${dateStr}.csv`

      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.send(csv)
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
