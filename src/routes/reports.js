const express = require('express')
const prisma = require('../lib/prisma')
const { verifyJWT, requireRole } = require('../middleware/auth')
const { programIsolation } = require('../middleware/programIsolation')
const env = require('../config/env')
const {
  htmlToPdfBuffer,
  buildProgressReportHTML,
  buildCoursesProgressReportHTML,
  buildAttendanceReportHTML,
} = require('../services/report.service')
const { sendScheduledReportEmail } = require('../services/email.service')

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

// ─── Shared data builders ───────────────────────────────────────────────────

// Per-participant progress rows for a program.
async function computeProgressRows(programId) {
  const enrollments = await prisma.programEnrollment.findMany({
    where: { program_id: programId },
    include: { user: { select: { id: true, full_name: true, email: true } } },
    orderBy: { enrolled_at: 'asc' },
  })
  return enrollments.map((e) => ({
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
}

// Per-course completion recap with per-participant breakdown.
async function computeCoursesProgress(programId) {
  const [courses, enrollments, progress] = await Promise.all([
    prisma.course.findMany({
      where: { program_id: programId },
      include: { modules: { include: { lessons: { select: { id: true } } } } },
      orderBy: { order_index: 'asc' },
    }),
    prisma.programEnrollment.findMany({
      where: { program_id: programId },
      include: { user: { select: { id: true, full_name: true, email: true } } },
      orderBy: { enrolled_at: 'asc' },
    }),
    prisma.lessonProgress.findMany({
      where: { program_id: programId, completed: true },
      select: { user_id: true, lesson_id: true },
    }),
  ])

  const completedByUser = new Map()
  for (const p of progress) {
    if (!completedByUser.has(p.user_id)) completedByUser.set(p.user_id, new Set())
    completedByUser.get(p.user_id).add(p.lesson_id)
  }

  return courses.map((course) => {
    const lessonIds = course.modules.flatMap((m) => m.lessons.map((l) => l.id))
    const lessonCount = lessonIds.length

    const participants = enrollments.map((e) => {
      const done = completedByUser.get(e.user.id) || new Set()
      const completedLessons = lessonIds.filter((id) => done.has(id)).length
      const completionPct = lessonCount > 0 ? (completedLessons / lessonCount) * 100 : 0
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
            participants.reduce((s, p) => s + p.completionPct, 0) / participants.length
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
}

// ─── Platform analytics overview (cross-program) ────────────────────────────

const RANGE_DAYS = { '7d': 7, '30d': 30, quarter: 90 }

// Empty payload when the caller has no accessible programs — keeps the
// timeline axis stable so the frontend never has to special-case length.
function emptyOverview(rangeDays) {
  const today = new Date()
  const timeline = []
  for (let i = rangeDays - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setUTCDate(d.getUTCDate() - i)
    timeline.push({ date: d.toISOString().slice(0, 10), watch: 0, quiz: 0 })
  }
  return {
    range: { days: rangeDays },
    programCount: 0,
    stats: { watchHours: 0, completionRatePct: 0, dropOffRatePct: 0, participants: 0 },
    heatmap: { moduleCount: 0, rows: [] },
    dropOff: [],
    byLevel: [],
    timeline,
  }
}

// Aggregate engagement / completion / drop-off across every program the
// caller may see (SUPER_ADMIN → all; others → JWT programIds).
async function computeAnalyticsOverview({ role, programIds, rangeDays }) {
  const programWhere = role === 'SUPER_ADMIN' ? {} : { id: { in: programIds } }

  const programs = await prisma.oPRCProgram.findMany({
    where: programWhere,
    select: { id: true, code: true, name: true, level: true },
    orderBy: [{ level: 'asc' }, { created_at: 'asc' }],
  })
  const pids = programs.map((p) => p.id)
  if (pids.length === 0) return emptyOverview(rangeDays)

  const [courses, enrollments, lessonProgress, watchSessions, quizAttempts, testAttempts] =
    await Promise.all([
      prisma.course.findMany({
        where: { program_id: { in: pids } },
        select: {
          id: true,
          program_id: true,
          order_index: true,
          modules: {
            select: {
              id: true,
              title: true,
              order_index: true,
              lessons: {
                select: {
                  id: true,
                  title: true,
                  video: { select: { id: true, duration_sec: true } },
                },
              },
            },
            orderBy: { order_index: 'asc' },
          },
        },
        orderBy: { order_index: 'asc' },
      }),
      prisma.programEnrollment.findMany({
        where: { program_id: { in: pids } },
        select: { program_id: true, user_id: true },
      }),
      prisma.lessonProgress.findMany({
        where: { program_id: { in: pids }, completed: true },
        select: { program_id: true },
      }),
      prisma.videoWatchSession.findMany({
        where: { program_id: { in: pids } },
        select: {
          video_id: true,
          watch_pct: true,
          completed: true,
          last_watched_at: true,
        },
      }),
      prisma.quizAttempt.findMany({
        where: { program_id: { in: pids }, submitted_at: { not: null } },
        select: { submitted_at: true },
      }),
      prisma.testAttempt.findMany({
        where: { program_id: { in: pids }, submitted_at: { not: null } },
        select: { submitted_at: true },
      }),
    ])

  // ── Structure maps ────────────────────────────────────────────────────────
  const videoMeta = new Map() // video_id → { durationSec, moduleId/Title, lessonId/Title }
  const modulesByProgram = new Map() // program_id → ordered [{ id, title, videoIds }]
  const lessonCountByProgram = new Map() // program_id → total lesson count
  const programLevel = new Map(programs.map((p) => [p.id, p.level]))
  for (const p of programs) {
    modulesByProgram.set(p.id, [])
    lessonCountByProgram.set(p.id, 0)
  }

  const coursesByProgram = new Map()
  for (const c of courses) {
    if (!coursesByProgram.has(c.program_id)) coursesByProgram.set(c.program_id, [])
    coursesByProgram.get(c.program_id).push(c)
  }
  for (const [pid, cs] of coursesByProgram) {
    cs.sort((a, b) => a.order_index - b.order_index)
    const moduleList = []
    let lessonTotal = 0
    for (const c of cs) {
      const mods = [...c.modules].sort((a, b) => a.order_index - b.order_index)
      for (const m of mods) {
        const videoIds = []
        for (const l of m.lessons) {
          lessonTotal += 1
          if (l.video) {
            videoIds.push(l.video.id)
            videoMeta.set(l.video.id, {
              durationSec: l.video.duration_sec || 0,
              moduleId: m.id,
              moduleTitle: m.title,
              lessonId: l.id,
              lessonTitle: l.title,
            })
          }
        }
        moduleList.push({ id: m.id, title: m.title, videoIds })
      }
    }
    modulesByProgram.set(pid, moduleList)
    lessonCountByProgram.set(pid, lessonTotal)
  }

  // ── Stats: watch-time, completion, drop-off, participants ─────────────────
  const STARTED_PCT = 5
  const FINISHED_PCT = 90

  let watchSeconds = 0
  let totalStarted = 0
  let totalDropped = 0
  const dropByVideo = new Map() // video_id → { started, dropped }
  const watchByModule = new Map() // module_id → { sum, count } of watch_pct

  for (const w of watchSessions) {
    const meta = videoMeta.get(w.video_id)
    if (!meta) continue
    watchSeconds += (w.watch_pct / 100) * meta.durationSec

    let mod = watchByModule.get(meta.moduleId)
    if (!mod) {
      mod = { sum: 0, count: 0 }
      watchByModule.set(meta.moduleId, mod)
    }
    mod.sum += w.watch_pct
    mod.count += 1

    if (w.watch_pct >= STARTED_PCT) {
      const finished = w.completed || w.watch_pct >= FINISHED_PCT
      totalStarted += 1
      if (!finished) totalDropped += 1
      let agg = dropByVideo.get(w.video_id)
      if (!agg) {
        agg = { started: 0, dropped: 0 }
        dropByVideo.set(w.video_id, agg)
      }
      agg.started += 1
      if (!finished) agg.dropped += 1
    }
  }

  let possibleLessons = 0
  const participantSet = new Set()
  for (const e of enrollments) {
    possibleLessons += lessonCountByProgram.get(e.program_id) || 0
    participantSet.add(e.user_id)
  }

  const stats = {
    watchHours: Number((watchSeconds / 3600).toFixed(1)),
    completionRatePct:
      possibleLessons > 0
        ? Number(((lessonProgress.length / possibleLessons) * 100).toFixed(1))
        : 0,
    dropOffRatePct:
      totalStarted > 0 ? Number(((totalDropped / totalStarted) * 100).toFixed(1)) : 0,
    participants: participantSet.size,
  }

  // ── Drop-off list: video lessons ranked by drop-off rate ──────────────────
  const dropOff = []
  for (const [videoId, agg] of dropByVideo) {
    const meta = videoMeta.get(videoId)
    if (!meta || agg.started === 0) continue
    dropOff.push({
      lessonId: meta.lessonId,
      title: meta.lessonTitle,
      moduleTitle: meta.moduleTitle,
      startedCount: agg.started,
      dropOffPct: Number(((agg.dropped / agg.started) * 100).toFixed(1)),
    })
  }
  dropOff.sort(
    (a, b) => b.dropOffPct - a.dropOffPct || b.startedCount - a.startedCount
  )

  // ── Heatmap: programs × module ordinal, cell = avg watch_pct ──────────────
  let moduleCount = 0
  const heatmapRows = programs.map((p) => {
    const mods = modulesByProgram.get(p.id) || []
    moduleCount = Math.max(moduleCount, mods.length)
    const cells = mods.map((m) => {
      const agg = watchByModule.get(m.id)
      if (!agg || agg.count === 0) return null
      return Number((agg.sum / agg.count).toFixed(0))
    })
    return { programId: p.id, code: p.code, name: p.name, level: p.level, cells }
  })

  // ── Progress by OPRC level ────────────────────────────────────────────────
  const levelAgg = new Map() // level → { participants:Set, possible, completed }
  const levelBucket = (lvl) => {
    if (!levelAgg.has(lvl)) {
      levelAgg.set(lvl, { participants: new Set(), possible: 0, completed: 0 })
    }
    return levelAgg.get(lvl)
  }
  for (const p of programs) levelBucket(p.level)
  for (const e of enrollments) {
    const b = levelBucket(programLevel.get(e.program_id))
    b.participants.add(e.user_id)
    b.possible += lessonCountByProgram.get(e.program_id) || 0
  }
  for (const lp of lessonProgress) {
    const lvl = programLevel.get(lp.program_id)
    if (lvl != null) levelBucket(lvl).completed += 1
  }
  const byLevel = [...levelAgg.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([level, b]) => ({
      level,
      participants: b.participants.size,
      completionPct:
        b.possible > 0 ? Number(((b.completed / b.possible) * 100).toFixed(1)) : 0,
    }))

  // ── Engagement timeline: daily watch + quiz/test activity ─────────────────
  const dayIndex = new Map()
  const timeline = []
  const today = new Date()
  for (let i = rangeDays - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setUTCDate(d.getUTCDate() - i)
    const key = d.toISOString().slice(0, 10)
    dayIndex.set(key, timeline.length)
    timeline.push({ date: key, watch: 0, quiz: 0 })
  }
  for (const w of watchSessions) {
    if (!w.last_watched_at) continue
    const idx = dayIndex.get(w.last_watched_at.toISOString().slice(0, 10))
    if (idx != null) timeline[idx].watch += 1
  }
  for (const a of [...quizAttempts, ...testAttempts]) {
    if (!a.submitted_at) continue
    const idx = dayIndex.get(a.submitted_at.toISOString().slice(0, 10))
    if (idx != null) timeline[idx].quiz += 1
  }

  return {
    range: { days: rangeDays },
    programCount: programs.length,
    stats,
    heatmap: { moduleCount, rows: heatmapRows },
    dropOff: dropOff.slice(0, 6),
    byLevel,
    timeline,
  }
}

// GET /api/v1/reports/programs/:pid/progress — participants progress
router.get(
  '/programs/:pid/progress',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      const data = await computeProgressRows(req.programId)
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
      const result = await computeCoursesProgress(req.programId)
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
        include: { certificate: { select: { claimed_at: true } } },
      })
      const total = enrollments.length
      const withPosttest = enrollments.filter((e) => e.posttest_score != null)
      const eligible = enrollments.filter((e) => e.cert_eligible).length
      // FR-10.4: certified = certificate claimed; certPending = eligible but not yet claimed.
      const certified = enrollments.filter((e) => e.certificate?.claimed_at).length
      const certPending = enrollments.filter(
        (e) => e.cert_eligible && !e.certificate?.claimed_at
      ).length
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
        certified,
        certPending,
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

// ─── Export endpoints (CSV + PDF) ───────────────────────────────────────────

function reportFilename(program, base, ext) {
  const safe = (program?.code || 'program').replace(/[^a-zA-Z0-9-]/g, '-')
  const dateStr = new Date().toISOString().slice(0, 10)
  return `${base}-${safe}-${dateStr}.${ext}`
}

// GET /api/v1/reports/programs/:pid/courses-progress.csv
router.get(
  '/programs/:pid/courses-progress.csv',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      const [program, courses] = await Promise.all([
        prisma.oPRCProgram.findUnique({ where: { id: req.programId } }),
        computeCoursesProgress(req.programId),
      ])

      const headers = [
        'Course', 'Status', 'Jumlah Pelajaran', 'Peserta',
        'Modul Selesai', '% Selesai', 'Posttest',
      ]
      const lines = [headers.join(',')]
      for (const c of courses) {
        if (c.participants.length === 0) {
          lines.push([c.title, c.status, c.lessonCount, 0, '', '', ''].map(escapeCsv).join(','))
          continue
        }
        for (const p of c.participants) {
          lines.push(
            [
              c.title,
              c.status,
              c.lessonCount,
              p.name,
              p.completedLessons,
              fmtNum(p.completionPct),
              fmtNum(p.posttestScore),
            ].map(escapeCsv).join(',')
          )
        }
      }
      const csv = '﻿' + lines.join('\r\n') + '\r\n'

      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${reportFilename(program, 'courses-progress', 'csv')}"`
      )
      res.send(csv)
    } catch (err) {
      next(err)
    }
  }
)

// GET /api/v1/reports/programs/:pid/progress.pdf
router.get(
  '/programs/:pid/progress.pdf',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      const [program, rows] = await Promise.all([
        prisma.oPRCProgram.findUnique({ where: { id: req.programId } }),
        computeProgressRows(req.programId),
      ])
      const html = buildProgressReportHTML({
        program,
        rows,
        generatedAt: new Date().toLocaleString('id-ID'),
      })
      const pdf = await htmlToPdfBuffer(html)
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${reportFilename(program, 'progress', 'pdf')}"`
      )
      res.send(pdf)
    } catch (err) {
      if (/puppeteer/i.test(err.message || '')) {
        return res.status(503).json({ error: 'PDF generation tidak tersedia' })
      }
      next(err)
    }
  }
)

