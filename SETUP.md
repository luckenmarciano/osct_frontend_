# OSCT — Panduan Setup di Laptop Baru

> **Oil Spill Combat Training Platform**  
> Stack: Node.js + Express + Prisma + PostgreSQL (Supabase) · React + Vite

---

## Prasyarat

Pastikan sudah terinstall di laptop baru:

| Tool | Versi minimum | Link download |
|---|---|---|
| Node.js | v18+ | https://nodejs.org |
| Git | v2+ | https://git-scm.com |
| npm | v9+ (ikut Node.js) | — |

---

## Step 1 — Clone Repositories

```bash
# Backend
git clone https://github.com/luckenmarciano/osct_backend

# Frontend
git clone https://github.com/luckenmarciano/osct_frontend
```

---

## Step 2 — Copy File Rahasia (.env)

File `.env` **tidak ada di GitHub** karena berisi password dan API key.  
Copy dari laptop lama / USB / email ke lokasi berikut:

```
osct_backend/
└── .env              ← copy file ini

osct_frontend/
└── .env.local        ← copy file ini
```

### Isi `.env` backend (template):

```env
# Database Supabase
DATABASE_URL=postgresql://postgres.[project]:[password]@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres?pgbouncer=true
DIRECT_URL=postgresql://postgres.[project]:[password]@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres

# JWT Secrets
JWT_ACCESS_SECRET=...
JWT_REFRESH_SECRET=...
JWT_QR_SECRET=...
JWT_ACCESS_EXPIRES=15m
JWT_REFRESH_EXPIRES=30d

# Google Gemini (AI & embedding)
GEMINI_API_KEY=...

# Supabase Storage
SUPABASE_URL=https://[project].supabase.co
SUPABASE_SERVICE_ROLE_KEY=...

# Resend (email)
RESEND_API_KEY=...
EMAIL_FROM=noreply@yourdomain.com

# App
PORT=4000
CLIENT_URL=http://localhost:5173,http://localhost:5174,http://localhost:5175
NODE_ENV=development

# Cron security (bisa diisi bebas untuk lokal)
CRON_SECRET=your-cron-secret-here
```

### Isi `.env.local` frontend:

```env
VITE_API_URL=http://localhost:4000/api/v1
```

---

## Step 3 — Install Dependencies

```bash
# Backend
cd osct_backend
npm install

# Frontend
cd ../osct_frontend
npm install
```

---

## Step 4 — Jalankan (2 terminal)

**Terminal 1 — Backend:**
```bash
cd osct_backend
npm run dev
# → Listening on http://localhost:4000
```

**Terminal 2 — Frontend:**
```bash
cd osct_frontend
npm run dev
# → http://localhost:5173
```

Buka browser ke **http://localhost:5173** ✓

---

## Catatan Penting

### Database
- Database ada di **Supabase (cloud)** — tidak perlu install PostgreSQL lokal.
- Tidak perlu `prisma db push` di laptop baru karena schema sudah tersync.
- Jika schema berubah (ada model baru), jalankan: `npx prisma db push`

### Email
- Resend dalam **test mode** sampai domain diverifikasi.
- Email hanya terkirim ke alamat pemilik akun Resend (`ayupermatasasii@gmail.com`).
- Di development, email yang "gagal terkirim" tetap ter-log di console.

### AI Knowledge Base
- Membutuhkan `GEMINI_API_KEY` untuk embedding PDF/DOCX.
- Tanpa API key, sistem jatuh ke pseudo-embedding (KB jalan tapi jawaban AI tidak akurat).
- Daftar gratis di: https://aistudio.google.com/apikey

### Cron Jobs
- Cron (`test-reminders`, `scheduled-exports`, `session-reminders`) berjalan otomatis di **Vercel production**.
- Di lokal, bisa trigger manual via:
  ```bash
  curl -H "Authorization: Bearer <CRON_SECRET>" http://localhost:4000/api/v1/tests/cron/test-reminders
  curl -H "Authorization: Bearer <CRON_SECRET>" http://localhost:4000/api/v1/reports/cron/scheduled-exports
  ```

---

## Struktur Proyek

```
osct_backend/
├── src/
│   ├── routes/          # Express route handlers (per fitur)
│   ├── services/        # Business logic (email, AI, storage, dll)
│   ├── middleware/       # auth, programIsolation, upload
│   ├── config/          # env, gemini, prisma lib
│   └── app.js           # Express app & route mounting
├── prisma/
│   └── schema.prisma    # Data model lengkap
├── docs/
│   └── PRD-OSCT.md      # Product Requirements Document
└── vercel.json          # Deployment + cron config

osct_frontend/
├── src/
│   ├── api/             # Axios API calls per fitur
│   ├── context/         # AppContext (auth, navigasi, program)
│   ├── screens/         # Semua layar (Admin, Trainer, Participant)
│   ├── shared/          # Icon, i18n, shared components
│   └── App.jsx          # Router utama (page-based, tanpa react-router)
├── public/
└── vite.config.js
```

---

## Akun & Layanan yang Diperlukan

| Layanan | Fungsi | Dashboard |
|---|---|---|
| **Supabase** | Database + Storage | https://supabase.com/dashboard |
| **Vercel** | Deploy backend + frontend | https://vercel.com/dashboard |
| **Resend** | Kirim email | https://resend.com/dashboard |
| **Google AI Studio** | Gemini API key | https://aistudio.google.com |

---

## Troubleshooting

**Backend tidak bisa connect ke DB:**
- Cek `DATABASE_URL` di `.env` sudah benar
- Pastikan IP laptop tidak diblokir Supabase (Settings → Database → Connection Pooling)

**Frontend CORS error:**
- Pastikan `CLIENT_URL` di `.env` backend mencantumkan `http://localhost:5173`

**Upload PDF tidak ter-embed:**
- Cek `GEMINI_API_KEY` sudah diisi
- PDF berbasis scan/gambar tidak bisa dibaca (perlu OCR)

**Port sudah dipakai:**
```bash
# Windows — matikan proses di port 4000
netstat -ano | findstr :4000
taskkill /PID <PID> /F
```
