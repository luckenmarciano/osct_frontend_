const express = require('express')
const { z } = require('zod')
const crypto = require('crypto')
const prisma = require('../lib/prisma')
const { verifyJWT, requireRole } = require('../middleware/auth')
const { programIsolation } = require('../middleware/programIsolation')
const { sendVerificationCodeEmail } = require('../services/email.service')
const { generateCertificatePDF } = require('../services/cert.service')
const { auditLog } = require('../services/audit.service')

const router = express.Router()

function genCode(len = 8) {
  // url-safe alphanumeric, uppercase
  return crypto.randomBytes(len).toString('base64').replace(/[^A-Z0-9]/gi, '').slice(0, len).toUpperCase()
}

function genCertNo(programCode, year) {
  return `OSCT/${programCode.toUpperCase()}/${year}/${Date.now().toString(36).toUpperCase()}`
}

// GET /api/v1/certificates/programs/:pid/eligible
router.get(
  '/programs/:pid/eligible',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  programIsolation,
  async (req, res, next) => {
    try {
      const list = await prisma.programEnrollment.findMany({
        where: { program_id: req.programId, cert_eligible: true },
        include: {
          user: { select: { id: true, full_name: true, email: true } },
          certificate: true,
        },
      })
      res.json(list)
    } catch (err) {
      next(err)
    }
  }
)

// POST /api/v1/certificates/programs/:pid/send-code — admin sends verification codes
router.post(
  '/programs/:pid/send-code',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  programIsolation,
  async (req, res, next) => {
    try {
      const { enrollmentIds } = z
        .object({ enrollmentIds: z.array(z.string()).min(1) })
        .parse(req.body)

      const program = await prisma.oPRCProgram.findUnique({
        where: { id: req.programId },
      })

      const results = []
      for (const eid of enrollmentIds) {
        const enrollment = await prisma.programEnrollment.findFirst({
          where: { id: eid, program_id: req.programId, cert_eligible: true },
          include: { user: true },
        })
        if (!enrollment) {
          results.push({ enrollmentId: eid, ok: false, error: 'Not eligible' })
          continue
        }

        const code = genCode(8)
        const certNo = genCertNo(program.code, new Date().getFullYear())
        const codeExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

        const cert = await prisma.certificate.upsert({
          where: { enrollment_id: enrollment.id },
          update: {
            verification_code: code,
            code_expires_at: codeExpiresAt,
          },
          create: {
            enrollment_id: enrollment.id,
            program_id: req.programId,
            user_id: enrollment.user_id,
            cert_no: certNo,
            verification_code: code,
            code_expires_at: codeExpiresAt,
          },
        })

        try {
          await sendVerificationCodeEmail({
            to: enrollment.user.email,
            participantName: enrollment.user.full_name,
            programName: program.name,
            code,
            expiresAt: codeExpiresAt,
          })
          auditLog({
            action: 'CERT_CODE_SENT',
            userId: req.user.id,
            programId: req.programId,
            resourceType: 'certificate',
            resourceId: cert.id,
            metadata: { to: enrollment.user.email, certNo: cert.cert_no },
            req,
          })
          results.push({ enrollmentId: eid, ok: true, certId: cert.id })
        } catch (e) {
          results.push({ enrollmentId: eid, ok: false, error: e.message })
        }
      }
      res.json({ results })
    } catch (err) {
      next(err)
    }
  }
)

// GET /api/v1/certificates/mine — participant view own certificates
router.get('/mine', verifyJWT, async (req, res, next) => {
  try {
    const certs = await prisma.certificate.findMany({
      where: { user_id: req.user.id },
      include: { program: true },
      orderBy: { issued_at: 'desc' },
    })
    res.json(certs)
  } catch (err) {
    next(err)
  }
})

module.exports = router