// GET /api/v1/reports/programs/:pid/courses-progress.pdf
router.get(
  '/programs/:pid/courses-progress.pdf',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      const [program, courses] = await Promise.all([
        prisma.oPRCProgram.findUnique({ where: { id: req.programId } }),
        computeCoursesProgress(req.programId),
      ])
      const html = buildCoursesProgressReportHTML({
        program,
        courses,
        generatedAt: new Date().toLocaleString('id-ID'),
      })
      const pdf = await htmlToPdfBuffer(html)
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${reportFilename(program, 'courses-progress', 'pdf')}"`
      )
      res.send(pdf)
    } catch (err) {
      if (/puppeteer/i.test(err.message || '')) {
        return res.status(503).json({ error: 'PDF generation tidak tersedia' })
      }
      next(err)
    }
  }
)

// GET /api/v1/reports/analytics/overview?range=7d|30d|quarter
// Cross-program analytics. No programIsolation — access is scoped inside
// computeAnalyticsOverview via the caller's JWT programIds.
router.get(
  '/analytics/overview',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  async (req, res, next) => {
    try {
      const rangeDays = RANGE_DAYS[req.query.range] || 30
      const overview = await computeAnalyticsOverview({
        role: req.user.role,
        programIds: req.user.programIds || [],
        rangeDays,
      })
      res.json(overview)
    } catch (err) {
      next(err)
    }
  }
)

