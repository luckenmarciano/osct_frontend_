const express = require('express')
const bcrypt = require('bcryptjs')
const { z } = require('zod')
const prisma = require('../lib/prisma')
const { verifyJWT, requireRole, signQRToken } = require('../middleware/auth')
const { programIsolation } = require('../middleware/programIsolation')
const { generateLoginQR } = require('../services/qr.service')
const { sendLoginQREmail, sendCustomEmail } = require('../services/email.service')
const { auditLog } = require('../services/audit.service')
const { createNotif } = require('../services/notification.service')
const { upload } = require('../middleware/upload')
const {
  importParticipantsCSV,
  REQUIRED_COLUMNS,
} = require('../services/participantImport.service')

const router = express.Router()

// GET /api/v1/programs — list programs visible to the user
router.get('/', verifyJWT, async (req, res, next) => {
  try {
    const { role, programIds } = req.user
    const where = role === 'SUPER_ADMIN' ? {} : { id: { in: programIds } }
    const programs = await prisma.oPRCProgram.findMany({
      where,
      orderBy: { level: 'asc' },
      include: {
        trainers: {
          include: {
            user: { select: { id: true, full_name: true, email: true } },
          },
        },
      },
    })
    res.json(programs)
  } catch (err) {
    next(err)
  }
})

// ─── Trainer-facing assignment notifications ────────────────────────────────
// Declared BEFORE /:pid so "trainer" is not captured as a program id.

