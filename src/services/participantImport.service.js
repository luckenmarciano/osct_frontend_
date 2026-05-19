const bcrypt = require('bcryptjs')
const prisma = require('../lib/prisma')
const { signQRToken } = require('../middleware/auth')
const { generateLoginQR } = require('./qr.service')
const { sendLoginQREmail } = require('./email.service')
const { auditLog } = require('./audit.service')

// 14-column header expected in the CSV (case- and whitespace-insensitive).
// Order doesn't matter, but every column must be present.
const REQUIRED_COLUMNS = [
  'email',
  'company_id',
  'client_company',
  'client_id',
  'full_name',
  'place_of_birth',
  'date_of_birth',
  'training_type',
  'training_date',
  'nautical_cert_no',
  'nautical_cert_expired_date',
  'hubla_cert_no',
  'hubla_cert_expired_date',
]

function normalizeHeader(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

// Minimal RFC-4180-ish CSV parser. Handles:
// - Quoted fields with embedded commas and newlines
// - Double-quote escapes ("")
// - CRLF and LF line endings
// - Empty trailing fields
// Returns array of arrays of strings.
function parseCSV(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  let i = 0
  const len = text.length

  // Strip BOM
  if (text.charCodeAt(0) === 0xfeff) i = 1

  while (i < len) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i++
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (ch === '\r') {
      // swallow \r\n as one line break
      if (text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
      continue
    }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
      continue
    }
    field += ch
    i++
  }
  // Final field / row
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  // Drop fully empty trailing rows
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === '')) {
    rows.pop()
  }
  return rows
}

// Accepts ISO yyyy-mm-dd, dd/mm/yyyy, or dd-mm-yyyy (Indonesian-friendly).
// Returns Date | null. Throws if non-empty value is unparseable.
function parseDate(value, fieldName) {
  const v = String(value || '').trim()
  if (!v) return null
  const iso = /^\d{4}-\d{2}-\d{2}$/
  const dmySlash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/
  const dmyDash = /^(\d{1,2})-(\d{1,2})-(\d{4})$/
  let d
  if (iso.test(v)) d = new Date(v + 'T00:00:00Z')
  else if (dmySlash.test(v)) {
    const [, dd, mm, yyyy] = v.match(dmySlash)
    d = new Date(`${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T00:00:00Z`)
  } else if (dmyDash.test(v)) {
    const [, dd, mm, yyyy] = v.match(dmyDash)
    d = new Date(`${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T00:00:00Z`)
  } else {
    d = new Date(v)
  }
  if (Number.isNaN(d.getTime())) {
    throw new Error(`${fieldName} bukan tanggal yang valid: "${v}"`)
  }
  return d
}

// Extract OPRC level (1|2|3) from training_type strings like
// "OPRC Level 2", "Level-3", "oprc 1", "Level 2 Refresher", etc.
function extractLevel(trainingType) {
  if (!trainingType) return null
  const m = String(trainingType).match(/(?:level|lvl|l)\s*[-_]?\s*([123])/i)
  if (m) return parseInt(m[1], 10)
  const bare = String(trainingType).match(/\b([123])\b/)
  return bare ? parseInt(bare[1], 10) : null
}

function buildEmailRegex() {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/
}

/**
 * Run the batch import. Each row is validated, then the User → ParticipantProfile
 * → ProgramEnrollment chain is upserted in a per-row transaction so a single
 * bad row never aborts the whole file.
 *
 * @returns { total, created, updated, enrolled, skipped, errors }
 */
