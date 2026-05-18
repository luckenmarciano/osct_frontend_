const Anthropic = require('@anthropic-ai/sdk')
const env = require('./env')

let client = null

function getClaudeClient() {
  if (!client) {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set')
    }
    client = new Anthropic.default({ apiKey: env.ANTHROPIC_API_KEY })
  }
  return client
}

const CHAT_MODEL = 'claude-sonnet-4-6'

module.exports = { getClaudeClient, CHAT_MODEL }
