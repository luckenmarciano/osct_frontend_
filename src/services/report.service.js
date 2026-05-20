let puppeteer
try {
  puppeteer = require('puppeteer')
} catch (e) {
  console.warn('[report.service] Puppeteer not installed — PDF generation disabled')
}

function esc(str = '') {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function fmtNum(n) {
  if (n == null) return '—'
  return Number.isFinite(n) ? String(Math.round(n)) : '—'
}

const PAGE_CSS = `
  @page { size: A4 portrait; margin: 16mm; }
  body { font-family: 'Helvetica', Arial, sans-serif; color: #0F172A; font-size: 11px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #64748B; font-size: 10px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th, td { border: 1px solid #E2E8F0; padding: 5px 7px; text-align: left; }
  th { background: #F1F5F9; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  h2 { font-size: 13px; margin: 18px 0 6px; }
  .summary { color: #475569; font-size: 10px; margin-bottom: 6px; }
`

/**
 * Render an HTML string into a PDF Buffer. Throws if puppeteer is unavailable.
 */
async function htmlToPdfBuffer(html) {
  if (!puppeteer) {
    throw new Error('Puppeteer not available — PDF generation disabled')
  }
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'networkidle0' })
    return await page.pdf({ format: 'A4', printBackground: true })
  } finally {
    await browser.close()
  }
}

function buildProgressReportHTML({ program, rows, generatedAt }) {
  const body = rows.length
    ? rows
        .map(
          (r) => `<tr>
            <td>${esc(r.name)}</td>
            <td>${esc(r.email)}</td>
            <td class="num">${fmtNum(r.pretest)}</td>
            <td class="num">${fmtNum(r.posttest)}</td>
            <td class="num">${r.gain != null ? fmtNum(r.gain) : '—'}</td>
            <td class="num">${fmtNum(r.attendance)}%</td>
            <td>${r.certEligible ? 'Ya' : 'Tidak'}</td>
          </tr>`
        )
        .join('')
    : `<tr><td colspan="7" style="text-align:center;color:#64748B;">Belum ada peserta.</td></tr>`

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${PAGE_CSS}</style></head><body>
    <h1>Laporan Progres Peserta</h1>
    <div class="meta">${esc(program?.name || '')} · Dibuat ${esc(generatedAt)}</div>
    <table>
      <thead><tr>
        <th>Nama</th><th>Email</th><th>Pretest</th><th>Posttest</th>
        <th>Gain</th><th>Kehadiran</th><th>Cert Eligible</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
  </body></html>`
}

function buildCoursesProgressReportHTML({ program, courses, generatedAt }) {
  const sections = courses.length
    ? courses
        .map((c) => {
          const rows = c.participants.length
            ? c.participants
                .map(
                  (p) => `<tr>
                    <td>${esc(p.name)}</td>
                    <td class="num">${p.completedLessons} / ${c.lessonCount}</td>
                    <td class="num">${fmtNum(p.completionPct)}%</td>
                    <td class="num">${fmtNum(p.posttestScore)}</td>
                  </tr>`
                )
                .join('')
            : `<tr><td colspan="4" style="text-align:center;color:#64748B;">Belum ada peserta.</td></tr>`
          return `
            <h2>${esc(c.title)}</h2>
            <div class="summary">${c.lessonCount} pelajaran · ${c.totalParticipants} peserta · rata-rata selesai ${fmtNum(c.avgCompletionPct)}%</div>
            <table>
              <thead><tr><th>Peserta</th><th>Modul Selesai</th><th>% Selesai</th><th>Posttest</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>`
        })
        .join('')
    : `<p style="color:#64748B;">Belum ada course di program ini.</p>`

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${PAGE_CSS}</style></head><body>
    <h1>Laporan Progres per Course</h1>
    <div class="meta">${esc(program?.name || '')} · Dibuat ${esc(generatedAt)}</div>
    ${sections}
  </body></html>`
}

module.exports = {
  htmlToPdfBuffer,
  buildProgressReportHTML,
  buildCoursesProgressReportHTML,
}
