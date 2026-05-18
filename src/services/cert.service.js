const { uploadToStorage } = require('./storage.service')

let puppeteer
try {
  puppeteer = require('puppeteer')
} catch (e) {
  console.warn('[cert.service] Puppeteer not installed — PDF generation disabled')
}

function buildCertHTML({ certNo, participantName, programName, programColor, issuedAt }) {
  const date = new Date(issuedAt).toLocaleDateString('id-ID', {
    day: 'numeric', month: 'long', year: 'numeric',
  })
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { size: A4 landscape; margin: 0; }
    body { font-family: 'Georgia', serif; margin: 0; }
    .cert {
      width: 297mm; height: 210mm;
      background: linear-gradient(135deg, ${programColor}11 0%, #fff 50%, ${programColor}22 100%);
      border: 14px solid ${programColor};
      padding: 60px 80px;
      display: flex; flex-direction: column;
      box-sizing: border-box;
    }
    .head { text-align:center; }
    .h-brand { font-size: 16px; letter-spacing: 4px; color: ${programColor}; }
    .h-title { font-size: 56px; margin: 8px 0; color: #1e293b; }
    .h-sub { font-size: 18px; color: #475569; }
    .body { flex: 1; display:flex; flex-direction:column; justify-content:center; text-align:center; }
    .for { font-size: 18px; color:#475569; }
    .name { font-size: 48px; margin: 16px 0; color: #0F172A; font-style: italic; }
    .program { font-size: 24px; color: ${programColor}; margin: 8px 0; }
    .footer { display:flex; justify-content:space-between; align-items:flex-end; }
    .sig { width: 220px; text-align:center; border-top: 1px solid #64748B; padding-top: 8px; font-size: 14px; color: #475569; }
    .cert-no { font-family: monospace; font-size: 12px; color: #64748B; }
  </style></head><body>
    <div class="cert">
      <div class="head">
        <div class="h-brand">OSCT — OIL SPILL COMBAT TRAINING</div>
        <div class="h-title">Certificate of Completion</div>
        <div class="h-sub">Sertifikat Penyelesaian Pelatihan</div>
      </div>
      <div class="body">
        <div class="for">Diberikan kepada / Awarded to</div>
        <div class="name">${participantName}</div>
        <div class="for">Telah berhasil menyelesaikan / has successfully completed</div>
        <div class="program">${programName}</div>
        <div class="for">pada / on ${date}</div>
      </div>
      <div class="footer">
        <div class="cert-no">No. Sertifikat: ${certNo}</div>
        <div class="sig">Penyelenggara<br/>OSCT Training</div>
      </div>
    </div>
  </body></html>`
}

async function generateCertificatePDF({ certNo, participantName, programName, programColor, issuedAt }) {
  if (!puppeteer) {
    // Fallback: skip PDF, return a placeholder URL or raise
    throw new Error('Puppeteer not available — install puppeteer to enable PDF generation')
  }
  const html = buildCertHTML({ certNo, participantName, programName, programColor, issuedAt })

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'networkidle0' })
    const pdf = await page.pdf({ format: 'A4', landscape: true, printBackground: true })

    const safeName = certNo.replace(/[^A-Z0-9]/gi, '_')
    const path = `certificates/${safeName}.pdf`
    const url = await uploadToStorage('certificates', path, pdf, 'application/pdf')
    return url
  } finally {
    await browser.close()
  }
}

module.exports = { generateCertificatePDF }
