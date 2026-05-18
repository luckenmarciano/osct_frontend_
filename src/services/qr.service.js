const QRCode = require('qrcode')
const crypto = require('crypto')
const prisma = require('../lib/prisma')

// Login QR — long-lived JWT-encoded QR; payload signed in routes layer
async function generateLoginQR(jwtToken) {
  return await QRCode.toDataURL(jwtToken, {
    errorCorrectionLevel: 'M',
    width: 360,
    margin: 2,
  })
}

// Session rotating QR — random 32-byte token, 30s TTL
async function rotateSessionToken(sessionId) {
  const token = crypto.randomBytes(24).toString('base64url')
  const expiresAt = new Date(Date.now() + 30 * 1000)

  await prisma.qRToken.create({
    data: { session_id: sessionId, token, expires_at: expiresAt },
  })

  const qrPngDataUrl = await QRCode.toDataURL(
    JSON.stringify({ t: token, s: sessionId }),
    { errorCorrectionLevel: 'M', width: 360, margin: 2 }
  )
  return { token, qrPngDataUrl, expiresAt }
}

async function generateSessionQR(token) {
  return await QRCode.toDataURL(token, {
    errorCorrectionLevel: 'M',
    width: 360,
    margin: 2,
  })
}

module.exports = { generateLoginQR, rotateSessionToken, generateSessionQR }
