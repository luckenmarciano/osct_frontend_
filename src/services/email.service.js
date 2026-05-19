const { Resend } = require('resend')
const env = require('../config/env')
const prisma = require('../lib/prisma')

let resend = null

function getResend() {
  if (!resend) {
    if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured')
    resend = new Resend(env.RESEND_API_KEY)
  }
  return resend
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function bodyToHtml(body) {
  return escapeHtml(body).replace(/\r?\n/g, '<br/>')
}

function wrapHtml(innerHtml, opts = {}) {
  return `
  <div style="font-family: system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color:#0F172A;">
    ${opts.heading ? `<h2 style="margin:0 0 16px;">${escapeHtml(opts.heading)}</h2>` : ''}
    <div style="line-height:1.6; font-size:15px;">${innerHtml}</div>
    <hr style="border:none; border-top:1px solid #E2E8F0; margin:24px 0;"/>
    <p style="color:#64748B; font-size:12px; margin:0;">
      Email ini dikirim dari sistem OSCT — OPRC Training Platform.
      ${opts.programName ? `<br/>Program: ${escapeHtml(opts.programName)}` : ''}
    </p>
  </div>
  `
}

async function safeLog(entry) {
  try {
    await prisma.emailLog.create({ data: entry })
  } catch (err) {
    // Don't break sends if log table missing (e.g. before db push)
    console.warn('[email_log] insert failed:', err.message)
  }
}

// ─── Existing: cert verification code ────────────────────────────────────────
async function sendVerificationCodeEmail({ to, participantName, programName, code, expiresAt, sentById, programId }) {
  const subject = `[OSCT] Kode Verifikasi Sertifikat ${programName}`
  const html = `
  <div style="font-family: system-ui, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
    <h2 style="color: #0F172A;">Selamat, ${escapeHtml(participantName)}!</h2>
    <p>Anda berhak memperoleh sertifikat untuk program <strong>${escapeHtml(programName)}</strong>.</p>
    <p>Gunakan kode verifikasi berikut untuk mengklaim sertifikat Anda:</p>
    <div style="background:#F1F5F9; padding:16px; border-radius:8px; text-align:center; font-family: monospace; font-size: 22px; letter-spacing: 2px; margin: 16px 0;">
      ${escapeHtml(code)}
    </div>
    <p>Kode berlaku hingga: <strong>${expiresAt.toLocaleString('id-ID')}</strong></p>
    <p style="color:#64748B; font-size:13px; margin-top:24px;">
      Klaim sertifikat di halaman: <a href="${env.CLIENT_URL}/?claim=1">${env.CLIENT_URL}</a>
    </p>
  </div>
  `

  const baseLog = {
    program_id: programId || null,
    sent_by_id: sentById || null,
    kind: 'CERT_VERIFICATION',
    to_email: to,
    to_name: participantName,
    subject,
    body_preview: `Code ${code} expires ${expiresAt.toISOString()}`,
  }

  if (!env.RESEND_API_KEY) {
    console.log(`[EMAIL — would send to ${to}]`)
    console.log(`  Program: ${programName}`)
    console.log(`  Code: ${code}`)
    console.log(`  Expires: ${expiresAt.toISOString()}`)
    await safeLog({ ...baseLog, status: 'mocked' })
    return { mocked: true }
  }

  try {
    const { data, error } = await getResend().emails.send({
      from: env.EMAIL_FROM,
      to,
      subject,
      html,
    })
    if (error) throw error
    await safeLog({ ...baseLog, status: 'sent' })
    return data
  } catch (err) {
    await safeLog({ ...baseLog, status: 'failed', error: err.message })
    throw err
  }
}

// ─── New: generic custom email ───────────────────────────────────────────────
async function sendCustomEmail({ to, toName, subject, body, programId, programName, sentById, kind = 'CUSTOM' }) {
  const html = wrapHtml(bodyToHtml(body), { programName })
  const baseLog = {
    program_id: programId || null,
    sent_by_id: sentById || null,
    kind,
    to_email: to,
    to_name: toName || null,
    subject,
    body_preview: body.slice(0, 500),
  }

  if (!env.RESEND_API_KEY) {
    console.log(`[EMAIL — would send to ${to}]`)
    console.log(`  Subject: ${subject}`)
    console.log(`  Body: ${body.slice(0, 200)}${body.length > 200 ? '…' : ''}`)
    await safeLog({ ...baseLog, status: 'mocked' })
    return { mocked: true, to }
  }

  try {
    const { data, error } = await getResend().emails.send({
      from: env.EMAIL_FROM,
      to,
      subject,
      html,
    })
    if (error) throw error
    await safeLog({ ...baseLog, status: 'sent' })
    return { sent: true, id: data?.id, to }
  } catch (err) {
    await safeLog({ ...baseLog, status: 'failed', error: err.message })
    return { failed: true, error: err.message, to }
  }
}

// ─── New: bulk broadcast (uses sendCustomEmail per recipient) ───────────────
async function sendBroadcastEmails({ recipients, subject, body, programId, programName, sentById }) {
  const results = []
  for (const r of recipients) {
    const result = await sendCustomEmail({
      to: r.email,
      toName: r.full_name || r.name || null,
      subject,
      body,
      programId,
      programName,
      sentById,
      kind: 'BROADCAST',
    })
    results.push({ email: r.email, ...result })
  }
  return results
}

// ─── New: session reminder ──────────────────────────────────────────────────
async function sendSessionReminderEmail({ recipients, session, programName, sentById }) {
  const dt = new Date(session.scheduled_at)
  const dateStr = dt.toLocaleString('id-ID', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
  const subject = `[OSCT] Pengingat Sesi: ${session.title}`
  const body =
    `Halo,\n\n` +
    `Ini pengingat bahwa Anda memiliki jadwal sesi tatap muka berikut:\n\n` +
    `Judul   : ${session.title}\n` +
    `Jadwal  : ${dateStr}\n` +
    (session.location ? `Lokasi  : ${session.location}\n` : '') +
    (session.trainer?.full_name ? `Trainer : ${session.trainer.full_name}\n` : '') +
    `\nMohon hadir tepat waktu. Jika berhalangan, segera hubungi trainer.\n\n` +
    `Terima kasih.`

  const results = []
  for (const r of recipients) {
    const result = await sendCustomEmail({
      to: r.email,
      toName: r.full_name || null,
      subject,
      body,
      programId: session.program_id,
      programName,
      sentById,
      kind: 'SESSION_REMINDER',
    })
    results.push({ email: r.email, ...result })
  }
  return results
}

// ─── New: login QR email ────────────────────────────────────────────────────
async function sendLoginQREmail({ to, participantName, programName, qrPngDataUrl, expiresAt, sentById, programId }) {
  const subject = `[OSCT] QR Login ${programName}`
  // Strip data URL prefix to get raw base64 for inline attachment
  const base64 = (qrPngDataUrl || '').replace(/^data:image\/png;base64,/, '')

  const html = `
  <div style="font-family: system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
    <h2 style="color: #0F172A; margin-top: 0;">Halo ${escapeHtml(participantName)},</h2>
    <p>Berikut QR login Anda untuk program <strong>${escapeHtml(programName)}</strong>.</p>
    <p>Cara pakai:</p>
    <ol style="color:#334155; line-height:1.7;">
      <li>Buka aplikasi OSCT di <a href="${env.CLIENT_URL}">${env.CLIENT_URL}</a>.</li>
      <li>Pilih opsi <strong>Masuk via QR</strong>.</li>
      <li>Scan QR di bawah dengan kamera, atau salin token dan tempel manual.</li>
    </ol>
    <div style="text-align:center; margin:24px 0;">
      <img src="cid:loginqr" alt="Login QR" style="width:240px; height:240px; border:1px solid #E2E8F0;"/>
    </div>
    <p style="font-size:12px; color:#64748B;">QR ini berlaku sampai <strong>${expiresAt.toLocaleDateString('id-ID')}</strong>. Jangan bagikan ke orang lain.</p>
  </div>
  `

  const baseLog = {
    program_id: programId || null,
    sent_by_id: sentById || null,
    kind: 'CUSTOM',
    to_email: to,
    to_name: participantName,
    subject,
    body_preview: `Login QR expires ${expiresAt.toISOString()}`,
  }

  if (!env.RESEND_API_KEY) {
    console.log(`[EMAIL — would send login QR to ${to}]`)
    console.log(`  Program: ${programName}`)
    console.log(`  Expires: ${expiresAt.toISOString()}`)
    await safeLog({ ...baseLog, status: 'mocked' })
    return { mocked: true }
  }

  try {
    const { data, error } = await getResend().emails.send({
      from: env.EMAIL_FROM,
      to,
      subject,
      html,
      attachments: base64
        ? [{ filename: 'login-qr.png', content: base64, content_id: 'loginqr' }]
        : undefined,
    })
    if (error) throw error
    await safeLog({ ...baseLog, status: 'sent' })
    return data
  } catch (err) {
    await safeLog({ ...baseLog, status: 'failed', error: err.message })
    throw err
  }
}

async function sendPasswordResetEmail({ to, fullName, resetUrl }) {
  const subject = `[OSCT] Reset Password Anda`
  const html = `
  <div style="font-family: system-ui, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
    <h2 style="color: #0F172A;">Reset Password</h2>
    <p>Hai ${escapeHtml(fullName || '')},</p>
    <p>Kami menerima permintaan untuk mengatur ulang password akun OSCT Anda. Klik tombol di bawah untuk membuat password baru:</p>
    <div style="text-align:center; margin:24px 0;">
      <a href="${resetUrl}" style="background:#0F172A; color:white; padding:12px 24px; text-decoration:none; border-radius:6px; display:inline-block;">Reset Password</a>
    </div>
    <p style="color:#64748B; font-size:13px;">Atau buka URL berikut di browser Anda:</p>
    <p style="word-break:break-all; font-family:monospace; font-size:12px; color:#0F172A;">${resetUrl}</p>
    <p style="color:#64748B; font-size:13px; margin-top:24px;">
      Link ini berlaku 1 jam. Jika Anda tidak meminta reset password, abaikan email ini — password Anda tetap aman.
    </p>
  </div>
  `

  const baseLog = {
    program_id: null,
    sent_by_id: null,
    kind: 'CUSTOM',
    to_email: to,
    to_name: fullName || null,
    subject,
    body_preview: 'Password reset link',
  }

  if (!env.RESEND_API_KEY) {
    console.log(`[EMAIL — would send password reset to ${to}]`)
    console.log(`  Reset URL: ${resetUrl}`)
    await safeLog({ ...baseLog, status: 'mocked' })
    return { mocked: true, resetUrl }
  }

  try {
    const { data, error } = await getResend().emails.send({
      from: env.EMAIL_FROM,
      to,
      subject,
      html,
    })
    if (error) throw error
    await safeLog({ ...baseLog, status: 'sent' })
    return data
  } catch (err) {
    await safeLog({ ...baseLog, status: 'failed', error: err.message })
    throw err
  }
}

module.exports = {
  sendVerificationCodeEmail,
  sendCustomEmail,
  sendBroadcastEmails,
  sendSessionReminderEmail,
  sendLoginQREmail,
  sendPasswordResetEmail,
}
