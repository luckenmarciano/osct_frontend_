const express = require('express')
const bcrypt = require('bcryptjs')
const { z } = require('zod')
const prisma = require('../lib/prisma')
const { verifyJWT, requireRole } = require('../middleware/auth')
const { auditLog } = require('../services/audit.service')

const router = express.Router()

// GET /api/v1/users — list users (admin)
router.get(
  '/',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  async (req, res, next) => {
    try {
      const users = await prisma.user.findMany({
        select: {
          id: true,
          email: true,
          full_name: true,
          role: true,
          is_active: true,
          created_at: true,
          _count: { select: { enrollments: true } },
        },
        orderBy: { created_at: 'desc' },
      })
      res.json(users)
    } catch (err) {
      next(err)
    }
  }
)

// GET /api/v1/users/me — current user
router.get('/me', verifyJWT, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        full_name: true,
        role: true,
        enrollments: { include: { program: true } },
        trainer_programs: { include: { program: true } },
      },
    })
    res.json(user)
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/users — create user (admin)
router.post(
  '/',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  async (req, res, next) => {
    try {
      const data = z
        .object({
          email: z.string().email(),
          password: z.string().min(6),
          fullName: z.string().min(1),
          role: z.enum(['SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER', 'PARTICIPANT']),
        })
        .parse(req.body)

      const hash = await bcrypt.hash(data.password, 10)
      const user = await prisma.user.create({
        data: {
          email: data.email,
          password_hash: hash,
          full_name: data.fullName,
          role: data.role,
        },
        select: { id: true, email: true, full_name: true, role: true },
      })
      res.status(201).json(user)
    } catch (err) {
      next(err)
    }
  }
)

// PUT /api/v1/users/:id — update user
router.put(
  '/:id',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  async (req, res, next) => {
    try {
      const data = z
        .object({
          fullName: z.string().optional(),
          role: z.enum(['SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER', 'PARTICIPANT']).optional(),
          isActive: z.boolean().optional(),
        })
        .parse(req.body)

      const updates = {}
      if (data.fullName !== undefined) updates.full_name = data.fullName
      if (data.role !== undefined) updates.role = data.role
      if (data.isActive !== undefined) updates.is_active = data.isActive

      const user = await prisma.user.update({
        where: { id: req.params.id },
        data: updates,
        select: { id: true, email: true, full_name: true, role: true, is_active: true },
      })
      res.json(user)
    } catch (err) {
      next(err)
    }
  }
)

// DELETE /api/v1/users/:id — permanently remove user (cascade-deletes
// enrollments, watch sessions, certificates, etc. via Prisma onDelete).
// Audit logs reference users with SetNull so deletion history is retained.
router.delete(
  '/:id',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN'),
  async (req, res, next) => {
    try {
      const targetId = req.params.id

      if (targetId === req.user.id) {
        return res.status(400).json({ error: 'Tidak bisa menghapus akun sendiri' })
      }

      const target = await prisma.user.findUnique({
        where: { id: targetId },
        select: { id: true, email: true, full_name: true, role: true },
      })
      if (!target) return res.status(404).json({ error: 'User tidak ditemukan' })

      // Program admins cannot remove a super admin
      if (req.user.role === 'PROGRAM_ADMIN' && target.role === 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'Tidak berwenang menghapus super admin' })
      }

      try {
        await prisma.user.delete({ where: { id: target.id } })
      } catch (err) {
        // Prisma FK violation -> some relation lacks cascade
        if (err.code === 'P2003' || err.code === 'P2014') {
          return res.status(409).json({
            error: 'Tidak bisa menghapus: user masih punya data terkait yang tidak ter-cascade',
            code: err.code,
          })
        }
        throw err
      }

      auditLog({
        action: 'USER_DELETED',
        userId: req.user.id,
        resourceType: 'user',
        resourceId: target.id,
        metadata: { email: target.email, role: target.role, fullName: target.full_name },
        req,
      })

      res.json({ ok: true, deleted: { id: target.id, email: target.email } })
    } catch (err) {
      next(err)
    }
  }
)

module.exports = router
