const prisma = require('../lib/prisma')

const ATTENDANCE_THRESHOLD = 80
const POSTTEST_THRESHOLD = 70

/**
 * Recompute attendance_pct for a user in a program, then update cert_eligible.
 * Attendance is counted against sessions whose scheduled_at <= now (past sessions).
 */
async function recomputeAttendancePct({ userId, programId }) {
  const now = new Date()
  const [totalPast, attended, enrollment] = await Promise.all([
    prisma.session.count({
      where: { program_id: programId, scheduled_at: { lte: now } },
    }),
    prisma.attendance.count({
      where: { user_id: userId, program_id: programId },
    }),
    prisma.programEnrollment.findUnique({
      where: { user_id_program_id: { user_id: userId, program_id: programId } },
    }),
  ])

  if (!enrollment) return { attendancePct: 0, certEligible: false }

  const pct = totalPast > 0 ? (attended / totalPast) * 100 : 0
  const eligible =
    pct >= ATTENDANCE_THRESHOLD &&
    (enrollment.posttest_score ?? 0) >= POSTTEST_THRESHOLD

  await prisma.programEnrollment.update({
    where: { id: enrollment.id },
    data: { attendance_pct: pct, cert_eligible: eligible },
  })

  return { attendancePct: pct, certEligible: eligible }
}

/**
 * Returns true if every lesson in the program is marked completed by the user.
 * Used to gate posttest availability.
 */
async function isProgramLearningComplete({ userId, programId }) {
  const totalLessons = await prisma.lesson.count({
    where: { module: { course: { program_id: programId } } },
  })
  if (totalLessons === 0) return false
  const completedCount = await prisma.lessonProgress.count({
    where: { user_id: userId, program_id: programId, completed: true },
  })
  return completedCount >= totalLessons
}

/**
 * Returns the user's lesson-completion progress across an entire program.
 * Used by the participant dashboard (FR-10.2).
 */
async function getProgramProgress({ userId, programId }) {
  const totalLessons = await prisma.lesson.count({
    where: { module: { course: { program_id: programId } } },
  })
  const completedLessons = await prisma.lessonProgress.count({
    where: { user_id: userId, program_id: programId, completed: true },
  })
  const pct = totalLessons > 0 ? (completedLessons / totalLessons) * 100 : 0
  return { totalLessons, completedLessons, pct }
}

module.exports = {
  ATTENDANCE_THRESHOLD,
  POSTTEST_THRESHOLD,
  recomputeAttendancePct,
  isProgramLearningComplete,
  getProgramProgress,
}
