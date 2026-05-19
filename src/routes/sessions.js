const express = require('express')
const { z } = require('zod')
const prisma = require('../lib/prisma')
const { verifyJWT, requireRole } = require('../middleware/auth')
const { programIsolation } = require('../middleware/programIsolation')
const { rotateSessionToken, generateSessionQR } = require('../services/qr.service')

const router = express.Router()

// GET /api/v1/sessions/programs/:pid — list all sessions in program
router.get(
  '/programs/:pid',
  verifyJWT,
  programIsolation,
  async (req, res, next) => {
    try {
      const sessions = await prisma.session.findMany({
        where: { program_id: req.programId },
        include: { trainer: { select: { id: true, full_name: true, email: true } } },
        orderBy: { scheduled_at: 'asc' },
      })
      res.json(sessions)
    } catch (err) {
      next(err)
    }
  }
)

// GET /api/v1/sessions/programs/:pid/upcoming — upcoming sessions only
router.get(
  '/programs/:pid/upcoming',
  verifyJWT,
  programIsolation,
  async (req, res, next) => {
    try {
      const sessions = await prisma.session.findMany({
        where: {
          program_id: req.programId,
          scheduled_at: { gte: new Date() },
        },
        include: { trainer: { select: { id: true, full_name: true } } },
        orderBy: { scheduled_at: 'asc' },
        take: 10,
      })
      res.json(sessions)
    } catch (err) {
      next(err)
    }
  }
)

// POST /api/v1/sessions — trainer creates session
router.post(
  '/',
  verifyJWT,
  requireRole('TRAINER', 'PROGRAM_ADMIN', 'SUPER_ADMIN'),
  async (req, res, next) => {
    try {
      const data = z
        .object({
          programId: z.string().min(1),
          title: z.string().min(1),
          scheduledAt: z.coerce.date(),
          location: z.string().optional(),
          locationLat: z.number().min(-90).max(90).optional(),
          locationLng: z.number().min(-180).max(180).optional(),
          geoRadiusM: z.number().int().min(10).max(50000).optional(),
        })
        .parse(req.body)

      if (
        req.user.role !== 'SUPER_ADMIN' &&
        !req.user.programIds.includes(data.programId)
      ) {
        return res.status(403).json({ error: 'No access to this program' })
      }

      const session = await prisma.session.create({
        data: {
          program_id: data.programId,
          trainer_id: req.user.id,
          title: data.title,
          scheduled_at: data.scheduledAt,
          location: data.location,
          location_lat: data.locationLat,
          location_lng: data.locationLng,
          geo_radius_m: data.geoRadiusM,
        },
      })
      res.status(201).json(session)
    } catch (err) {
      next(err)
    }
  }
)

// PUT /api/v1/sessions/:id — update session
router.put(
  '/:id',
  verifyJWT,
  requireRole('TRAINER', 'PROGRAM_ADMIN', 'SUPER_ADMIN'),
  async (req, res, next) => {
    try {
      const data = z
        .object({
          title: z.string().min(1).optional(),
          scheduledAt: z.coerce.date().optional(),
          location: z.string().nullable().optional(),
        })
        .parse(req.body)

      const existing = await prisma.session.findUnique({ where: { id: req.params.id } })
      if (!existing) return res.status(404).json({ error: 'Session not found' })

      if (
        req.user.role !== 'SUPER_ADMIN' &&
        !req.user.programIds.includes(existing.program_id)
      ) {
        return res.status(403).json({ error: 'No access to this session' })
      }

      const session = await prisma.session.update({
        where: { id: req.params.id },
        data: {
          ...(data.title !== undefined && { title: data.title }),
          ...(data.scheduledAt !== undefined && { scheduled_at: data.scheduledAt }),
          ...(data.location !== undefined && { location: data.location }),
        },
      })
      res.json(session)
    } catch (err) {
      next(err)
    }
  }
)

// DELETE /api/v1/sessions/:id — delete session
router.delete(
  '/:id',
  verifyJWT,
  requireRole('TRAINER', 'PROGRAM_ADMIN', 'SUPER_ADMIN'),
  async (req, res, next) => {
    try {
      const existing = await prisma.session.findUnique({ where: { id: req.params.id } })
      if (!existing) return res.status(404).json({ error: 'Session not found' })

      if (
        req.user.role !== 'SUPER_ADMIN' &&
        !req.user.programIds.includes(existing.program_id)
      ) {
        return res.status(403).json({ error: 'No access to this session' })
      }

      await prisma.session.delete({ where: { id: req.params.id } })
      res.status(204).end()
    } catch (err) {
      next(err)
    }
  }
)

// POST /api/v1/sessions/:id/qr/start — begin session, first rotating QR token
router.post(
  '/:id/qr/start',
  verifyJWT,
  requireRole('TRAINER', 'PROGRAM_ADMIN', 'SUPER_ADMIN'),
  async (req, res, next) => {
    try {
      const session = await prisma.session.findUnique({ where: { id: req.params.id } })
      if (!session) return res.status(404).json({ error: 'Session not found' })

      await prisma.session.update({
        where: { id: session.id },
        data: { is_active: true },
      })
      const { token, qrPngDataUrl, expiresAt } = await rotateSessionToken(session.id)
      res.json({ sessionId: session.id, token, qrPngDataUrl, expiresAt })
    } catch (err) {
      next(err)
    }
  }
)

// GET /api/v1/sessions/:id/qr/current — polling for current QR token
router.get(
  '/:id/qr/current',
  verifyJWT,
  requireRole('TRAINER', 'PROGRAM_ADMIN', 'SUPER_ADMIN'),
  async (req, res, next) => {
    try {
      const latest = await prisma.qRToken.findFirst({
        where: { session_id: req.params.id },
        orderBy: { created_at: 'desc' },
      })

      if (!latest || latest.expires_at < new Date()) {
        const { token, qrPngDataUrl, expiresAt } = await rotateSessionToken(req.params.id)
        return res.json({ token, qrPngDataUrl, expiresAt })
      }

      const qrPngDataUrl = await generateSessionQR(latest.token)
      res.json({ token: latest.token, qrPngDataUrl, expiresAt: latest.expires_at })
    } catch (err) {
      next(err)
    }
  }
)

// GET /api/v1/sessions/:id/attendees
router.get('/:id/attendees', verifyJWT, async (req, res, next) => {
  try {
    const attendees = await prisma.attendance.findMany({
      where: { session_id: req.params.id },
      include: { user: { select: { id: true, full_name: true, email: true } } },
      orderBy: { scanned_at: 'desc' },
    })
    res.json(attendees)
  } catch (err) {
    next(err)
  }
})

module.exports = router
