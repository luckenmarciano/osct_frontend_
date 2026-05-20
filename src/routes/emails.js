const express = require('express')
const { z } = require('zod')
const prisma = require('../lib/prisma')
const env = require('../config/env')
const { verifyJWT, requireRole } = require('../middleware/auth')
const { programIsolation } = require('../middleware/programIsolation')
const {
  sendCustomEmail,
  sendBroadcastEmails,
  sendSessionReminderEmail,
} = require('../services/email.service')

const router = express.Router()

// ─── Helpers ────────────────────────────────────────────────────────────────
async function getProgramRecipients(programId, filter = {}) {
  const { courseId, certEligible } = filter
  const enrollments = await prisma.programEnrollment.findMany({
    where: { program_id: programId },
    include: { user: { select: { id: true, email: true, full_name: true, is_active: true } } },
  })
  let users = enrollments
    .map((e) => e.user)
    .filter((u) => u && u.is_active && u.email)

  // Filter by course: only participants who started any lesson in this course
  if (courseId) {
    const lessons = await prisma.lesson.findMany({
      where: { module: { course_id: courseId } },
      select: { id: true },
    })
    const lessonIds = lessons.map((l) => l.id)
    if (lessonIds.length === 0) return []
    const progresses = await prisma.lessonProgress.findMany({
      where: { program_id: programId, lesson_id: { in: lessonIds } },
      select: { user_id: true },
    })
    const userIds = new Set(progresses.map((p) => p.user_id))
    users = users.filter((u) => userIds.has(u.id))
  }

  // Filter cert-eligible
  if (certEligible) {
    const certs = await prisma.certificate.findMany({
      where: { program_id: programId },
      select: { user_id: true },
    })
    const eligibleIds = new Set(certs.map((c) => c.user_id))
    users = users.filter((u) => eligibleIds.has(u.id))
  }

  return users
}

// ─── POST /emails/programs/:pid/send — send to specific recipients ──────────
router.post(
  '/programs/:pid/send',
  verifyJWT,
  requireRole('TRAINER', 'PROGRAM_ADMIN', 'SUPER_ADMIN'),
  programIsolation,
  async (req, res, next) => {
    try {
      const data = z
        .object({
          recipientUserIds: z.array(z.string()).min(1),
          subject: z.string().min(1).max(255),
          body: z.string().min(1).max(10000),
        })
        .parse(req.body)

      const users = await prisma.user.findMany({
        where: { id: { in: data.recipientUserIds }, is_active: true },
        select: { id: true, email: true, full_name: true },
      })

      // Confirm recipients are enrolled in this program
      const enrollments = await prisma.programEnrollment.findMany({
        where: { program_id: req.programId, user_id: { in: users.map((u) => u.id) } },
        select: { user_id: true },
      })
      const allowedIds = new Set(enrollments.map((e) => e.user_id))
      const recipients = users.filter((u) => allowedIds.has(u.id))

      if (recipients.length === 0) {
        return res.status(400).json({ error: 'No valid recipients in this program' })
      }

      const program = await prisma.oPRCProgram.findUnique({ where: { id: req.programId } })

      const results = await sendBroadcastEmails({
        recipients,
        subject: data.subject,
        body: data.body,
        programId: req.programId,
        programName: program?.name,
        sentById: req.user.id,
      })
      const sent = results.filter((r) => r.sent || r.mocked).length
      const failed = results.filter((r) => r.failed).length
      res.json({ total: results.length, sent, failed, results })
    } catch (err) {
      next(err)
    }
  }
)

// ─── POST /emails/programs/:pid/broadcast — broadcast with filter ───────────
router.post(
  '/programs/:pid/broadcast',
  verifyJWT,
  requireRole('TRAINER', 'PROGRAM_ADMIN', 'SUPER_ADMIN'),
  programIsolation,
  async (req, res, next) => {
    try {
      const data = z
        .object({
          subject: z.string().min(1).max(255),
          body: z.string().min(1).max(10000),
          filter: z
            .object({
              courseId: z.string().optional(),
              certEligible: z.boolean().optional(),
            })
            .optional()
            .default({}),
        })
        .parse(req.body)

      const recipients = await getProgramRecipients(req.programId, data.filter)
      if (recipients.length === 0) {
        return res.status(400).json({ error: 'No recipients match the filter' })
      }

      const program = await prisma.oPRCProgram.findUnique({ where: { id: req.programId } })

      const results = await sendBroadcastEmails({
        recipients,
        subject: data.subject,
        body: data.body,
        programId: req.programId,
        programName: program?.name,
        sentById: req.user.id,
      })
      const sent = results.filter((r) => r.sent || r.mocked).length
      const failed = results.filter((r) => r.failed).length
      res.json({ total: results.length, sent, failed, results })
    } catch (err) {
      next(err)
    }
  }
)

