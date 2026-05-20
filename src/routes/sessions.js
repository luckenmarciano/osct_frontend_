const express = require('express')
const { z } = require('zod')
const prisma = require('../lib/prisma')
const { verifyJWT, requireRole } = require('../middleware/auth')
const { programIsolation } = require('../middleware/programIsolation')
const { rotateSessionToken, generateSessionQR } = require('../services/qr.service')

const router = express.Router()

// Soft schedule-conflict check. Returns warnings (never a hard block) when the
// proposed session overlaps another session in the same program that shares
// the same trainer or location. Sessions with no explicit duration are
// assumed to run DEFAULT_DURATION_MIN.
const DEFAULT_DURATION_MIN = 60
async function findSessionConflicts({ programId, excludeId, trainerId, location, scheduledAt, durationMin }) {
  const start = new Date(scheduledAt).getTime()
  const end = start + (durationMin || DEFAULT_DURATION_MIN) * 60000

  const orConds = [{ trainer_id: trainerId }]
  if (location) orConds.push({ location })

  const candidates = await prisma.session.findMany({
    where: {
      program_id: programId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      OR: orConds,
    },
    select: {
      id: true,
      title: true,
      scheduled_at: true,
      duration_min: true,
      trainer_id: true,
      location: true,
    },
  })

  const warnings = []
  for (const c of candidates) {
    const cStart = new Date(c.scheduled_at).getTime()
    const cEnd = cStart + (c.duration_min || DEFAULT_DURATION_MIN) * 60000
    if (start < cEnd && cStart < end) {
      warnings.push({
        type: c.trainer_id === trainerId ? 'trainer' : 'location',
        sessionTitle: c.title,
      })
    }
  }
  return warnings
}

