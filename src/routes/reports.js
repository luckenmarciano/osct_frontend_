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

// GET /api/v1/reports/programs/:pid/imo — IMO OPRC compliance summary (JSON)
router.get(
  '/programs/:pid/imo',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  programIsolation,
  async (req, res, next) => {
    try {
      const [program, enrollments, sessions] = await Promise.all([
        prisma.oPRCProgram.findUnique({ where: { id: req.programId } }),
        prisma.programEnrollment.findMany({
          where: { program_id: req.programId },
          include: {
            user: { select: { full_name: true, email: true } },
            certificate: { select: { cert_no: true, claimed_at: true, issued_at: true } },
          },
        }),
        prisma.session.findMany({
          where: { program_id: req.programId },
          select: { id: true, scheduled_at: true, title: true },
          orderBy: { scheduled_at: 'asc' },
        }),
      ])

      if (!program) return res.status(404).json({ error: 'Program not found' })

      const total = enrollments.length
      const certified = enrollments.filter((e) => e.certificate?.claimed_at).length
      const eligible = enrollments.filter((e) => e.cert_eligible).length
      const withPosttest = enrollments.filter((e) => e.posttest_score != null)
      const withBoth = enrollments.filter((e) => e.pretest_score != null && e.posttest_score != null)

      const avg = (arr, key) => arr.length ? arr.reduce((s, e) => s + (e[key] ?? 0), 0) / arr.length : 0
      const avgPretest = avg(enrollments.filter((e) => e.pretest_score != null), 'pretest_score')
      const avgPosttest = avg(withPosttest, 'posttest_score')
      const avgGain = withBoth.length
        ? withBoth.reduce((s, e) => s + (e.posttest_score - e.pretest_score), 0) / withBoth.length
        : 0
      const avgAttendance = avg(enrollments, 'attendance_pct')

      // Compliance gates (defaults per PRD §FR-7.3 / §FR-9)
      const POSTTEST_THRESHOLD = 70
      const ATTENDANCE_THRESHOLD = 80

      res.json({
        program: {
          id: program.id,
          code: program.code,
          name: program.name,
          level: program.level,
          generatedAt: new Date().toISOString(),
        },
        compliance: {
          imoStandard: 'IMO OPRC 1990 Model Course',
          thresholds: {
            posttestMinScore: POSTTEST_THRESHOLD,
            attendanceMinPct: ATTENDANCE_THRESHOLD,
          },
          sessionCount: sessions.length,
        },
        outcomes: {
          totalEnrolled: total,
          totalEligibleForCert: eligible,
          totalCertified: certified,
          certificationRatePct: total ? Number(((certified / total) * 100).toFixed(2)) : 0,
          eligibilityRatePct: total ? Number(((eligible / total) * 100).toFixed(2)) : 0,
        },
        scores: {
          avgPretest: Number(avgPretest.toFixed(2)),
          avgPosttest: Number(avgPosttest.toFixed(2)),
          avgLearningGain: Number(avgGain.toFixed(2)),
          avgAttendancePct: Number(avgAttendance.toFixed(2)),
        },
        participants: enrollments.map((e) => ({
          name: e.user.full_name,
          email: e.user.email,
          pretest: e.pretest_score,
          posttest: e.posttest_score,
          gain:
            e.posttest_score != null && e.pretest_score != null
              ? Number((e.posttest_score - e.pretest_score).toFixed(2))
              : null,
          attendancePct: Number((e.attendance_pct ?? 0).toFixed(2)),
          certEligible: e.cert_eligible,
          certNo: e.certificate?.cert_no || null,
          certClaimedAt: e.certificate?.claimed_at || null,
        })),
      })
    } catch (err) {
      next(err)
    }
  }
)

