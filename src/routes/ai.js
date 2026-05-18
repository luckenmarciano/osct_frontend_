const express = require('express')
const { z } = require('zod')
const prisma = require('../lib/prisma')
const { verifyJWT } = require('../middleware/auth')
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

module.exports = router
