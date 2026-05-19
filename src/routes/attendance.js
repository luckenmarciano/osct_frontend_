const express = require('express')
const { z } = require('zod')
const prisma = require('../lib/prisma')
const { verifyJWT } = require('../middleware/auth')
const { recomputeAttendancePct } = require('../services/enrollment.service')

const router = express.Router()

// POST /api/v1/attendance/scan — participant scans rotating QR
router.post('/scan', verifyJWT, async (req, res, next) => {
  try {
    const { token, latitude, longitude } = z
      .object({
        token: z.string().min(1),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
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

    const attendance = await prisma.attendance.upsert({
      where: { session_id_user_id: { session_id: session.id, user_id: req.user.id } },
      update: { latitude, longitude },
      create: {
        session_id: session.id,
        user_id: req.user.id,
        program_id: session.program_id,
        latitude,
        longitude,
      },
    })

    // Recompute attendance_pct + cert_eligible for this user in this program
    const recomputed = await recomputeAttendancePct({
      userId: req.user.id,
      programId: session.program_id,
    })

    res.json({
      ok: true,
      sessionTitle: session.title,
      attendance,
      attendancePct: recomputed.attendancePct,
      certEligible: recomputed.certEligible,
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
