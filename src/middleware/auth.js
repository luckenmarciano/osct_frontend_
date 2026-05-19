const jwt = require('jsonwebtoken')
const env = require('../config/env')

function verifyJWT(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' })
  }
  const token = header.slice(7)
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET)
    req.user = {
      id: payload.userId,
      role: payload.role,
      programIds: payload.programIds || [],
      email: payload.email,
    }
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthenticated' })
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Requires role: ${roles.join(', ')}` })
    }
    next()
  }
}

function signAccessToken(payload) {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_EXPIRES })
}

function signRefreshToken(payload) {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: env.JWT_REFRESH_EXPIRES })
}

function verifyRefreshToken(token) {
  return jwt.verify(token, env.JWT_REFRESH_SECRET)
}

function signQRToken(payload) {
  return jwt.sign({ ...payload, type: 'qr_login' }, env.JWT_QR_SECRET, { expiresIn: '365d' })
}

function verifyQRToken(token) {
  const decoded = jwt.verify(token, env.JWT_QR_SECRET)
  if (decoded.type !== 'qr_login') throw new Error('Invalid QR token type')
  return decoded
}

function signResetToken(userId) {
  return jwt.sign(
    { userId, type: 'password_reset' },
    env.JWT_QR_SECRET,
    { expiresIn: '1h' }
  )
}

function verifyResetToken(token) {
  const decoded = jwt.verify(token, env.JWT_QR_SECRET)
  if (decoded.type !== 'password_reset') throw new Error('Invalid reset token type')
  return decoded
}

module.exports = {
  verifyJWT,
  requireRole,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  signQRToken,
  verifyQRToken,
  signResetToken,
  verifyResetToken,
}
