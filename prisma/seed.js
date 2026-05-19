/* eslint-disable no-console */
const { PrismaClient } = require('@prisma/client')
const bcrypt = require('bcryptjs')

const prisma = new PrismaClient()

const PROGRAMS = [
  {
    code: 'oprc-1',
    name: 'OPRC Level 1',
    level: 1,
    color_theme: '#EA580C', // orange-600
    icon: 'shield',
    description:
      'Pelatihan tingkat operator lapangan, kru, dan staf terminal. Fokus: dasar peralatan, keselamatan, respons awal.',
  },
  {
    code: 'oprc-2',
    name: 'OPRC Level 2',
    level: 2,
    color_theme: '#0891B2', // cyan-600
    icon: 'compass',
    description:
      'Pelatihan tingkat supervisor, perwira kapal, koordinator. Fokus: manajemen insiden (ICS), strategi respons, koordinasi.',
  },
  {
    code: 'oprc-3',
    name: 'OPRC Level 3',
    level: 3,
    color_theme: '#1E3A8A', // navy
    icon: 'anchor',
    description:
      'Pelatihan tingkat manajemen senior, regulator, pembuat kebijakan. Fokus: kebijakan nasional, perencanaan kontingensi, aspek hukum/finansial.',
  },
]

async function main() {
  console.log('Seeding database...')

  // 1. Programs
  const programs = {}
  for (const p of PROGRAMS) {
    const program = await prisma.oPRCProgram.upsert({
      where: { code: p.code },
      update: p,
      create: p,
    })
    programs[p.code] = program
    console.log(`  ✓ Program: ${p.code}`)
  }

  // 2. Users
  const passwordHash = await bcrypt.hash('password123', 10)

  const superAdmin = await prisma.user.upsert({
    where: { email: 'admin@osct.id' },
    update: {},
    create: {
      email: 'admin@osct.id',
      password_hash: passwordHash,
      full_name: 'Super Admin',
      role: 'SUPER_ADMIN',
    },
  })
  console.log('  ✓ User: super admin')

  const trainer = await prisma.user.upsert({
    where: { email: 'trainer@osct.id' },
    update: {},
    create: {
      email: 'trainer@osct.id',
      password_hash: passwordHash,
      full_name: 'Pak Trainer',
      role: 'TRAINER',
    },
  })

  const participant = await prisma.user.upsert({
    where: { email: 'peserta@osct.id' },
    update: {},
    create: {
      email: 'peserta@osct.id',
      password_hash: passwordHash,
      full_name: 'Bu Peserta',
      role: 'PARTICIPANT',
    },
  })

  // 3. Trainer assigned to all 3 programs
  for (const code of ['oprc-1', 'oprc-2', 'oprc-3']) {
    await prisma.programTrainer.upsert({
      where: {
        user_id_program_id: { user_id: trainer.id, program_id: programs[code].id },
      },
      update: {},
      create: { user_id: trainer.id, program_id: programs[code].id },
    })
  }
  console.log('  ✓ Trainer assigned to all programs')

  // 4. Participant enrolled in OPRC Level 1
  await prisma.programEnrollment.upsert({
    where: {
      user_id_program_id: { user_id: participant.id, program_id: programs['oprc-1'].id },
    },
    update: {},
    create: {
      user_id: participant.id,
      program_id: programs['oprc-1'].id,
      pretest_score: 65,
      attendance_pct: 90,
    },
  })
  console.log('  ✓ Participant enrolled in oprc-1')

  // 5. Sample course for each program — idempotent by (program_id, title)
  for (const code of ['oprc-1', 'oprc-2', 'oprc-3']) {
    const title = `${programs[code].name} — Pengantar`
    const existing = await prisma.course.findFirst({
      where: { program_id: programs[code].id, title },
      select: { id: true },
    })
    if (existing) {
      await prisma.course.update({
        where: { id: existing.id },
        data: { status: 'PUBLISHED', is_published: true, quota: 30 },
      })
      console.log(`  ✓ Course already present for ${code}: ${title}`)
      continue
    }
    const course = await prisma.course.create({
      data: {
        program_id: programs[code].id,
        title,
        description: `Modul pengantar untuk ${programs[code].name}`,
        order_index: 0,
        status: 'PUBLISHED',
        is_published: true,
        quota: 30,
        modules: {
          create: [
            {
              title: 'Modul 1: Dasar Tumpahan Minyak',
              order_index: 0,
              lessons: {
                create: [
                  {
                    title: 'Pengenalan & Dampak Lingkungan',
                    type: 'VIDEO',
                    order_index: 0,
                  },
                  {
                    title: 'Quiz Modul 1',
                    type: 'QUIZ',
                    order_index: 1,
                  },
                ],
              },
            },
            {
              title: 'Modul 2: Strategi Respons',
              order_index: 1,
              lessons: {
                create: [
                  {
                    title: 'Teknik Containment',
                    type: 'VIDEO',
                    order_index: 0,
                  },
                ],
              },
            },
          ],
        },
      },
    })
    console.log(`  ✓ Course seeded for ${code}: ${course.title}`)
  }

  // 6. Pretest + Posttest per program with sample questions
  for (const code of ['oprc-1', 'oprc-2', 'oprc-3']) {
    for (const type of ['PRETEST', 'POSTTEST']) {
      await prisma.courseTest.upsert({
        where: { program_id_type: { program_id: programs[code].id, type } },
        update: {},
        create: {
          program_id: programs[code].id,
          type,
          title: `${programs[code].name} — ${type === 'PRETEST' ? 'Pretest' : 'Posttest'}`,
          time_limit: 30,
          questions: {
            create: [
              {
                body: 'Apa kepanjangan dari OPRC?',
                type: 'MCQ',
                options: [
                  { key: 'A', text: 'Oil Pollution Preparedness Response and Co-operation' },
                  { key: 'B', text: 'Oil Production Recovery Council' },
                  { key: 'C', text: 'Ocean Protection Research Center' },
                  { key: 'D', text: 'Offshore Pipeline Response Code' },
                ],
                correct_answer: 'A',
                points: 1,
                order_index: 0,
              },
              {
                body: 'Peralatan utama untuk membatasi penyebaran tumpahan minyak?',
                type: 'MCQ',
                options: [
                  { key: 'A', text: 'Skimmer' },
                  { key: 'B', text: 'Boom' },
                  { key: 'C', text: 'Dispersant' },
                  { key: 'D', text: 'Sorbent' },
                ],
                correct_answer: 'B',
                points: 1,
                order_index: 1,
              },
              {
                body: 'Jelaskan singkat 3 fase respons tumpahan minyak.',
                type: 'ESSAY',
                points: 3,
                order_index: 2,
              },
            ],
          },
        },
      })
    }
  }
  console.log('  ✓ Pretest + Posttest seeded for all programs')

  console.log('\nSeed completed.')
  console.log('Login credentials (password: password123):')
  console.log('  • admin@osct.id      (SUPER_ADMIN)')
  console.log('  • trainer@osct.id    (TRAINER, all programs)')
  console.log('  • peserta@osct.id    (PARTICIPANT, oprc-1)')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