// ─── POST /emails/programs/:pid/session-reminder/:sessionId ────────────────
router.post(
  '/programs/:pid/session-reminder/:sessionId',
  verifyJWT,
  requireRole('TRAINER', 'PROGRAM_ADMIN', 'SUPER_ADMIN'),
  programIsolation,
  async (req, res, next) => {
    try {
      const session = await prisma.session.findUnique({
        where: { id: req.params.sessionId },
        include: { trainer: { select: { full_name: true } } },
      })
      if (!session) return res.status(404).json({ error: 'Session not found' })
      if (session.program_id !== req.programId) {
        return res.status(403).json({ error: 'Session not in this program' })
      }

      const recipients = await getProgramRecipients(req.programId, {})
      if (recipients.length === 0) {
        return res.status(400).json({ error: 'No active participants in this program' })
      }

      const program = await prisma.oPRCProgram.findUnique({ where: { id: req.programId } })

      const results = await sendSessionReminderEmail({
        recipients,
        session,
        programName: program?.name,
        sentById: req.user.id,
      })
      const sent = results.filter((r) => r.sent || r.mocked).length
      const failed = results.filter((r) => r.failed).length
      res.json({ total: results.length, sent, failed, results })
    } catch (err) {
      next(err)
    }
  }
)

// ─── GET /emails/cron/session-reminders ─────────────────────────────────────
// Hit by Vercel Cron (see vercel.json). Emails a reminder for every session
// scheduled within the next 24h that has not been reminded yet, then stamps
// reminder_sent_at so the next run skips it. Authenticated by CRON_SECRET, not
// a JWT — rejects everything when CRON_SECRET is unset (fail closed).
router.get('/cron/session-reminders', async (req, res, next) => {
  try {
    if (!env.CRON_SECRET || req.headers.authorization !== `Bearer ${env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const now = new Date()
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000)
    const sessions = await prisma.session.findMany({
      where: {
        scheduled_at: { gte: now, lte: in24h },
        reminder_sent_at: null,
      },
      include: {
        trainer: { select: { full_name: true } },
        program: { select: { name: true } },
      },
    })

    let totalSent = 0
    let totalFailed = 0
    for (const session of sessions) {
      const recipients = await getProgramRecipients(session.program_id, {})
      if (recipients.length > 0) {
        const results = await sendSessionReminderEmail({
          recipients,
          session,
          programName: session.program?.name,
          sentById: null,
        })
        totalSent += results.filter((r) => r.sent || r.mocked).length
        totalFailed += results.filter((r) => r.failed).length
      }
      await prisma.session.update({
        where: { id: session.id },
        data: { reminder_sent_at: new Date() },
      })
    }

    res.json({ sessionsProcessed: sessions.length, totalSent, totalFailed })
  } catch (err) {
    next(err)
  }
})

// ─── GET /emails/programs/:pid/logs ─────────────────────────────────────────
router.get(
  '/programs/:pid/logs',
  verifyJWT,
  requireRole('TRAINER', 'PROGRAM_ADMIN', 'SUPER_ADMIN'),
  programIsolation,
  async (req, res, next) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 100, 500)
      const logs = await prisma.emailLog.findMany({
        where: { program_id: req.programId },
        orderBy: { created_at: 'desc' },
        take: limit,
      })
      res.json(logs)
    } catch (err) {
      // Graceful response if table not yet migrated
      if (err?.code === 'P2021' || /does not exist/i.test(err.message || '')) {
        return res.json([])
      }
      next(err)
    }
  }
)

// ─── GET /emails/programs/:pid/recipients ───────────────────────────────────
// Helper for UI: list all candidate recipients (enrolled participants)
router.get(
  '/programs/:pid/recipients',
  verifyJWT,
  requireRole('TRAINER', 'PROGRAM_ADMIN', 'SUPER_ADMIN'),
  programIsolation,
  async (req, res, next) => {
    try {
      const filter = {
        courseId: req.query.courseId || undefined,
        certEligible: req.query.certEligible === 'true' || undefined,
      }
      const recipients = await getProgramRecipients(req.programId, filter)
      res.json(recipients)
    } catch (err) {
      next(err)
    }
  }
)

module.exports = router
