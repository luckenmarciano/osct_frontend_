const express = require('express')
const { z } = require('zod')
const prisma = require('../lib/prisma')
const { verifyJWT, requireRole } = require('../middleware/auth')
const { programIsolation } = require('../middleware/programIsolation')
const { upload } = require('../middleware/upload')
const { uploadToStorage, deleteFromStorage } = require('../services/storage.service')

const router = express.Router()

// GET /api/v1/videos/programs/:pid — list videos in a program
router.get('/programs/:pid', verifyJWT, programIsolation, async (req, res, next) => {
  try {
    const videos = await prisma.video.findMany({
      where: { lesson: { module: { course: { program_id: req.programId } } } },
      include: {
        lesson: {
          select: {
            id: true,
            title: true,
            module: {
              select: {
                id: true,
                title: true,
                order_index: true,
                course: { select: { id: true, title: true } },
              },
            },
          },
        },
      },
      orderBy: { created_at: 'desc' },
    })
    res.json(videos)
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/videos/programs/:pid/lessons/:lessonId/upload — upload a video for a lesson
router.post(
  '/programs/:pid/lessons/:lessonId/upload',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
      if (!req.file.mimetype.startsWith('video/')) {
        return res.status(400).json({ error: 'File must be a video' })
      }

      const { title, durationSec } = z
        .object({
          title: z.string().min(1).optional(),
          durationSec: z.coerce.number().int().min(0).optional(),
        })
        .parse(req.body)

      const lesson = await prisma.lesson.findUnique({
        where: { id: req.params.lessonId },
        include: { module: { include: { course: true } }, video: true },
      })
      if (!lesson || lesson.module.course.program_id !== req.programId) {
        return res.status(404).json({ error: 'Lesson not found in this program' })
      }

      const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')
      const path = `videos/${req.programId}/${lesson.id}/${Date.now()}-${safeName}`
      const url = await uploadToStorage('videos', path, req.file.buffer, req.file.mimetype)

      const videoTitle = title || req.file.originalname.replace(/\.[^/.]+$/, '')

      let video
      if (lesson.video) {
        if (lesson.video.storage_path) {
          await deleteFromStorage('videos', lesson.video.storage_path).catch(() => {})
        }
        video = await prisma.video.update({
          where: { id: lesson.video.id },
          data: {
            title: videoTitle,
            hls_url: url,
            storage_path: path,
            duration_sec: durationSec ?? lesson.video.duration_sec,
          },
        })
      } else {
        video = await prisma.video.create({
          data: {
            lesson_id: lesson.id,
            title: videoTitle,
            hls_url: url,
            storage_path: path,
            duration_sec: durationSec,
          },
        })
      }

      res.status(201).json(video)
    } catch (err) {
      next(err)
    }
  }
)

// DELETE /api/v1/videos/programs/:pid/:videoId
router.delete(
  '/programs/:pid/:videoId',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      const video = await prisma.video.findUnique({
        where: { id: req.params.videoId },
        include: { lesson: { include: { module: { include: { course: true } } } } },
      })
      if (!video || video.lesson.module.course.program_id !== req.programId) {
        return res.status(404).json({ error: 'Video not found in this program' })
      }
      if (video.storage_path) {
        await deleteFromStorage('videos', video.storage_path).catch(() => {})
      }
      await prisma.video.delete({ where: { id: video.id } })
      res.json({ ok: true })
    } catch (err) {
      next(err)
    }
  }
)

// GET /api/v1/videos/:id
router.get('/:id', verifyJWT, async (req, res, next) => {
  try {
    const video = await prisma.video.findUnique({
      where: { id: req.params.id },
      include: { lesson: { include: { module: { include: { course: true } } } } },
    })
    if (!video) return res.status(404).json({ error: 'Video not found' })

    const programId = video.lesson.module.course.program_id
    if (req.user.role !== 'SUPER_ADMIN' && !req.user.programIds.includes(programId)) {
      return res.status(403).json({ error: 'Access denied' })
    }
    res.json(video)
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/videos/programs/:pid/:videoId/watch — update watch progress
router.post(
  '/programs/:pid/:videoId/watch',
  verifyJWT,
  programIsolation,
  async (req, res, next) => {
    try {
      const { watchPct, completed } = z
        .object({
          watchPct: z.number().min(0).max(100),
          completed: z.boolean().default(false),
        })
        .parse(req.body)

      const session = await prisma.videoWatchSession.upsert({
        where: {
          user_id_video_id_program_id: {
            user_id: req.user.id,
            video_id: req.params.videoId,
            program_id: req.programId,
          },
        },
        update: { watch_pct: watchPct, completed, last_watched_at: new Date() },
        create: {
          user_id: req.user.id,
          video_id: req.params.videoId,
          program_id: req.programId,
          watch_pct: watchPct,
          completed,
        },
      })
      res.json(session)
    } catch (err) {
      next(err)
    }
  }
)

// POST /api/v1/videos/programs/:pid/:videoId/bookmark
router.post(
  '/programs/:pid/:videoId/bookmark',
  verifyJWT,
  programIsolation,
  async (req, res, next) => {
    try {
      const { timestampSec, note } = z
        .object({
          timestampSec: z.number().int().min(0),
          note: z.string().optional(),
        })
        .parse(req.body)

      const bookmark = await prisma.videoBookmark.create({
        data: {
          user_id: req.user.id,
          video_id: req.params.videoId,
          program_id: req.programId,
          timestamp_sec: timestampSec,
          note,
        },
      })
      res.status(201).json(bookmark)
    } catch (err) {
      next(err)
    }
  }
)

module.exports = router
