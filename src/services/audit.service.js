const prisma = require('../lib/prisma')

/**
 * Record an audit log entry. Fire-and-forget: never throws — failures
 * are logged but don't break the caller's flow. Use for state-changing
 * actions worth retaining a trail of (auth events, cert issuance,
 * grading, content publishing, etc.).
 *
 * @param {object} entry
 * @param {string} entry.action          — short code, e.g. 'USER_LOGIN'
 * @param {string} [entry.userId]        — actor user id (null = system/anonymous)
 * @param {string} [entry.programId]     — program context
 * @param {string} [entry.resourceType]  — e.g. 'enrollment', 'attempt', 'kb_doc'
 * @param {string} [entry.resourceId]
 * @param {object} [entry.metadata]      — arbitrary extra info
 * @param {object} [entry.req]           — express req, used to pick up IP
 */
async function auditLog({ action, userId, programId, resourceType, resourceId, metadata, req }) {
  try {
    let ip = null
    if (req) {
      ip = req.ip || req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || null
      if (Array.isArray(ip)) ip = ip[0]
      if (typeof ip === 'string') ip = ip.split(',')[0].trim()
    }
    await prisma.auditLog.create({
      data: {
        action,
        user_id: userId || null,
        program_id: programId || null,
        resource_type: resourceType || null,
        resource_id: resourceId || null,
        metadata: metadata || null,
        ip_address: ip || null,
      },
    })
  } catch (e) {
    console.warn('[audit_log] insert failed:', e.message)
  }
}

module.exports = { auditLog }