// GET /api/v1/reports/programs/:pid/imo.csv — IMO compliance report as CSV
router.get(
  '/programs/:pid/imo.csv',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  programIsolation,
  async (req, res, next) => {
    try {
      const [program, enrollments] = await Promise.all([
        prisma.oPRCProgram.findUnique({ where: { id: req.programId } }),
        prisma.programEnrollment.findMany({
          where: { program_id: req.programId },
          include: {
            user: { select: { full_name: true, email: true } },
            certificate: { select: { cert_no: true, claimed_at: true } },
          },
          orderBy: { enrolled_at: 'asc' },
        }),
      ])

      if (!program) return res.status(404).json({ error: 'Program not found' })

      const headerRows = [
        ['IMO OPRC Compliance Report'],
        ['Program', program.name],
        ['Level', String(program.level)],
        ['Code', program.code],
        ['Generated', new Date().toISOString()],
        ['Standard', 'IMO OPRC 1990 Model Course'],
        ['Posttest Min Score', '70'],
        ['Attendance Min %', '80'],
        [],
      ]
      const dataHeader = [
        'Name', 'Email', 'Pretest', 'Posttest', 'Learning Gain',
        'Attendance %', 'Cert Eligible', 'Cert No', 'Cert Claimed At',
      ]
      const dataRows = enrollments.map((e) => {
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
          e.certificate?.cert_no || '',
          e.certificate?.claimed_at ? new Date(e.certificate.claimed_at).toISOString() : '',
        ]
      })

      const lines = [
        ...headerRows.map((r) => r.map(escapeCsv).join(',')),
        dataHeader.map(escapeCsv).join(','),
        ...dataRows.map((r) => r.map(escapeCsv).join(',')),
      ]
      const csv = '﻿' + lines.join('\r\n') + '\r\n'

      const safeName = (program.code || 'program').replace(/[^a-zA-Z0-9-]/g, '-')
      const dateStr = new Date().toISOString().slice(0, 10)
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="imo-${safeName}-${dateStr}.csv"`)
      res.send(csv)
    } catch (err) {
      next(err)
    }
  }
)

// GET /api/v1/reports/programs/:pid/courses-progress — per-course completion recap (FR-10.3)
router.get(
  '/programs/:pid/courses-progress',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      const [courses, enrollments, progress] = await Promise.all([
        prisma.course.findMany({
          where: { program_id: req.programId },
          include: { modules: { include: { lessons: { select: { id: true } } } } },
          orderBy: { order_index: 'asc' },
        }),
        prisma.programEnrollment.findMany({
          where: { program_id: req.programId },
          include: { user: { select: { id: true, full_name: true, email: true } } },
          orderBy: { enrolled_at: 'asc' },
        }),
        prisma.lessonProgress.findMany({
          where: { program_id: req.programId, completed: true },
          select: { user_id: true, lesson_id: true },
        }),
      ])

      // user_id → Set of completed lesson ids
      const completedByUser = new Map()
      for (const p of progress) {
        if (!completedByUser.has(p.user_id)) completedByUser.set(p.user_id, new Set())
        completedByUser.get(p.user_id).add(p.lesson_id)
      }

      const result = courses.map((course) => {
        const lessonIds = course.modules.flatMap((m) => m.lessons.map((l) => l.id))
        const lessonCount = lessonIds.length

        const participants = enrollments.map((e) => {
          const done = completedByUser.get(e.user.id) || new Set()
          const completedLessons = lessonIds.filter((id) => done.has(id)).length
          const completionPct =
            lessonCount > 0 ? (completedLessons / lessonCount) * 100 : 0
          return {
            userId: e.user.id,
            name: e.user.full_name,
            email: e.user.email,
            completedLessons,
            completionPct: Number(completionPct.toFixed(1)),
            posttestScore: e.posttest_score,
          }
        })

        const avgCompletionPct = participants.length
          ? Number(
              (
                participants.reduce((s, p) => s + p.completionPct, 0) /
                participants.length
              ).toFixed(1)
            )
          : 0

        return {
          courseId: course.id,
          title: course.title,
          status: course.status,
          lessonCount,
          totalParticipants: participants.length,
          avgCompletionPct,
          participants,
        }
      })

      res.json(result)
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