// ─── Attendance report (per session) ────────────────────────────────────────

// Per-session attendance rows for a program.
async function computeAttendanceRows(programId) {
  const sessions = await prisma.session.findMany({
    where: { program_id: programId },
    include: {
      trainer: { select: { full_name: true } },
      attendances: { select: { is_flagged: true } },
    },
    orderBy: { scheduled_at: 'asc' },
  })
  return sessions.map((s) => ({
    sessionId: s.id,
    title: s.title,
    scheduledAt: s.scheduled_at,
    location: s.location,
    trainer: s.trainer?.full_name || null,
    attended: s.attendances.length,
    flagged: s.attendances.filter((a) => a.is_flagged).length,
  }))
}

// GET /api/v1/reports/programs/:pid/attendance
router.get(
  '/programs/:pid/attendance',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      res.json(await computeAttendanceRows(req.programId))
    } catch (err) {
      next(err)
    }
  }
)

// GET /api/v1/reports/programs/:pid/attendance.csv
router.get(
  '/programs/:pid/attendance.csv',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      const [program, rows] = await Promise.all([
        prisma.oPRCProgram.findUnique({ where: { id: req.programId } }),
        computeAttendanceRows(req.programId),
      ])
      const headers = ['Sesi', 'Jadwal', 'Lokasi', 'Trainer', 'Hadir', 'Ditandai']
      const lines = [headers.join(',')]
      for (const r of rows) {
        lines.push(
          [
            r.title,
            r.scheduledAt ? new Date(r.scheduledAt).toISOString() : '',
            r.location || '',
            r.trainer || '',
            r.attended,
            r.flagged,
          ].map(escapeCsv).join(',')
        )
      }
      const csv = '﻿' + lines.join('\r\n') + '\r\n'
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${reportFilename(program, 'attendance', 'csv')}"`
      )
      res.send(csv)
    } catch (err) {
      next(err)
    }
  }
)

