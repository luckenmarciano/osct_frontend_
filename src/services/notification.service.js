// notification.service.js — FR-19 in-app notification helpers.
// All public functions are non-fatal: callers should not await them on the
// critical path (use .catch(() => {}) or fire-and-forget).
const prisma = require('../lib/prisma')

/**
 * Create a notification for one user.
 *
 * Dedup rule: if ref_id is supplied and an *unread* notification with the
 * same (user_id, type, ref_id) already exists, the existing row is returned
 * unchanged (no duplicate). This prevents double-firing for recurring events.
 */
async function createNotif({ userId, type, title, body, programId, refId }) {
  if (refId) {
    const existing = await prisma.notification.findFirst({
      where: { user_id: userId, type, ref_id: refId, read_at: null },
    })
    if (existing) return existing
  }
  return prisma.notification.create({
    data: {
      user_id:    userId,
      type,
      title,
      body:       body      || null,
      program_id: programId || null,
      ref_id:     refId     || null,
    },
  })
}

/**
 * Create the same notification for multiple users at once.
 * Each user gets an independent dedup check.
 */
async function createNotifsForMany({ userIds, type, title, body, programId, refId }) {
  return Promise.allSettled(
    userIds.map((uid) =>
      createNotif({ userId: uid, type, title, body, programId, refId })
    )
  )
}

module.exports = { createNotif, createNotifsForMany }
