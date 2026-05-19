const express = require('express')
const prisma = require('../lib/prisma')
const { verifyJWT, requireRole } = require('../middleware/auth')
const { programIsolation } = require('../middleware/programIsolation')
const { upload } = require('../middleware/upload')
const { uploadToStorage } = require('../services/storage.service')
const { ingestDocument } = require('../services/ai.service')
const { auditLog } = require('../services/audit.service')

const router = express.Router()

// GET /api/v1/kb/programs/:pid — list KB docs
router.get('/programs/:pid', verifyJWT, programIsolation, async (req, res, next) => {
  try {
    const docs = await prisma.knowledgeBaseDoc.findMany({
      where: { program_id: req.programId },
      include: {
        uploader: { select: { full_name: true } },
        _count: { select: { chunks: true } },
      },
      orderBy: { created_at: 'desc' },
    })
    res.json(docs)
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/kb/programs/:pid — upload + embed
router.post(
  '/programs/:pid',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

      const path = `kb/${req.programId}/${Date.now()}-${req.file.originalname}`
      const url = await uploadToStorage('kb-docs', path, req.file.buffer, req.file.mimetype)

      const doc = await prisma.knowledgeBaseDoc.create({
        data: {
          program_id: req.programId,
          uploaded_by: req.user.id,
          filename: req.file.originalname,
          storage_url: url,
          file_size: req.file.size,
          mime_type: req.file.mimetype,
        },
      })

      // Trigger embedding in background
      ingestDocument({
        docId: doc.id,
        programId: req.programId,
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
      }).catch((e) => console.error('[KB ingest error]', e))

      auditLog({
        action: 'KB_DOC_UPLOADED',
        userId: req.user.id,
        programId: req.programId,
        resourceType: 'kb_doc',
        resourceId: doc.id,
        metadata: { filename: doc.filename, size: doc.file_size },
        req,
      })

      res.status(201).json(doc)
    } catch (err) {
      next(err)
    }
  }
)

// DELETE /api/v1/kb/programs/:pid/:docId
router.delete(
  '/programs/:pid/:docId',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      const doc = await prisma.knowledgeBaseDoc.findFirst({
        where: { id: req.params.docId, program_id: req.programId },
      })
      if (!doc) return res.status(404).json({ error: 'Not found' })

      // Delete chunks via raw SQL (since embedding is unsupported in Prisma)
      await prisma.$executeRawUnsafe(
        `DELETE FROM "knowledge_base_chunks" WHERE doc_id = $1`,
        doc.id
      )
      await prisma.knowledgeBaseDoc.delete({ where: { id: doc.id } })

      auditLog({
        action: 'KB_DOC_DELETED',
        userId: req.user.id,
        programId: req.programId,
        resourceType: 'kb_doc',
        resourceId: doc.id,
        metadata: { filename: doc.filename },
        req,
      })

      res.json({ ok: true })
    } catch (err) {
      next(err)
    }
  }
)

// POST /api/v1/kb/programs/:pid/:docId/reindex — wipe chunks + re-embed
router.post(
  '/programs/:pid/:docId/reindex',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      const doc = await prisma.knowledgeBaseDoc.findFirst({
        where: { id: req.params.docId, program_id: req.programId },
      })
      if (!doc) return res.status(404).json({ error: 'Not found' })

      // Wipe existing chunks
      await prisma.$executeRawUnsafe(
        `DELETE FROM "knowledge_base_chunks" WHERE doc_id = $1`,
        doc.id
      )
      await prisma.knowledgeBaseDoc.update({
        where: { id: doc.id },
        data: { embedded_at: null },
      })

      // Re-download original file from storage public URL
      const resp = await fetch(doc.storage_url)
      if (!resp.ok) {
        return res.status(500).json({ error: `Failed to fetch source file (${resp.status})` })
      }
      const buffer = Buffer.from(await resp.arrayBuffer())

      // Trigger embedding in background
      ingestDocument({
        docId: doc.id,
        programId: req.programId,
        buffer,
        mimeType: doc.mime_type || 'application/octet-stream',
      }).catch((e) => console.error('[KB reindex error]', e))

      auditLog({
        action: 'KB_DOC_REINDEXED',
        userId: req.user.id,
        programId: req.programId,
        resourceType: 'kb_doc',
        resourceId: doc.id,
        req,
      })

      res.json({ ok: true, message: 'Reindex queued' })
    } catch (err) {
      next(err)
    }
  }
)

module.exports = router
