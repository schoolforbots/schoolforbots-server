import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Division, Slot } from '../../src/shared/config.js'
import type { Database, StudentStatus } from '../../src/shared/schema.js'
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
    installId: string
    createdAt: Date
    /** Defaults to `createdAt`, as for a student who has never re-enrolled. */
    queuedAt: Date
    assignedAt: Date | null
    lastAttendedAt: Date | null
    lastRenamedAt: Date | null
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
      installId: p.installId ?? randomUUID(),
      pluginType: 'test',
      pluginVersion: '0.0.0',
      keyHash: hashSecret(key),
      registrationIp: '127.0.0.1',
      createdAt,
      queuedAt: p.queuedAt ?? createdAt,
      assignedAt: p.assignedAt ?? null,
      lastAttendedAt: p.lastAttendedAt ?? null,
      lastRenamedAt: p.lastRenamedAt ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { id: row.id, key }
}
