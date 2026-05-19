const express = require('express')
const bcrypt = require('bcryptjs')
const { z } = require('zod')
const prisma = require('../lib/prisma')
const { verifyJWT, requireRole, signQRToken } = require('../middleware/auth')
const { programIsolation } = require('../middleware/programIsolation')
const { generateLoginQR } = require('../services/qr.service')
const { sendLoginQREmail } = require('../services/email.service')
const { auditLog } = require('../services/audit.service')
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
    })
    res.json(programs)
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

// POST /api/v1/programs/:pid/enrollments — enroll a participant
router.post(
  '/:pid/enrollments',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  programIsolation,
  async (req, res, next) => {
    try {
      const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body)
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
          sendQrEmail: z.boolean().optional().default(false),
        })
        .parse(req.body)

      const existing = await prisma.user.findUnique({ where: { email: data.email } })
      if (existing) {
        return res.status(409).json({ error: 'Email sudah terdaftar' })
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
        metadata: { email: user.email, qrEmailed: !!data.sendQrEmail },
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

      const result = await importParticipantsCSV({
        csvBuffer: req.file.buffer,
        programId: req.programId,
        sendQrEmail,
        actingUserId: req.user.id,
        req,
      })

      res.json(result)
    } catch (err) {
      next(err)
    }
  }
)

module.exports = router