// GET /api/v1/reports/programs/:pid/attendance.pdf
router.get(
  '/programs/:pid/attendance.pdf',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      const [program, rows] = await Promise.all([
        prisma.oPRCProgram.findUnique({ where: { id: req.programId } }),
        computeAttendanceRows(req.programId),
      ])
      const html = buildAttendanceReportHTML({
        program,
        rows,
        generatedAt: new Date().toLocaleString('id-ID'),
      })
      const pdf = await htmlToPdfBuffer(html)
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${reportFilename(program, 'attendance', 'pdf')}"`
      )
      res.send(pdf)
    } catch (err) {
      if (/puppeteer/i.test(err.message || '')) {
        return res.status(503).json({ error: 'PDF generation tidak tersedia' })
      }
      next(err)
    }
  }
)

// ─── FR-27: Report schedules ──────────────────────────────────────────────────

// GET /api/v1/reports/programs/:pid/schedules
router.get(
  '/programs/:pid/schedules',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  programIsolation,
  async (req, res, next) => {
    try {
      const schedules = await prisma.reportSchedule.findMany({
        where: { program_id: req.programId },
        orderBy: { created_at: 'desc' },
      })
      res.json(schedules)
    } catch (err) {
      next(err)
    }
  }
)

// POST /api/v1/reports/programs/:pid/schedules
const { z } = require('zod')
router.post(
  '/programs/:pid/schedules',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  programIsolation,
  async (req, res, next) => {
    try {
      const data = z.object({
        report_type: z.enum(['PARTICIPANTS', 'COURSES', 'ATTENDANCE']),
        frequency:   z.enum(['WEEKLY', 'MONTHLY']),
        email:       z.string().email(),
      }).parse(req.body)

      const schedule = await prisma.reportSchedule.create({
        data: { ...data, program_id: req.programId, admin_id: req.user.id },
      })
      res.status(201).json(schedule)
    } catch (err) {
      next(err)
    }
  }
)

