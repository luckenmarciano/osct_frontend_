const { GoogleGenerativeAI } = require('@google/generative-ai')
const env = require('./env')

let client = null

function getGeminiClient() {
  if (!client) {
    if (!env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not set')
    }
    client = new GoogleGenerativeAI(env.GEMINI_API_KEY)
  }
  return client
}

const CHAT_MODEL = 'gemini-2.5-flash-lite' // free tier-friendly
const EMBED_MODEL = 'gemini-embedding-001' // 3072 dim, configurable to 768

module.exports = { getGeminiClient, CHAT_MODEL, EMBED_MODEL }
