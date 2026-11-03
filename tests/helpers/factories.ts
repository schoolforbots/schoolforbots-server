import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Division, Slot } from '../../src/shared/config.js'
import type { Database, LessonSegment, SessionKind, SessionMember, StudentStatus } from '../../src/shared/schema.js'
import { generateStudentKey, hashSecret } from '../../src/shared/secrets.js'

let studentCounter = 0

export async function insertClass(
  db: Kysely<Database>,
  p: { division?: Division; slot?: Slot; classNo: number; teacherPersonaId?: string },
): Promise<number> {
  const row = await db
    .insertInto('classes')
    .values({
      division: p.division ?? 'junior',
      slot: p.slot ?? 'evening',
      classNo: p.classNo,
      teacherPersonaId: p.teacherPersonaId ?? 'lao-zhou',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

/** Inserts a student with unique default names and returns its id and the raw key (only the hash is stored). */
export async function insertStudent(
  db: Kysely<Database>,
  p: Partial<{
    email: string
    ownerName: string
    aiName: string
    division: Division
    slot: Slot
    status: StudentStatus
    classId: number | null
    aiId: string
    createdAt: Date
    /** Defaults to `createdAt`, as for a student who has never re-enrolled. */
    queuedAt: Date
    assignedAt: Date | null
    lastAttendedAt: Date | null
    lastRenamedAt: Date | null
    /** Until when a suspended student stays out of class. */
    suspendedUntil: Date | null
    /** The version of the school rules the student last agreed to. Null by default: a student from before the school asked. */
    schoolRulesVersion: string | null
    /** When the student agreed to it. */
    schoolRulesAgreedAt: Date | null
  }> = {},
): Promise<{ id: number; key: string }> {
  const n = ++studentCounter
  const key = generateStudentKey()
  const createdAt = p.createdAt ?? new Date()
  const row = await db
    .insertInto('students')
    .values({
      email: p.email ?? `s${n}@example.com`,
      ownerName: p.ownerName ?? `主人${n}`,
      aiName: p.aiName ?? `小鱼${n}`,
      division: p.division ?? 'junior',
      slot: p.slot ?? 'evening',
      status: p.status ?? 'pending',
      classId: p.classId ?? null,
      aiId: p.aiId ?? randomUUID(),
      pluginType: 'test',
      pluginVersion: '0.0.0',
      keyHash: hashSecret(key),
      registrationIp: '127.0.0.1',
      createdAt,
      queuedAt: p.queuedAt ?? createdAt,
      assignedAt: p.assignedAt ?? null,
      lastAttendedAt: p.lastAttendedAt ?? null,
      lastRenamedAt: p.lastRenamedAt ?? null,
      suspendedUntil: p.suspendedUntil ?? null,
      schoolRulesVersion: p.schoolRulesVersion ?? null,
      schoolRulesAgreedAt: p.schoolRulesAgreedAt ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { id: row.id, key }
}

let lessonCounter = 0

/**
 * Inserts a lesson and returns its id. By default it is a junior-division lesson, already approved, with five
 * placeholder segments (the number `config.lesson.segmentMinutes` has by default).
 */
export async function insertLesson(
  db: Kysely<Database>,
  p: {
    /** The school day, `YYYY-MM-DD`. */
    date: string
    division?: Division
    title?: string
    segments?: LessonSegment[]
    /** Defaults to a moment on the lesson's day; pass `null` for a draft that is not yet approved. */
    approvedAt?: Date | null
    subject?: string
  },
): Promise<number> {
  const n = ++lessonCounter
  const row = await db
    .insertInto('lessons')
    .values({
      date: p.date,
      division: p.division ?? 'junior',
      subject: p.subject ?? '科学',
      title: p.title ?? `第${n}课`,
      segments: JSON.stringify(
        p.segments ??
          Array.from({ length: 5 }, (_, i) => ({ text: `第${n}课第${i + 1}段正文`, gist: `第${i + 1}段要点` })),
      ),
      approvedAt: p.approvedAt === undefined ? new Date(`${p.date}T00:00:00Z`) : p.approvedAt,
      createdAt: new Date(`${p.date}T00:00:00Z`),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

/** Inserts a class session and returns its id. By default: an evening lesson session with no members or lesson. */
export async function insertSession(
  db: Kysely<Database>,
  p: {
    classId: number
    /** The school day, `YYYY-MM-DD`. */
    date: string
    slot?: Slot
    kind?: SessionKind
    lessonId?: number | null
    startsAt: Date
    endsAt: Date
    members?: SessionMember[]
  },
): Promise<number> {
  const row = await db
    .insertInto('classSessions')
    .values({
      classId: p.classId,
      date: p.date,
      slot: p.slot ?? 'evening',
      kind: p.kind ?? 'lesson',
      lessonId: p.lessonId ?? null,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      members: JSON.stringify(p.members ?? []),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}
