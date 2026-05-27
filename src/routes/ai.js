const express = require('express')
const { z } = require('zod')
const prisma = require('../lib/prisma')
const { verifyJWT, requireRole } = require('../middleware/auth')
const { programIsolation } = require('../middleware/programIsolation')
const { ragChat } = require('../services/ai.service')

const router = express.Router()

// POST /api/v1/ai/programs/:pid/chat
router.post('/programs/:pid/chat', verifyJWT, programIsolation, async (req, res, next) => {
  try {
    const { message, conversationId } = z
      .object({
        message: z.string().min(1),
        conversationId: z.string().nullable().optional(),
      })
      .parse(req.body)

    let conv
    if (conversationId) {
      conv = await prisma.aIConversation.findFirst({
        where: { id: conversationId, user_id: req.user.id, program_id: req.programId },
      })
      if (!conv) return res.status(404).json({ error: 'Conversation not found' })
    } else {
      conv = await prisma.aIConversation.create({
        data: {
          user_id: req.user.id,
          program_id: req.programId,
          title: message.slice(0, 60),
        },
      })
    }

    // Save user message
    await prisma.aIMessage.create({
      data: { conversation_id: conv.id, role: 'USER', content: message },
    })

    // Get prior history (last 10)
    const history = await prisma.aIMessage.findMany({
      where: { conversation_id: conv.id },
      orderBy: { created_at: 'asc' },
      take: 20,
    })

    const { answer, sources } = await ragChat({
      programId: req.programId,
      query: message,
      history: history.map((h) => ({
        role: h.role === 'USER' ? 'user' : 'assistant',
        content: h.content,
      })),
    })

    const aiMsg = await prisma.aIMessage.create({
      data: {
        conversation_id: conv.id,
        role: 'ASSISTANT',
        content: answer,
        sources,
      },
    })

    res.json({
      conversationId: conv.id,
      messageId: aiMsg.id,
      answer,
      sources,
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/ai/programs/:pid/conversations
router.get(
  '/programs/:pid/conversations',
  verifyJWT,
  programIsolation,
  async (req, res, next) => {
    try {
      const convs = await prisma.aIConversation.findMany({
        where: { user_id: req.user.id, program_id: req.programId },
        orderBy: { created_at: 'desc' },
        include: { _count: { select: { messages: true } } },
        take: 50,
      })
      res.json(convs)
    } catch (err) {
      next(err)
    }
  }
)

// GET /api/v1/ai/conversations/:id/messages
router.get('/conversations/:id/messages', verifyJWT, async (req, res, next) => {
  try {
    const conv = await prisma.aIConversation.findUnique({ where: { id: req.params.id } })
    if (!conv || conv.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Not found' })
    }
    const messages = await prisma.aIMessage.findMany({
      where: { conversation_id: req.params.id },
      orderBy: { created_at: 'asc' },
    })
    res.json(messages)
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/ai/programs/:pid/feedback-analytics — FR-26
// Admin/trainer view: aggregate feedback data to surface which AI answers are
// loved/hated and which KB documents drive good vs. bad responses.
router.get(
  '/programs/:pid/feedback-analytics',
  verifyJWT,
  requireRole('SUPER_ADMIN', 'PROGRAM_ADMIN', 'TRAINER'),
  programIsolation,
  async (req, res, next) => {
    try {
      const [conversations, ratedMessages, allAssistantMessages] = await Promise.all([
        prisma.aIConversation.count({ where: { program_id: req.programId } }),
        prisma.aIMessage.findMany({
          where: {
            role: 'ASSISTANT',
            feedback: { not: null },
            conversation: { program_id: req.programId },
          },
          select: {
            id: true,
            content: true,
            sources: true,
            feedback: true,
            feedback_at: true,
          },
          orderBy: { feedback_at: 'desc' },
          take: 200,
        }),
        prisma.aIMessage.count({
          where: { role: 'ASSISTANT', conversation: { program_id: req.programId } },
        }),
      ])

      const upMessages   = ratedMessages.filter((m) => m.feedback === 'UP')
      const downMessages = ratedMessages.filter((m) => m.feedback === 'DOWN')

      // Aggregate doc citations from UP-rated messages
      const docCounts = {}
      for (const msg of upMessages) {
        const sources = Array.isArray(msg.sources) ? msg.sources : []
        for (const s of sources) {
          const key = s.doc_id || s.filename || 'unknown'
          if (!docCounts[key]) docCounts[key] = { doc_id: s.doc_id, filename: s.filename, upCited: 0, totalCited: 0 }
          docCounts[key].upCited++
        }
      }
      // Also count from all rated messages for totalCited
      for (const msg of ratedMessages) {
        const sources = Array.isArray(msg.sources) ? msg.sources : []
        for (const s of sources) {
          const key = s.doc_id || s.filename || 'unknown'
          if (!docCounts[key]) docCounts[key] = { doc_id: s.doc_id, filename: s.filename, upCited: 0, totalCited: 0 }
          docCounts[key].totalCited++
        }
      }
      const topDocs = Object.values(docCounts)
        .sort((a, b) => b.upCited - a.upCited)
        .slice(0, 10)

      res.json({
        summary: {
          totalConversations: conversations,
          totalAssistantMessages: allAssistantMessages,
          upVotes: upMessages.length,
          downVotes: downMessages.length,
          ratedPct: allAssistantMessages > 0
            ? Math.round((ratedMessages.length / allAssistantMessages) * 100)
            : 0,
        },
        topAnswers:  upMessages.slice(0, 5).map((m) => ({
          id: m.id,
          content: m.content.slice(0, 300),
          sources: Array.isArray(m.sources) ? m.sources.slice(0, 3) : [],
          feedback_at: m.feedback_at,
        })),
        lowAnswers: downMessages.slice(0, 5).map((m) => ({
          id: m.id,
          content: m.content.slice(0, 300),
          sources: Array.isArray(m.sources) ? m.sources.slice(0, 3) : [],
          feedback_at: m.feedback_at,
        })),
        topDocs,
      })
    } catch (err) {
      next(err)
    }
  }
)

// POST /api/v1/ai/messages/:id/feedback — thumbs up/down on an assistant reply
router.post('/messages/:id/feedback', verifyJWT, async (req, res, next) => {
  try {
    const { feedback } = z
      .object({ feedback: z.enum(['UP', 'DOWN']).nullable() })
      .parse(req.body)

    const msg = await prisma.aIMessage.findUnique({
      where: { id: req.params.id },
      include: { conversation: true },
    })
    if (!msg) return res.status(404).json({ error: 'Message not found' })
    if (msg.conversation.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Not your conversation' })
    }
    if (msg.role !== 'ASSISTANT') {
      return res.status(400).json({ error: 'Can only rate assistant replies' })
    }

    const updated = await prisma.aIMessage.update({
      where: { id: msg.id },
      data: {
        feedback,
        feedback_at: feedback ? new Date() : null,
      },
      select: { id: true, feedback: true, feedback_at: true },
    })
    res.json(updated)
  } catch (err) {
    next(err)
  }
})

module.exports = router