// GET /api/v1/sessions/programs/:pid — list all sessions in program
router.get(
  '/programs/:pid',
  verifyJWT,
  programIsolation,
  async (req, res, next) => {
    try {
      const sessions = await prisma.session.findMany({
        where: { program_id: req.programId },
        include: {
          trainer: { select: { id: true, full_name: true, email: true } },
          _count: { select: { attendances: true } },
        },
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
          locationLat: z.number().min(-90).max(90).nullable().optional(),
          locationLng: z.number().min(-180).max(180).nullable().optional(),
          geoRadiusM: z.number().int().min(10).max(50000).nullable().optional(),
          trainerId: z.string().optional(),
          sessionType: z.enum(['LECTURE', 'DRILL', 'EXAM']).nullable().optional(),
          durationMin: z.number().int().min(5).max(1440).nullable().optional(),
        })
        .parse(req.body)

      if (
        req.user.role !== 'SUPER_ADMIN' &&
        !req.user.programIds.includes(data.programId)
      ) {
        return res.status(403).json({ error: 'No access to this program' })
      }

      // Resolve the trainer — defaults to the creator, or an explicitly
      // chosen trainer who must already be assigned to the program.
      let trainerId = req.user.id
      if (data.trainerId) {
        const pt = await prisma.programTrainer.findUnique({
          where: {
            user_id_program_id: {
              user_id: data.trainerId,
              program_id: data.programId,
            },
          },
        })
        if (!pt) {
          return res.status(400).json({ error: 'Trainer belum ditugaskan ke program ini' })
        }
        trainerId = data.trainerId
      }

      const warnings = await findSessionConflicts({
        programId: data.programId,
        trainerId,
        location: data.location,
        scheduledAt: data.scheduledAt,
        durationMin: data.durationMin,
      })

      const session = await prisma.session.create({
        data: {
          program_id: data.programId,
          trainer_id: trainerId,
          title: data.title,
          scheduled_at: data.scheduledAt,
          location: data.location,
          location_lat: data.locationLat,
          location_lng: data.locationLng,
          geo_radius_m: data.geoRadiusM,
          session_type: data.sessionType,
          duration_min: data.durationMin,
        },
      })
      res.status(201).json({ ...session, warnings })
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
          locationLat: z.number().min(-90).max(90).nullable().optional(),
          locationLng: z.number().min(-180).max(180).nullable().optional(),
          geoRadiusM: z.number().int().min(10).max(50000).nullable().optional(),
          trainerId: z.string().optional(),
          sessionType: z.enum(['LECTURE', 'DRILL', 'EXAM']).nullable().optional(),
          durationMin: z.number().int().min(5).max(1440).nullable().optional(),
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

      if (data.trainerId) {
        const pt = await prisma.programTrainer.findUnique({
          where: {
            user_id_program_id: {
              user_id: data.trainerId,
              program_id: existing.program_id,
            },
          },
        })
        if (!pt) {
          return res.status(400).json({ error: 'Trainer belum ditugaskan ke program ini' })
        }
      }

      const warnings = await findSessionConflicts({
        programId: existing.program_id,
        excludeId: existing.id,
        trainerId: data.trainerId ?? existing.trainer_id,
        location: data.location !== undefined ? data.location : existing.location,
        scheduledAt: data.scheduledAt ?? existing.scheduled_at,
        durationMin:
          data.durationMin !== undefined ? data.durationMin : existing.duration_min,
      })

      const session = await prisma.session.update({
        where: { id: req.params.id },
        data: {
          ...(data.title !== undefined && { title: data.title }),
          ...(data.scheduledAt !== undefined && { scheduled_at: data.scheduledAt }),
          ...(data.location !== undefined && { location: data.location }),
          ...(data.locationLat !== undefined && { location_lat: data.locationLat }),
          ...(data.locationLng !== undefined && { location_lng: data.locationLng }),
          ...(data.geoRadiusM !== undefined && { geo_radius_m: data.geoRadiusM }),
          ...(data.trainerId !== undefined && { trainer_id: data.trainerId }),
          ...(data.sessionType !== undefined && { session_type: data.sessionType }),
          ...(data.durationMin !== undefined && { duration_min: data.durationMin }),
        },
      })
      res.json({ ...session, warnings })
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

// Helper: load session and assert the caller has access to its program.
// SUPER_ADMIN sees everything; everyone else must be in programIds.
async function loadSessionWithAccess(req, res) {
  const session = await prisma.session.findUnique({ where: { id: req.params.id } })
  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return null
  }
  if (
    req.user.role !== 'SUPER_ADMIN' &&
    !req.user.programIds.includes(session.program_id)
  ) {
    res.status(403).json({ error: 'No access to this session' })
    return null
  }
  return session
}

// POST /api/v1/sessions/:id/qr/start — begin session, first rotating QR token
router.post(
  '/:id/qr/start',
  verifyJWT,
  requireRole('TRAINER', 'PROGRAM_ADMIN', 'SUPER_ADMIN'),
  async (req, res, next) => {
    try {
      const session = await loadSessionWithAccess(req, res)
      if (!session) return

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

// POST /api/v1/sessions/:id/qr/stop — end an active session
router.post(
  '/:id/qr/stop',
  verifyJWT,
  requireRole('TRAINER', 'PROGRAM_ADMIN', 'SUPER_ADMIN'),
  async (req, res, next) => {
    try {
      const session = await loadSessionWithAccess(req, res)
      if (!session) return

      const updated = await prisma.session.update({
        where: { id: session.id },
        data: { is_active: false },
      })
      res.json({ sessionId: updated.id, is_active: updated.is_active })
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
      const session = await loadSessionWithAccess(req, res)
      if (!session) return

      const latest = await prisma.qRToken.findFirst({
        where: { session_id: session.id },
        orderBy: { created_at: 'desc' },
      })

      if (!latest || latest.expires_at < new Date()) {
        const { token, qrPngDataUrl, expiresAt } = await rotateSessionToken(session.id)
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
router.get(
  '/:id/attendees',
  verifyJWT,
  requireRole('TRAINER', 'PROGRAM_ADMIN', 'SUPER_ADMIN'),
  async (req, res, next) => {
    try {
      const session = await loadSessionWithAccess(req, res)
      if (!session) return

      const attendees = await prisma.attendance.findMany({
        where: { session_id: session.id },
        include: { user: { select: { id: true, full_name: true, email: true } } },
        orderBy: { scanned_at: 'desc' },
      })
      res.json(attendees)
    } catch (err) {
      next(err)
    }
  }
)

module.exports = router
