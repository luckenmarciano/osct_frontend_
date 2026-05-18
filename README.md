# OSCT Backend — OPRC Training Platform API

Express + Prisma + Supabase (PostgreSQL + pgvector) + Google Gemini.

Frontend repo: https://github.com/luckenmarciano/osct_frontend

## Local Dev

```bash
npm install
cp .env.example .env  # fill in your secrets
npm run db:push       # apply schema to Supabase
npm run db:seed       # create demo users
npm run dev           # http://localhost:4000
```

Demo accounts (password: `password123`):
- `admin@osct.id` — SUPER_ADMIN
- `trainer@osct.id` — TRAINER (OPRC 1/2/3)
- `peserta@osct.id` — PARTICIPANT (OPRC 1)

## Deploy to Vercel

1. Push to GitHub (already done).
2. Vercel → **Add New Project** → import this repo.
3. **Framework Preset:** Other (auto from `vercel.json`).
4. **Environment Variables** — copy from `.env.example` and fill values:
   - `DATABASE_URL`, `DIRECT_URL`
   - `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_QR_SECRET`
   - `GEMINI_API_KEY`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - `RESEND_API_KEY` (optional), `EMAIL_FROM`
   - `CLIENT_URL` = your frontend Vercel URL
   - `NODE_ENV=production`
5. Deploy. Endpoint will be `https://your-backend.vercel.app/api/v1/...`.
6. Health check: `GET /health` → `{"ok":true}`.

## API Routes

Base: `/api/v1/`

| Resource | Endpoints |
|---|---|
| Auth | `/auth/login`, `/auth/qr-login`, `/auth/refresh`, `/auth/logout` |
| Programs | `/programs`, `/programs/:pid/enrollments`, `/programs/:pid/enrollments/:eid/qr`, `.../qr/email` |
| Courses | `/courses/programs/:pid`, lesson progress |
| Tests | `/tests/programs/:pid/{pretest,posttest,learning-gain}` |
| Sessions | `/sessions/programs/:pid`, `.../upcoming`, CRUD, `/sessions/:id/qr/start`, `.../qr/current` |
| Attendance | `/attendance/scan` |
| Certificates | `/certificates/programs/:pid/eligible`, `.../send-code`, `/claim` (public), `/verify/:certNo` |
| AI | `/ai/programs/:pid/chat`, conversations |
| KB | `/kb/programs/:pid` (list, upload, delete) |
| Users | `/users/me`, `/users` (CRUD) |
| Reports | `/reports/programs/:pid/{progress,analytics}` |
| Emails | `/emails/programs/:pid/{send,broadcast,session-reminder/:sid,logs,recipients}` |

## Notes

- Prisma binary target `rhel-openssl-3.0.x` is set for Vercel runtime.
- `serverless-http` wraps Express for Vercel functions.
- `vercel.json` rewrites all paths to `api/index.js`.
- Function timeout 30s (Pro plan required for 30s, Hobby has 10s).
- Body limit: Hobby 4.5MB, Pro 50MB — affects file uploads.