// GET /api/v1/programs/trainer/assignments/pending — unacknowledged assignments
router.get('/trainer/assignments/pending', verifyJWT, async (req, res, next) => {
  try {
    const pending = await prisma.programTrainer.findMany({
      where: { user_id: req.user.id, acknowledged_at: null },
      include: { program: true },
      orderBy: { assigned_at: 'desc' },
    })
    res.json(pending)
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/programs/trainer/assignments/acknowledge — mark all as seen
router.post('/trainer/assignments/acknowledge', verifyJWT, async (req, res, next) => {
  try {
    await prisma.programTrainer.updateMany({
      where: { user_id: req.user.id, acknowledged_at: null },
      data: { acknowledged_at: new Date() },
    })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/programs/:pid — detail
router.get('/:pid', verifyJWT, programIsolation, async (req, res, next) => {
  try {
    const program = await prisma.oPRCProgram.findUnique({
      where: { id: req.programId },
      include: {
        _count: {
          select: {
            enrollments: true,
            courses: true,
            certificates: { where: { claimed_at: { not: null } } },
          },
        },
      },
    })
    if (!program) return res.status(404).json({ error: 'Program not found' })
    res.json(program)
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/programs/:pid/enrollments — list participants
router.get(
  '/:pid/enrollments',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      const enrollments = await prisma.programEnrollment.findMany({
        where: { program_id: req.programId },
        include: {
          user: { select: { id: true, email: true, full_name: true } },
          certificate: true,
        },
        orderBy: { enrolled_at: 'desc' },
      })
      res.json(enrollments)
    } catch (err) {
      next(err)
    }
  }
)

// FR-22: Shared quota guard — checks if enrolling N more participants would exceed
// the minimum quota across published courses in this program.
// Returns { isFull, quota, enrolledCount } or null if no quota is set.
async function checkCourseQuota(programId, addingCount = 1) {
  const restrictiveCourse = await prisma.course.findFirst({
    where: { program_id: programId, status: 'PUBLISHED', quota: { not: null } },
    orderBy: { quota: 'asc' }, // most restrictive first
    select: { quota: true, title: true },
  })
  if (!restrictiveCourse) return null // no quota set
  const enrolledCount = await prisma.programEnrollment.count({ where: { program_id: programId } })
  return {
    isFull: enrolledCount + addingCount > restrictiveCourse.quota,
    quota: restrictiveCourse.quota,
    enrolledCount,
    courseTitle: restrictiveCourse.title,
  }
}

// POST /api/v1/programs/:pid/enrollments — enroll a participant
router.post(
  '/:pid/enrollments',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  programIsolation,
  async (req, res, next) => {
    try {
      const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body)

      // FR-22: quota check (skip if participant is already enrolled — re-enroll is a no-op)
      const alreadyEnrolled = await prisma.programEnrollment.findUnique({
        where: { user_id_program_id: { user_id: userId, program_id: req.programId } },
      })
      if (!alreadyEnrolled) {
        const quota = await checkCourseQuota(req.programId)
        if (quota?.isFull) {
          return res.status(409).json({
            error: `Kuota kursus penuh (${quota.enrolledCount}/${quota.quota})`,
            code: 'QUOTA_FULL',
          })
        }
      }

      const enrollment = await prisma.programEnrollment.upsert({
        where: { user_id_program_id: { user_id: userId, program_id: req.programId } },
        update: {},
        create: { user_id: userId, program_id: req.programId },
      })
      res.status(201).json(enrollment)
    } catch (err) {
      next(err)
    }
  }
)

// POST /api/v1/programs/:pid/participants — create user + enroll + optional QR email
router.post(
  '/:pid/participants',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  programIsolation,
  async (req, res, next) => {
    try {
      const data = z
        .object({
          email: z.string().email(),
          fullName: z.string().min(1),
          password: z.string().min(6).optional(),
          company: z.string().optional(),
          trainingMode: z.enum(['INHOUSE', 'PUBLIC']).optional(),
          sendQrEmail: z.boolean().optional().default(false),
        })
        .parse(req.body)

      const existing = await prisma.user.findUnique({ where: { email: data.email } })
      if (existing) {
        return res.status(409).json({ error: 'Email sudah terdaftar' })
      }

      // FR-22: quota check before creating the user
      const quota = await checkCourseQuota(req.programId)
      if (quota?.isFull) {
        return res.status(409).json({
          error: `Kuota kursus penuh (${quota.enrolledCount}/${quota.quota})`,
          code: 'QUOTA_FULL',
        })
      }

      // Auto-generate password if not provided
      const plainPassword =
        data.password || Math.random().toString(36).slice(-10) + 'A1!'
      const hash = await bcrypt.hash(plainPassword, 10)

      const user = await prisma.user.create({
        data: {
          email: data.email,
          full_name: data.fullName,
          password_hash: hash,
          role: 'PARTICIPANT',
        },
        select: { id: true, email: true, full_name: true, role: true },
      })

      const enrollment = await prisma.programEnrollment.create({
        data: {
          user_id: user.id,
          program_id: req.programId,
        },
        include: {
          user: { select: { id: true, email: true, full_name: true } },
          certificate: true,
        },
      })

      // Store company + training mode on the participant profile. The user is
      // always brand new here (existing emails are rejected with 409 above),
      // so a plain create is safe.
      await prisma.participantProfile.create({
        data: {
          user_id: user.id,
          client_company: data.company || null,
          training_mode: data.trainingMode || null,
        },
      })

      let emailResult = null
      if (data.sendQrEmail) {
        const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
        const qrToken = signQRToken({ userId: user.id, programId: req.programId })

        await prisma.participantLoginQR.upsert({
          where: { user_id_program_id: { user_id: user.id, program_id: req.programId } },
          update: { qr_token: qrToken, expires_at: expiresAt },
          create: {
            user_id: user.id,
            program_id: req.programId,
            qr_token: qrToken,
            expires_at: expiresAt,
          },
        })

        const qrPngDataUrl = await generateLoginQR(qrToken)
        const program = await prisma.oPRCProgram.findUnique({
          where: { id: req.programId },
        })

        const sendResult = await sendLoginQREmail({
          to: user.email,
          participantName: user.full_name,
          programName: program?.name || '',
          qrPngDataUrl,
          expiresAt,
          sentById: req.user.id,
          programId: req.programId,
        })
        emailResult = { sent: true, mocked: !!sendResult?.mocked }
      }

      auditLog({
        action: 'PARTICIPANT_CREATED',
        userId: req.user.id,
        programId: req.programId,
        resourceType: 'enrollment',
        resourceId: enrollment.id,
        metadata: {
          email: user.email,
          qrEmailed: !!data.sendQrEmail,
          trainingMode: data.trainingMode || null,
          company: data.company || null,
        },
        req,
      })

      res.status(201).json({
        enrollment,
        password: data.password ? undefined : plainPassword, // return auto-generated password once
        emailResult,
      })
    } catch (err) {
      next(err)
    }
  }
)

// POST /api/v1/programs/:pid/enrollments/:eid/qr — generate participant login QR
router.post(
  '/:pid/enrollments/:eid/qr',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  programIsolation,
  async (req, res, next) => {
    try {
      const { eid } = req.params
      const enrollment = await prisma.programEnrollment.findFirst({
        where: { id: eid, program_id: req.programId },
      })
      if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' })

      const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      const qrToken = signQRToken({
        userId: enrollment.user_id,
        programId: enrollment.program_id,
      })

      await prisma.participantLoginQR.upsert({
        where: {
          user_id_program_id: {
            user_id: enrollment.user_id,
            program_id: enrollment.program_id,
          },
        },
        update: { qr_token: qrToken, expires_at: expiresAt },
        create: {
          user_id: enrollment.user_id,
          program_id: enrollment.program_id,
          qr_token: qrToken,
          expires_at: expiresAt,
        },
      })

      const qrPngDataUrl = await generateLoginQR(qrToken)
      res.json({ qrToken, qrPngDataUrl, expiresAt })
    } catch (err) {
      next(err)
    }
  }
)

// POST /api/v1/programs/:pid/enrollments/:eid/qr/email — generate + send QR to participant
router.post(
  '/:pid/enrollments/:eid/qr/email',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  programIsolation,
  async (req, res, next) => {
    try {
      const { eid } = req.params
      const enrollment = await prisma.programEnrollment.findFirst({
        where: { id: eid, program_id: req.programId },
        include: {
          user: { select: { id: true, email: true, full_name: true } },
        },
      })
      if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' })
      if (!enrollment.user?.email) {
        return res.status(400).json({ error: 'Participant has no email' })
      }

      const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      const qrToken = signQRToken({
        userId: enrollment.user_id,
        programId: enrollment.program_id,
      })

      await prisma.participantLoginQR.upsert({
        where: {
          user_id_program_id: {
            user_id: enrollment.user_id,
            program_id: enrollment.program_id,
          },
        },
        update: { qr_token: qrToken, expires_at: expiresAt },
        create: {
          user_id: enrollment.user_id,
          program_id: enrollment.program_id,
          qr_token: qrToken,
          expires_at: expiresAt,
        },
      })

      const qrPngDataUrl = await generateLoginQR(qrToken)
      const program = await prisma.oPRCProgram.findUnique({ where: { id: req.programId } })

      const sendResult = await sendLoginQREmail({
        to: enrollment.user.email,
        participantName: enrollment.user.full_name,
        programName: program?.name || '',
        qrPngDataUrl,
        expiresAt,
        sentById: req.user.id,
        programId: req.programId,
      })

      auditLog({
        action: 'QR_LOGIN_SENT',
        userId: req.user.id,
        programId: req.programId,
        resourceType: 'enrollment',
        resourceId: enrollment.id,
        metadata: { to: enrollment.user.email, mocked: !!sendResult?.mocked },
        req,
      })

      res.json({
        ok: true,
        mocked: !!sendResult?.mocked,
        sentTo: enrollment.user.email,
        expiresAt,
      })
    } catch (err) {
      next(err)
    }
  }
)

// GET /api/v1/programs/:pid/participants/import/template — download empty CSV with required headers
router.get(
  '/:pid/participants/import/template',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  programIsolation,
  async (req, res, next) => {
    try {
      const header = REQUIRED_COLUMNS.join(',')
      const sample = REQUIRED_COLUMNS.map(() => '').join(',')
      const csv = '﻿' + header + '\r\n' + sample + '\r\n'
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="participant-import-template.csv"')
      res.send(csv)
    } catch (err) {
      next(err)
    }
  }
)

// POST /api/v1/programs/:pid/participants/import — batch CSV import (FR-4.2)
router.post(
  '/:pid/participants/import',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  programIsolation,
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'CSV file is required' })
      const isCsv =
        req.file.mimetype === 'text/csv' ||
        /\.csv$/i.test(req.file.originalname || '')
      if (!isCsv) {
        return res.status(400).json({ error: 'File harus berupa CSV (.csv)' })
      }

      const sendQrEmail = req.body.sendQrEmail === 'true' || req.body.sendQrEmail === '1'

      // FR-22: pass quota info to import service so it can warn/truncate
      const quotaInfo = await checkCourseQuota(req.programId, 0) // 0 = just get state, not checking +1

      const result = await importParticipantsCSV({
        csvBuffer: req.file.buffer,
        programId: req.programId,
        sendQrEmail,
        actingUserId: req.user.id,
        req,
        quotaInfo, // FR-22: imported service may attach quota warning to result
      })

      res.json(result)
    } catch (err) {
      next(err)
    }
  }
)

// ─── Trainer assignment (admin) ─────────────────────────────────────────────

// GET /api/v1/programs/:pid/trainers — list trainers assigned to a program
router.get(
  '/:pid/trainers',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  programIsolation,
  async (req, res, next) => {
    try {
      const trainers = await prisma.programTrainer.findMany({
        where: { program_id: req.programId },
        include: {
          user: { select: { id: true, full_name: true, email: true } },
        },
        orderBy: { assigned_at: 'asc' },
      })
      res.json(trainers)
    } catch (err) {
      next(err)
    }
  }
)

// POST /api/v1/programs/:pid/trainers — assign a trainer + notify by email
router.post(
  '/:pid/trainers',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  programIsolation,
  async (req, res, next) => {
    try {
      const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body)

      const user = await prisma.user.findUnique({ where: { id: userId } })
      if (!user) return res.status(404).json({ error: 'User tidak ditemukan' })
      if (user.role !== 'TRAINER') {
        return res.status(400).json({ error: 'User bukan trainer' })
      }

      const existing = await prisma.programTrainer.findUnique({
        where: { user_id_program_id: { user_id: userId, program_id: req.programId } },
      })
      if (existing) {
        return res.status(409).json({ error: 'Trainer sudah di-assign ke program ini' })
      }

      const assignment = await prisma.programTrainer.create({
        data: { user_id: userId, program_id: req.programId },
        include: { user: { select: { id: true, full_name: true, email: true } } },
      })

      const program = await prisma.oPRCProgram.findUnique({ where: { id: req.programId } })

      // Email notification (non-fatal on failure)
      if (user.email) {
        const subject = `[OSCT] Anda ditugaskan sebagai trainer — ${program?.name || ''}`
        const body =
          `Halo ${user.full_name},\n\n` +
          `Anda telah ditugaskan sebagai trainer untuk program ${program?.name || ''}.\n\n` +
          `Silakan masuk ke aplikasi OSCT untuk melihat kursus, peserta, dan jadwal program tersebut.\n\n` +
          `Terima kasih.`
        sendCustomEmail({
          to: user.email,
          toName: user.full_name,
          subject,
          body,
          programId: req.programId,
          programName: program?.name,
          sentById: req.user.id,
        }).catch((e) => console.error('[trainer-assign email]', e.message))
      }

      // In-app notification (non-fatal)
      createNotif({
        userId:    userId,
        type:      'TRAINER_ASSIGNED',
        title:     `Anda ditugaskan sebagai trainer: ${program?.name || ''}`,
        body:      `Buka halaman Dashboard atau Sesi untuk melihat detail program.`,
        programId: req.programId,
        refId:     `trainer-${userId}-${req.programId}`,
      }).catch((e) => console.error('[trainer-assign notif]', e.message))

      auditLog({
        action: 'TRAINER_ASSIGNED',
        userId: req.user.id,
        programId: req.programId,
        resourceType: 'program_trainer',
        resourceId: assignment.id,
        metadata: { trainerId: userId, trainerEmail: user.email },
        req,
      })

      res.status(201).json(assignment)
    } catch (err) {
      next(err)
    }
  }
)

// DELETE /api/v1/programs/:pid/trainers/:userId — unassign a trainer
router.delete(
  '/:pid/trainers/:userId',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  programIsolation,
  async (req, res, next) => {
    try {
      const existing = await prisma.programTrainer.findUnique({
        where: {
          user_id_program_id: {
            user_id: req.params.userId,
            program_id: req.programId,
          },
        },
      })
      if (!existing) return res.status(404).json({ error: 'Assignment tidak ditemukan' })

      await prisma.programTrainer.delete({ where: { id: existing.id } })

      auditLog({
        action: 'TRAINER_UNASSIGNED',
        userId: req.user.id,
        programId: req.programId,
        resourceType: 'program_trainer',
        resourceId: existing.id,
        metadata: { trainerId: req.params.userId },
        req,
      })

      res.json({ ok: true })
    } catch (err) {
      next(err)
    }
  }
)

module.exports = router
