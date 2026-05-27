require('dotenv').config()
const { z } = require('zod')

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1).optional(),

  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_QR_SECRET: z.string().min(16),
  JWT_ACCESS_EXPIRES: z.string().default('15m'),
  JWT_REFRESH_EXPIRES: z.string().default('7d'),

  GEMINI_API_KEY: z.string().optional().transform((v) => (v?.trim() ? v.trim() : undefined)),

  SUPABASE_URL: z.string().optional().transform((v) => (v?.trim() ? v.trim() : undefined)),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().transform((v) => (v?.trim() ? v.trim() : undefined)),

  RESEND_API_KEY: z.string().optional().transform((v) => (v?.trim() ? v.trim() : undefined)),
  EMAIL_FROM: z.string().default('OSCT Platform <noreply@example.com>'),

  // Shared secret for the Vercel Cron session-reminder endpoint. When set,
  // Vercel Cron sends it as a Bearer token; the endpoint rejects requests
  // that don't match (and rejects everything when the secret is unset).
  CRON_SECRET: z.string().optional().transform((v) => (v?.trim() ? v.trim() : undefined)),

  PORT: z.coerce.number().default(4000),
  // Comma-separated list of allowed frontend origins (no trailing slash).
  // Override per-environment in Vercel project settings.
  CLIENT_URL: z
    .string()
    .default('http://localhost:5173,https://osct-frontend-tawny.vercel.app'),
  NODE_ENV: z.string().default('development'),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  console.error('Invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

module.exports = parsed.data
