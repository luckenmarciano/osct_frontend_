// Vercel serverless entry point.
// Wraps the Express app with serverless-http so it runs as a single function.
const serverless = require('serverless-http')
const { createApp } = require('../src/app')

const app = createApp()
module.exports = serverless(app)
