const prisma = require('../lib/prisma')
const { getGeminiClient, CHAT_MODEL, EMBED_MODEL } = require('../config/gemini')
const pdfParse = require('pdf-parse')
const mammoth = require('mammoth')

const EMBED_DIM = 768 // Gemini text-embedding-004

/**
 * Simple text chunking — splits by paragraph boundaries to ~1500 chars per chunk.
 */
function chunkText(text, maxLen = 1500) {
  const paragraphs = text.split(/\n\s*\n/)
  const chunks = []
  let current = ''
  for (const p of paragraphs) {
    if ((current + '\n\n' + p).length > maxLen && current) {
      chunks.push(current.trim())
      current = p
    } else {
      current = current ? `${current}\n\n${p}` : p
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}

/**
 * Real embedding via Google Gemini text-embedding-004 (768 dim, free tier).
 * Falls back to deterministic pseudo-embedding if GEMINI_API_KEY missing.
 */
function pseudoEmbedding(text) {
  const vec = new Array(EMBED_DIM).fill(0)
  for (let i = 0; i < text.length; i++) {
    const idx = (text.charCodeAt(i) * 7919) % EMBED_DIM
    vec[idx] += 1
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
  return vec.map((v) => v / norm)
}

async function embedText(text, taskType = 'RETRIEVAL_DOCUMENT') {
  if (!process.env.GEMINI_API_KEY) return pseudoEmbedding(text)

  try {
    const client = getGeminiClient()
    const model = client.getGenerativeModel({ model: EMBED_MODEL })
    const result = await model.embedContent({
      content: { parts: [{ text }] },
      taskType,
      outputDimensionality: EMBED_DIM, // request 768-dim output
    })
    return result.embedding.values
  } catch (err) {
    console.warn('[ai.service] embed failed, using pseudo-embedding:', err.message)
    return pseudoEmbedding(text)
  }
}

/**
 * Extract plain text from an uploaded file buffer.
 * - text/*        → UTF-8 decode
 * - PDF           → pdf-parse (extracts all page text)
 * - DOCX / Word   → mammoth (extracts paragraph text)
 * Falls back to UTF-8 for unknown types.
 */
async function extractText(buffer, mimeType) {
  const mime = (mimeType || '').toLowerCase()

  if (mime.startsWith('text/') || mime === 'text/plain') {
    return buffer.toString('utf-8')
  }

  if (mime === 'application/pdf' || mime.includes('pdf')) {
    try {
      const data = await pdfParse(buffer)
      const text = data.text?.trim()
      if (!text) throw new Error('PDF parsed but no text found — may be scanned/image-only.')
      console.log(`[extractText] PDF: ${data.numpages} pages, ${text.length} chars extracted`)
      return text
    } catch (err) {
      console.error('[extractText] PDF parse error:', err.message)
      throw new Error(`Gagal membaca PDF: ${err.message}`)
    }
  }

  if (
    mime.includes('wordprocessingml') ||   // .docx
    mime.includes('msword') ||             // .doc (legacy)
    mime.includes('officedocument')
  ) {
    try {
      const result = await mammoth.extractRawText({ buffer })
      const text = result.value?.trim()
      if (result.messages?.length) {
        result.messages.forEach((m) => console.warn('[extractText] mammoth:', m.message))
      }
      if (!text) throw new Error('DOCX parsed but no text found.')
      console.log(`[extractText] DOCX: ${text.length} chars extracted`)
      return text
    } catch (err) {
      console.error('[extractText] DOCX parse error:', err.message)
      throw new Error(`Gagal membaca DOCX: ${err.message}`)
    }
  }

  // Fallback: try UTF-8 (handles .md, .txt with wrong mime)
  console.warn(`[extractText] Unknown mime "${mimeType}", falling back to UTF-8`)
  return buffer.toString('utf-8')
}

async function ingestDocument({ docId, programId, buffer, mimeType }) {
  let text
  try {
    text = await extractText(buffer, mimeType)
  } catch (err) {
    // Mark doc with error so UI can show "Gagal" instead of spinning forever
    await prisma.knowledgeBaseDoc.update({
      where: { id: docId },
      data: { embed_error: err.message },
    }).catch(() => {})
    throw err
  }

  if (!text || text.trim().length < 10) {
    const msg = 'Dokumen tidak mengandung teks yang bisa dibaca (mungkin gambar/scan).'
    await prisma.knowledgeBaseDoc.update({
      where: { id: docId },
      data: { embed_error: msg },
    }).catch(() => {})
    throw new Error(msg)
  }

  const chunks = chunkText(text)
  console.log(`[ingestDocument] docId=${docId} → ${chunks.length} chunks dari ${text.length} chars`)

  for (let i = 0; i < chunks.length; i++) {
    const embedding = await embedText(chunks[i], 'RETRIEVAL_DOCUMENT')
    const embeddingLiteral = `[${embedding.join(',')}]`

    await prisma.$executeRawUnsafe(
      `INSERT INTO "knowledge_base_chunks" (id, doc_id, program_id, chunk_text, chunk_index, created_at, embedding)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, NOW(), $5::vector)`,
      docId,
      programId,
      chunks[i],
      i,
      embeddingLiteral
    )
  }

  await prisma.knowledgeBaseDoc.update({
    where: { id: docId },
    data: { embedded_at: new Date(), embed_error: null },
  })
}

/**
 * RAG chat with strict program isolation.
 */
async function ragChat({ programId, query, history = [] }) {
  // 1. Embed the query
  const queryEmbedding = await embedText(query, 'RETRIEVAL_QUERY')
  const queryLiteral = `[${queryEmbedding.join(',')}]`

  // 2. Vector search — ALWAYS filter program_id (zero cross-program leakage)
  let chunks = []
  try {
    chunks = await prisma.$queryRawUnsafe(
      `SELECT c.id, c.chunk_text, c.doc_id, d.filename,
              1 - (c.embedding <=> $1::vector) as similarity
       FROM "knowledge_base_chunks" c
       JOIN "knowledge_base_docs" d ON d.id = c.doc_id
       WHERE c.program_id = $2
       ORDER BY c.embedding <=> $1::vector
       LIMIT 5`,
      queryLiteral,
      programId
    )
  } catch (e) {
    console.warn('[ai.service] vector search skipped:', e.message)
    chunks = []
  }

  // 3. Build context from retrieved chunks
  const context = chunks
    .map((c, i) => `[${i + 1}] (${c.filename})\n${c.chunk_text}`)
    .join('\n\n---\n\n')

  const systemInstruction = `Anda adalah asisten AI untuk pelatihan OPRC (Oil Pollution Preparedness, Response and Co-operation).
Jawab pertanyaan peserta HANYA berdasarkan konteks dokumen yang diberikan di bawah ini.
Jika informasi tidak ada di konteks, katakan dengan jujur: "Mohon maaf, informasi tersebut tidak ditemukan dalam materi pelatihan ini."
Gunakan Bahasa Indonesia yang jelas dan profesional. Sertakan rujukan ke nomor dokumen [1], [2], dst saat relevan.

Konteks:
${context || '(belum ada dokumen di knowledge base program ini)'}`

  // 4. Call Gemini chat
  let answer
  try {
    if (!process.env.GEMINI_API_KEY) {
      answer = `(GEMINI_API_KEY belum dikonfigurasi. Tambahkan ke backend/.env untuk mengaktifkan AI.)\n\nKonteks yang ditemukan: ${chunks.length} chunk dari ${new Set(chunks.map((c) => c.filename)).size} dokumen.`
    } else {
      const client = getGeminiClient()
      const model = client.getGenerativeModel({
        model: CHAT_MODEL,
        systemInstruction,
      })

      // Build Gemini's message format from history
      const contents = [
        ...history.slice(-10).map((h) => ({
          role: h.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: h.content }],
        })),
        { role: 'user', parts: [{ text: query }] },
      ]

      const result = await model.generateContent({ contents })
      answer = result.response.text()
    }
  } catch (e) {
    console.error('[ai.service] Gemini call failed:', e.message)
    answer = `(AI tidak tersedia: ${e.message})`
  }

  const sources = chunks.map((c) => ({
    docId: c.doc_id,
    filename: c.filename,
    chunkText: c.chunk_text.slice(0, 200),
    similarity: c.similarity,
  }))

  return { answer, sources }
}

module.exports = { embedText, chunkText, ingestDocument, ragChat, EMBED_DIM }
