// notifications.js — FR-19 in-app notification center endpoints.
// All endpoints are scoped to the authenticated user — no program isolation
// needed because notifications are personal (user_id = req.user.id).
const express = require('express')
const prisma = require('../lib/prisma')
const { verifyJWT } = require('../middleware/auth')

const router = express.Router()
const LIST_LIMIT = 50

// GET /api/v1/notifications
// Returns the user's most recent notifications + unread count.
router.get('/', verifyJWT, async (req, res, next) => {
  try {
    const items = await prisma.notification.findMany({
      where: { user_id: req.user.id },
      orderBy: { created_at: 'desc' },
      take: LIST_LIMIT,
    })
    const unread = items.filter((n) => !n.read_at).length
    res.json({ items, unread })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/notifications/unread-count
// Lightweight endpoint for badge polling.
router.get('/unread-count', verifyJWT, async (req, res, next) => {
  try {
    const count = await prisma.notification.count({
      where: { user_id: req.user.id, read_at: null },
    })
    res.json({ count })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/notifications/read-all
// Mark all unread notifications as read.
router.post('/read-all', verifyJWT, async (req, res, next) => {
  try {
    await prisma.notification.updateMany({
      where: { user_id: req.user.id, read_at: null },
      data: { read_at: new Date() },
    })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/notifications/:id/read
// Mark one notification as read. Silently ignores if already read.
router.post('/:id/read', verifyJWT, async (req, res, next) => {
  try {
    const notif = await prisma.notification.findUnique({
      where: { id: req.params.id },
    })
    if (!notif || notif.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Not found' })
    }
    if (!notif.read_at) {
      await prisma.notification.update({
        where: { id: req.params.id },
        data: { read_at: new Date() },
      })
    }
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

module.exports = router
