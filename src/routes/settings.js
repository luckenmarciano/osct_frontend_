/**
 * FR-28 — White-label / App Settings
 *
 * Key-value store for global branding:
 *   institution_name, logo_url, primary_color, footer_text
 *
 * GET  /api/v1/settings        — public (no auth) — frontend reads on boot
 * PUT  /api/v1/settings        — SUPER_ADMIN only
 * GET  /api/v1/settings/defaults — returns the hardcoded defaults
 */
const express = require('express')
const { z } = require('zod')
const prisma = require('../lib/prisma')
const { verifyJWT, requireRole } = require('../middleware/auth')

const router = express.Router()

const ALLOWED_KEYS = ['institution_name', 'logo_url', 'primary_color', 'footer_text']

const DEFAULTS = {
  institution_name: 'OSCT — Oil Spill Combat Training',
  logo_url: '',
  primary_color: '',  // empty = use program color
  footer_text: 'OSCT — OPRC Training Platform',
}

// GET /api/v1/settings — public, returns all settings merged with defaults
router.get('/', async (req, res, next) => {
  try {
    const rows = await prisma.appSetting.findMany()
    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    res.json({ ...DEFAULTS, ...stored })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/settings/defaults — helper so frontend knows what to reset to
router.get('/defaults', (req, res) => res.json(DEFAULTS))

// PUT /api/v1/settings — SUPER_ADMIN only; body: { key: value, ... }
router.put('/', verifyJWT, requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const body = z.record(z.string(), z.string()).parse(req.body)
    const invalid = Object.keys(body).filter((k) => !ALLOWED_KEYS.includes(k))
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Key tidak diizinkan: ${invalid.join(', ')}` })
    }

    // Upsert each key
    await Promise.all(
      Object.entries(body).map(([key, value]) =>
        prisma.appSetting.upsert({
          where: { key },
          update: { value },
          create: { key, value },
        })
      )
    )

    const rows = await prisma.appSetting.findMany()
    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    res.json({ ...DEFAULTS, ...stored })
  } catch (err) {
    next(err)
  }
})

module.exports = router