async function importParticipantsCSV({
  csvBuffer,
  programId,
  sendQrEmail,
  actingUserId,
  req,
}) {
  const program = await prisma.oPRCProgram.findUnique({ where: { id: programId } })
  if (!program) throw new Error('Program not found')

  const text = csvBuffer.toString('utf8')
  const rows = parseCSV(text)
  if (rows.length < 2) {
    return {
      total: 0,
      created: 0,
      updated: 0,
      enrolled: 0,
      skipped: 0,
      errors: [{ row: 0, reason: 'CSV kosong atau hanya berisi header' }],
    }
  }

  const headers = rows[0].map(normalizeHeader)
  const colIndex = Object.fromEntries(headers.map((h, idx) => [h, idx]))

  const missing = REQUIRED_COLUMNS.filter((c) => !(c in colIndex))
  if (missing.length > 0) {
    return {
      total: 0,
      created: 0,
      updated: 0,
      enrolled: 0,
      skipped: 0,
      errors: [
        {
          row: 1,
          reason: `Kolom header tidak lengkap. Hilang: ${missing.join(', ')}`,
        },
      ],
    }
  }

  const emailRegex = buildEmailRegex()
  const dataRows = rows.slice(1)
  const result = {
    total: dataRows.length,
    created: 0,
    updated: 0,
    enrolled: 0,
    skipped: 0,
    errors: [],
  }

  for (let i = 0; i < dataRows.length; i++) {
    const cols = dataRows[i]
    const rowNum = i + 2 // 1-based, +1 for header row
    const get = (key) => (cols[colIndex[key]] || '').trim()

    try {
      const email = get('email').toLowerCase()
      const fullName = get('full_name')

      if (!email) throw new Error('email kosong')
      if (!emailRegex.test(email)) throw new Error(`email tidak valid: ${email}`)
      if (!fullName) throw new Error('full_name kosong')

      const trainingType = get('training_type')
      const csvLevel = extractLevel(trainingType)
      if (csvLevel != null && csvLevel !== program.level) {
        throw new Error(
          `training_type "${trainingType}" tidak cocok dengan program level ${program.level}`
        )
      }

      const profileData = {
        company_id: get('company_id') || null,
        client_company: get('client_company') || null,
        client_id: get('client_id') || null,
        place_of_birth: get('place_of_birth') || null,
        date_of_birth: parseDate(get('date_of_birth'), 'date_of_birth'),
        training_type: trainingType || null,
        training_date: parseDate(get('training_date'), 'training_date'),
        nautical_cert_no: get('nautical_cert_no') || null,
        nautical_cert_expires_at: parseDate(
          get('nautical_cert_expired_date'),
          'nautical_cert_expired_date'
        ),
        hubla_cert_no: get('hubla_cert_no') || null,
        hubla_cert_expires_at: parseDate(
          get('hubla_cert_expired_date'),
          'hubla_cert_expired_date'
        ),
      }

      // Find-or-create user
      const existing = await prisma.user.findUnique({ where: { email } })
      let user
      let plainPassword = null
      if (existing) {
        user = existing
        if (existing.full_name !== fullName) {
          user = await prisma.user.update({
            where: { id: existing.id },
            data: { full_name: fullName },
          })
          result.updated++
        }
      } else {
        plainPassword = Math.random().toString(36).slice(-10) + 'A1!'
        const hash = await bcrypt.hash(plainPassword, 10)
        user = await prisma.user.create({
          data: {
            email,
            full_name: fullName,
            password_hash: hash,
            role: 'PARTICIPANT',
          },
        })
        result.created++
      }

      // Upsert participant profile
      await prisma.participantProfile.upsert({
        where: { user_id: user.id },
        update: profileData,
        create: { ...profileData, user_id: user.id },
      })

      // Upsert enrollment
      const existingEnrollment = await prisma.programEnrollment.findUnique({
        where: { user_id_program_id: { user_id: user.id, program_id: programId } },
      })
      if (!existingEnrollment) {
        await prisma.programEnrollment.create({
          data: { user_id: user.id, program_id: programId },
        })
        result.enrolled++
      }

      // Optional: generate QR and email
      if (sendQrEmail) {
        const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
        const qrToken = signQRToken({ userId: user.id, programId })

        await prisma.participantLoginQR.upsert({
          where: {
            user_id_program_id: { user_id: user.id, program_id: programId },
          },
          update: { qr_token: qrToken, expires_at: expiresAt },
          create: {
            user_id: user.id,
            program_id: programId,
            qr_token: qrToken,
            expires_at: expiresAt,
          },
        })

        const qrPngDataUrl = await generateLoginQR(qrToken)
        await sendLoginQREmail({
          to: user.email,
          participantName: user.full_name,
          programName: program.name,
          qrPngDataUrl,
          expiresAt,
          sentById: actingUserId,
          programId,
        }).catch((e) => {
          // Email failure isn't fatal — record but keep the enrollment
          result.errors.push({
            row: rowNum,
            email,
            reason: `QR email gagal: ${e.message}`,
          })
        })
      }
    } catch (err) {
      result.skipped++
      result.errors.push({ row: rowNum, email: cols[colIndex.email] || '', reason: err.message })
    }
  }

  auditLog({
    action: 'BATCH_PARTICIPANT_IMPORTED',
    userId: actingUserId,
    programId,
    metadata: {
      total: result.total,
      created: result.created,
      enrolled: result.enrolled,
      updated: result.updated,
      skipped: result.skipped,
      sendQrEmail: !!sendQrEmail,
    },
    req,
  })

  return result
}

module.exports = {
  importParticipantsCSV,
  REQUIRED_COLUMNS,
  parseCSV,
  parseDate,
  extractLevel,
}
