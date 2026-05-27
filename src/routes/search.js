const express = require('express')
const prisma = require('../lib/prisma')
const { verifyJWT, requireRole } = require('../middleware/auth')

const router = express.Router()

/**
 * GET /api/v1/search?q=<query>
 *
 * Global search across Programs, Courses, Sessions, and Users.
 * Only accessible to SUPER_ADMIN and PROGRAM_ADMIN.
 * SUPER_ADMIN   → results from all programs.
 * PROGRAM_ADMIN → results scoped to their programIds.
 *
 * Minimum query length: 2 characters.
 * Each category returns up to 5 results.
 */
router.get(
  '/',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  async (req, res, next) => {
    try {
      const q = (req.query.q || '').trim()

      // Return empty quickly for very short queries
      if (q.length < 2) {
        return res.json({ users: [], programs: [], courses: [], sessions: [] })
      }

      const { role, programIds } = req.user
      const isSuperAdmin = role === 'SUPER_ADMIN'
      const contains = { contains: q, mode: 'insensitive' }

      const [users, programs, courses, sessions] = await Promise.all([
        // Users — match name or email, scoped to admin's programs if needed
        prisma.user.findMany({
          where: {
            AND: [
              { OR: [{ full_name: contains }, { email: contains }] },
              isSuperAdmin
                ? {}
                : {
                    OR: [
                      { enrollments: { some: { program_id: { in: programIds } } } },
                      { trainer_programs: { some: { program_id: { in: programIds } } } },
                    ],
                  },
            ],
          },
          select: { id: true, full_name: true, email: true, role: true },
          take: 5,
          orderBy: { full_name: 'asc' },
        }),

        // Programs — match name or code
        prisma.oPRCProgram.findMany({
          where: {
            ...(isSuperAdmin ? {} : { id: { in: programIds } }),
            OR: [{ name: contains }, { code: contains }],
          },
          select: { id: true, name: true, code: true, level: true, color_theme: true },
          take: 5,
          orderBy: { level: 'asc' },
        }),

        // Courses — match title (exclude archived)
        prisma.course.findMany({
          where: {
            ...(isSuperAdmin ? {} : { program_id: { in: programIds } }),
            status: { not: 'ARCHIVED' },
            title: contains,
          },
          select: {
            id: true,
            title: true,
            status: true,
            program_id: true,
            program: { select: { id: true, name: true, code: true } },
          },
          take: 5,
          orderBy: { title: 'asc' },
        }),

        // Sessions — match title or location
        prisma.session.findMany({
          where: {
            ...(isSuperAdmin ? {} : { program_id: { in: programIds } }),
            OR: [{ title: contains }, { location: contains }],
          },
          select: {
            id: true,
            title: true,
            scheduled_at: true,
            location: true,
            program_id: true,
            program: { select: { id: true, name: true, code: true } },
          },
          take: 5,
          orderBy: { scheduled_at: 'desc' },
        }),
      ])

      res.json({ users, programs, courses, sessions })
    } catch (err) {
      next(err)
    }
  }
)

module.exports = router
