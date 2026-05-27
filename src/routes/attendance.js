const express = require('express')
const { z } = require('zod')
const prisma = require('../lib/prisma')
const { verifyJWT } = require('../middleware/auth')
const { recomputeAttendancePct } = require('../services/enrollment.service')
const { createNotif } = require('../services/notification.service')

const router = express.Router()

// Haversine distance in meters between two (lat,lng) points.
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// POST /api/v1/attendance/scan — participant scans rotating QR
router.post('/scan', verifyJWT, async (req, res, next) => {
  try {
    const { token, latitude, longitude, deviceId } = z
      .object({
        token: z.string().min(1),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        deviceId: z.string().optional(),
      })
      .parse(req.body)

    const qrRecord = await prisma.qRToken.findUnique({
      where: { token },
      include: { session: true },
    })
    if (!qrRecord) return res.status(400).json({ error: 'Invalid QR token' })
    if (qrRecord.expires_at < new Date()) {
      return res.status(400).json({ error: 'QR token expired' })
    }

    const session = qrRecord.session

    // Verify user has access to this program
    if (
      req.user.role !== 'SUPER_ADMIN' &&
      !req.user.programIds.includes(session.program_id)
    ) {
      return res.status(403).json({ error: 'Not enrolled in this program' })
    }

    // Anomaly detection
    const flags = []

    // 1) Geo-fence — if session has a geo_radius_m + center, and scanner provided coords
    if (
      session.location_lat != null &&
      session.location_lng != null &&
      session.geo_radius_m != null &&
      latitude != null &&
      longitude != null
    ) {
      const dist = distanceMeters(
        latitude, longitude, session.location_lat, session.location_lng
      )
      if (dist > session.geo_radius_m) {
        flags.push(`geo_outside_fence(${Math.round(dist)}m)`)
      }
    }

    // 2) Duplicate device — same device fingerprint already scanned in this session by another user
    if (deviceId) {
      const dup = await prisma.attendance.findFirst({
        where: {
          session_id: session.id,
          device_id: deviceId,
          user_id: { not: req.user.id },
        },
        select: { user_id: true },
      })
      if (dup) flags.push('duplicate_device')
    }

    const isFlagged = flags.length > 0

    const attendance = await prisma.attendance.upsert({
      where: { session_id_user_id: { session_id: session.id, user_id: req.user.id } },
      update: {
        latitude,
        longitude,
        device_id: deviceId,
        is_flagged: isFlagged,
        flag_reason: isFlagged ? flags.join(',') : null,
      },
      create: {
        session_id: session.id,
        user_id: req.user.id,
        program_id: session.program_id,
        latitude,
        longitude,
        device_id: deviceId,
        is_flagged: isFlagged,
        flag_reason: isFlagged ? flags.join(',') : null,
      },
    })

    // Recompute attendance_pct + cert_eligible for this user in this program
    const recomputed = await recomputeAttendancePct({
      userId: req.user.id,
      programId: session.program_id,
    })

    // Fire CERT_READY notification the first time this user becomes eligible
    if (recomputed.justBecameEligible) {
      createNotif({
        userId:    req.user.id,
        type:      'CERT_READY',
        title:     'Selamat! Anda memenuhi syarat sertifikat',
        body:      'Kunjungi halaman Sertifikat untuk mengklaim sertifikat Anda.',
        programId: session.program_id,
        refId:     `cert-ready-${req.user.id}-${session.program_id}`,
      }).catch((e) => console.error('[cert-ready notif]', e.message))
    }

    res.json({
      ok: true,
      sessionTitle: session.title,
      attendance,
      attendancePct: recomputed.attendancePct,
      certEligible: recomputed.certEligible,
      flags,
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
