const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const env = require('./config/env')

const app = express()

app.use(helmet())
app.use(cors({ origin: env.CLIENT_URL, credentials: true }))
app.use(express.json({ limit: '20mb' }))
app.use(express.urlencoded({ extended: true }))

// Request logging (lightweight)
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    const dur = Date.now() - start
    if (env.NODE_ENV !== 'test') {
      console.log(`${req.method} ${req.originalUrl} → ${res.statusCode} (${dur}ms)`)
    }
  })
  next()
})

// Health check
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }))

// API v1 routes
const api = express.Router()
api.use('/auth', require('./routes/auth'))
api.use('/programs', require('./routes/programs'))
api.use('/courses', require('./routes/courses'))
api.use('/videos', require('./routes/videos'))
api.use('/tests', require('./routes/tests'))
api.use('/sessions', require('./routes/sessions'))
api.use('/attendance', require('./routes/attendance'))
api.use('/certificates', require('./routes/certificates'))
api.use('/ai', require('./routes/ai'))
api.use('/kb', require('./routes/kb'))
api.use('/users', require('./routes/users'))
api.use('/reports', require('./routes/reports'))
api.use('/emails', require('./routes/emails'))

// Public certificate claim + verify (mounted at /api/v1)
api.use('/', require('./routes/publicCert'))

app.use('/api/v1', api)

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }))

// Global error handler
app.use((err, req, res, _next) => {
  if (err?.issues) {
    return res.status(400).json({ error: 'Validation error', details: err.issues })
  }
  console.error('[ERROR]', err)
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  })
})

module.exports = app
