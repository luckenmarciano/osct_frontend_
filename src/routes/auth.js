const express = require('express')
const bcrypt = require('bcryptjs')
const { z } = require('zod')
const prisma = require('../lib/prisma')
const env = require('../config/env')
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  verifyQRToken,
  signResetToken,
  verifyResetToken,
} = require('../middleware/auth')
const { sendPasswordResetEmail } = require('../services/email.service')

const router = express.Router()

// Build JWT payload from user (includes programIds for isolation)
async function buildTokenPayload(user) {
  const enrollments = await prisma.programEnrollment.findMany({
    where: { user_id: user.id },
    select: { program_id: true },
  })
  const trainings = await prisma.programTrainer.findMany({
    where: { user_id: user.id },
    select: { program_id: true },
  })
  const programIds = [
    ...new Set([
      ...enrollments.map((e) => e.program_id),
      ...trainings.map((t) => t.program_id),
    ]),
  ]
  return {
    userId: user.id,
    email: user.email,
    role: user.role,
    programIds,
  }
}

// POST /api/v1/auth/login — email + password
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = z
      .object({ email: z.string().email(), password: z.string().min(1) })
      .parse(req.body)

    const user = await prisma.user.findUnique({ where: { email } })
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Invalid credentials' })
    }
    const ok = await bcrypt.compare(password, user.password_hash)
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' })

    const payload = await buildTokenPayload(user)
    const accessToken = signAccessToken(payload)
    const refreshToken = signRefreshToken({ userId: user.id })

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await prisma.refreshToken.create({
      data: { user_id: user.id, token: refreshToken, expires_at: expiresAt },
    })

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        programIds: payload.programIds,
      },
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/auth/qr-login — scan QR code
router.post('/qr-login', async (req, res, next) => {
  try {
    const { qrToken } = z.object({ qrToken: z.string().min(1) }).parse(req.body)
    const decoded = verifyQRToken(qrToken)

    const user = await prisma.user.findUnique({ where: { id: decoded.userId } })
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'User not found or inactive' })
    }

    const payload = await buildTokenPayload(user)
    // Force currentProgram = QR's programId
    payload.currentProgramId = decoded.programId

    const accessToken = signAccessToken(payload)
    const refreshToken = signRefreshToken({ userId: user.id })

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await prisma.refreshToken.create({
      data: { user_id: user.id, token: refreshToken, expires_at: expiresAt },
    })

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        programIds: payload.programIds,
      },
      currentProgramId: decoded.programId,
    })
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired QR token' })
    }
    next(err)
  }
})

// POST /api/v1/auth/refresh
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = z.object({ refreshToken: z.string().min(1) }).parse(req.body)
    const decoded = verifyRefreshToken(refreshToken)

    const stored = await prisma.refreshToken.findUnique({ where: { token: refreshToken } })
    if (!stored || stored.revoked || stored.expires_at < new Date()) {
      return res.status(401).json({ error: 'Refresh token invalid or expired' })
    }

    const user = await prisma.user.findUnique({ where: { id: decoded.userId } })
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'User not found' })
    }

    const payload = await buildTokenPayload(user)
    const accessToken = signAccessToken(payload)
    res.json({ accessToken })
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired refresh token' })
    }
    next(err)
  }
})

// POST /api/v1/auth/logout
router.post('/logout', async (req, res, next) => {
  try {
    const { refreshToken } = z.object({ refreshToken: z.string().optional() }).parse(req.body)
    if (refreshToken) {
      await prisma.refreshToken.updateMany({
        where: { token: refreshToken },
        data: { revoked: true },
      })
    }
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/auth/forgot-password — request reset link
// Always returns 200 to avoid email enumeration. Only sends email if user exists.
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = z
      .object({ email: z.string().email() })
      .parse(req.body)

    const user = await prisma.user.findUnique({ where: { email } })
    if (user && user.is_active) {
      const token = signResetToken(user.id)
      const resetUrl = `${env.CLIENT_URL}/?reset=${encodeURIComponent(token)}`
      // Fire-and-forget: don't fail the response on email error
      sendPasswordResetEmail({
        to: user.email,
        fullName: user.full_name,
        resetUrl,
      }).catch((e) => console.error('[forgot-password email]', e.message))
    }

    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/auth/reset-password — set new password using reset token
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password } = z
      .object({ token: z.string().min(1), password: z.string().min(6) })
      .parse(req.body)

    let decoded
    try {
      decoded = verifyResetToken(token)
    } catch {
      return res.status(401).json({ error: 'Link reset tidak valid atau sudah kadaluarsa.' })
    }

    const user = await prisma.user.findUnique({ where: { id: decoded.userId } })
    if (!user || !user.is_active) {
      return res.status(404).json({ error: 'Akun tidak ditemukan' })
    }

    const hash = await bcrypt.hash(password, 10)
    await prisma.user.update({
      where: { id: user.id },
      data: { password_hash: hash },
    })

    // Invalidate all existing refresh tokens for this user
    await prisma.refreshToken.updateMany({
      where: { user_id: user.id, revoked: false },
      data: { revoked: true },
    })

    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

module.exports = router
