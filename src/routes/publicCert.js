// Public endpoints (no auth) for claim + verify
const express = require('express')
const { z } = require('zod')
const prisma = require('../lib/prisma')
const { generateCertificatePDF } = require('../services/cert.service')
const { auditLog } = require('../services/audit.service')

const router = express.Router()

// POST /api/v1/claim — claim certificate with email + code
router.post('/claim', async (req, res, next) => {
  try {
    const { email, code } = z
      .object({ email: z.string().email(), code: z.string().min(1) })
      .parse(req.body)

    const cert = await prisma.certificate.findFirst({
      where: { verification_code: code.toUpperCase() },
      include: { user: true, program: true },
    })

    if (!cert) return res.status(404).json({ error: 'Invalid code' })
    if (cert.user.email.toLowerCase() !== email.toLowerCase()) {
      return res.status(400).json({ error: 'Email does not match code' })
    }
    if (cert.code_expires_at < new Date()) {
      return res.status(400).json({ error: 'Code expired' })
    }

    // Generate PDF if not yet
    let pdfUrl = cert.pdf_url
    if (!pdfUrl) {
      pdfUrl = await generateCertificatePDF({
        certNo: cert.cert_no,
        participantName: cert.user.full_name,
        programName: cert.program.name,
        programColor: cert.program.color_theme,
        issuedAt: cert.issued_at,
      })
    }

    const updated = await prisma.certificate.update({
      where: { id: cert.id },
      data: {
        claimed_at: cert.claimed_at ?? new Date(),
        pdf_url: pdfUrl,
      },
    })

    if (!cert.claimed_at) {
      auditLog({
        action: 'CERT_CLAIMED',
        userId: cert.user_id,
        programId: cert.program_id,
        resourceType: 'certificate',
        resourceId: cert.id,
        metadata: { certNo: cert.cert_no },
        req,
      })
    }

    res.json({
      certNo: updated.cert_no,
      pdfUrl: updated.pdf_url,
      programName: cert.program.name,
      participantName: cert.user.full_name,
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/verify/:certNo — public verification
router.get('/verify/:certNo', async (req, res, next) => {
  try {
    const cert = await prisma.certificate.findUnique({
      where: { cert_no: req.params.certNo },
      include: { user: true, program: true },
    })
    if (!cert || !cert.claimed_at) {
      return res.status(404).json({ valid: false, error: 'Not found or not claimed' })
    }
    res.json({
      valid: true,
      certNo: cert.cert_no,
      participantName: cert.user.full_name,
      programName: cert.program.name,
      issuedAt: cert.issued_at,
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