// PATCH /api/v1/reports/programs/:pid/schedules/:id — toggle active
router.patch(
  '/programs/:pid/schedules/:id',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  programIsolation,
  async (req, res, next) => {
    try {
      const { is_active } = z.object({ is_active: z.boolean() }).parse(req.body)
      const schedule = await prisma.reportSchedule.findFirst({
        where: { id: req.params.id, program_id: req.programId },
      })
      if (!schedule) return res.status(404).json({ error: 'Schedule not found' })
      const updated = await prisma.reportSchedule.update({
        where: { id: schedule.id },
        data: { is_active },
      })
      res.json(updated)
    } catch (err) {
      next(err)
    }
  }
)

// DELETE /api/v1/reports/programs/:pid/schedules/:id
router.delete(
  '/programs/:pid/schedules/:id',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  programIsolation,
  async (req, res, next) => {
    try {
      const schedule = await prisma.reportSchedule.findFirst({
        where: { id: req.params.id, program_id: req.programId },
      })
      if (!schedule) return res.status(404).json({ error: 'Schedule not found' })
      await prisma.reportSchedule.delete({ where: { id: schedule.id } })
      res.json({ ok: true })
    } catch (err) {
      next(err)
    }
  }
)

// GET /api/v1/reports/cron/scheduled-exports — FR-27 Cron (daily)
// Runs active schedules that are due: WEEKLY = 7 days since last_sent_at,
// MONTHLY = 30 days. Generates CSV and emails it to the schedule's email.
router.get('/cron/scheduled-exports', async (req, res, next) => {
  try {
    if (!env.CRON_SECRET || req.headers.authorization !== `Bearer ${env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const now = new Date()
    const schedules = await prisma.reportSchedule.findMany({
      where: { is_active: true },
      include: {
        program: true,
        admin: { select: { full_name: true } },
      },
    })

    let sent = 0, skipped = 0, failed = 0

    for (const sched of schedules) {
      // Check if due
      const intervalMs = sched.frequency === 'WEEKLY'
        ? 7  * 24 * 60 * 60 * 1000
        : 30 * 24 * 60 * 60 * 1000
      const isDue = !sched.last_sent_at || (now - sched.last_sent_at) >= intervalMs
      if (!isDue) { skipped++; continue }

      try {
        // Generate CSV content
        let csvContent = ''
        if (sched.report_type === 'PARTICIPANTS') {
          const rows = await computeProgressRows(sched.program_id)
          const headers = ['Nama','Email','Pretest','Posttest','Gain','Attendance%','Eligible']
          const lines = rows.map((r) => [r.name, r.email, r.pretest ?? '', r.posttest ?? '', r.gain ?? '', r.attendance ?? '', r.certEligible ? 'Yes' : 'No'].map(escapeCsv).join(','))
          csvContent = '﻿' + [headers.join(','), ...lines].join('\r\n') + '\r\n'
        } else if (sched.report_type === 'ATTENDANCE') {
          const sessions = await prisma.session.findMany({
            where: { program_id: sched.program_id },
            include: { attendances: { include: { user: { select: { full_name: true, email: true } } } } },
            orderBy: { scheduled_at: 'desc' },
            take: 50,
          })
          const headers = ['Sesi','Tanggal','Peserta','Email','Flagged']
          const lines = sessions.flatMap((s) =>
            s.attendances.map((a) =>
              [s.title, s.scheduled_at.toISOString().slice(0,10), a.user.full_name, a.user.email, a.is_flagged ? 'Ya' : 'Tidak'].map(escapeCsv).join(',')
            )
          )
          csvContent = '﻿' + [headers.join(','), ...lines].join('\r\n') + '\r\n'
        } else {
          const courses = await computeCoursesProgress(sched.program_id)
          const headers = ['Kursus','Total Lesson','Peserta','Selesai']
          const lines = courses.map((c) => [c.title, c.totalLessons, c.enrolledCount, c.completedCount ?? 0].map(escapeCsv).join(','))
          csvContent = '﻿' + [headers.join(','), ...lines].join('\r\n') + '\r\n'
        }

        await sendScheduledReportEmail({
          to: sched.email,
          adminName: sched.admin?.full_name,
          programName: sched.program.name,
          reportType: sched.report_type,
          csvContent,
          programId: sched.program_id,
        })

        await prisma.reportSchedule.update({
          where: { id: sched.id },
          data: { last_sent_at: now },
        })
        sent++
      } catch (e) {
        console.error('[scheduled-exports] schedule', sched.id, e.message)
        failed++
      }
    }

    res.json({ schedulesChecked: schedules.length, sent, skipped, failed })
  } catch (err) {
    next(err)
  }
})

module.exports = router
