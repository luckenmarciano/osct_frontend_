const prisma = require('../lib/prisma')

/**
 * Program isolation middleware. Mounts AFTER verifyJWT.
 * Reads program id from req.params.pid (or req.params.programId), validates
 * that req.user has access (admin → all; trainer/participant → must be enrolled/assigned).
 * Attaches `req.programId` for use in route handlers.
 */
async function programIsolation(req, res, next) {
  const programId = req.params.pid || req.params.programId
  if (!programId) {
    return res.status(400).json({ error: 'Missing program id' })
  }

  if (!req.user) {
    return res.status(401).json({ error: 'Unauthenticated' })
  }

  const { role, id: userId, programIds } = req.user

  // Super admin: full access
  if (role === 'SUPER_ADMIN') {
    req.programId = programId
    return next()
  }

  // Program admin / trainer / participant: must have access to this program
  if (programIds.includes(programId)) {
    req.programId = programId
    return next()
  }

  // Fallback: re-check from DB (in case JWT is stale)
  const access = await prisma.programEnrollment.findFirst({
    where: { user_id: userId, program_id: programId },
  }) || await prisma.programTrainer.findFirst({
    where: { user_id: userId, program_id: programId },
  })

  if (!access) {
    return res.status(403).json({ error: 'Access denied to this program' })
  }

  req.programId = programId
  next()
}

module.exports = { programIsolation }
