import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import type { Static } from 'typebox'
import { Admission, Classmates, Me, ReEnrollResult, RenameRequest, RenameResult } from '../protocol/http.js'
import { MEMBER_STATUSES, lock, slotLockKey, type Database } from '../shared/db.js'
import { checkNames, className, displayName } from '../shared/identity.js'
import type { RegistrationDeps } from './app.js'
import { requireStudent, type StudentRow } from './auth.js'
import { isInstallSeatViolation, seatsOfEmail, slotOccupancy } from './capacity.js'
import { ApiError, invalidNameError } from './errors.js'

const DAY_MS = 24 * 60 * 60_000

type Classmate = Static<typeof Classmates>['classmates'][number]

/** The student `requireStudent` resolved the key to. */
function studentOf(request: FastifyRequest): StudentRow {
  if (request.student === undefined) throw new ApiError(401, 'unauthorized') // requireStudent always sets it
  return request.student
}

/** A moment as a `YYYY-MM-DD` date in the given timezone (the en-CA locale writes dates in that order). */
function dateIn(timeZone: string, moment: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(moment)
}

export function meRoutes(deps: RegistrationDeps): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      '/v1/me',
      { preHandler: requireStudent(deps), schema: { response: { 200: Me } } },
      async (request) => {
        const student = studentOf(request)

        let assignedClass: string | null = null
        if (student.classId !== null) {
          const row = await deps.db
            .selectFrom('classes')
            .select(['division', 'slot', 'classNo'])
            .where('id', '=', student.classId)
            .executeTakeFirstOrThrow()
          assignedClass = className(row.division, row.slot, row.classNo, deps.config)
        }

        return {
          studentId: student.id,
          ownerName: student.ownerName,
          aiName: student.aiName,
          displayName: displayName(student.ownerName, student.aiName),
          division: student.division,
          slot: student.slot,
          status: student.status,
          className: assignedClass,
          lastRenamedAt: student.lastRenamedAt?.toISOString() ?? null,
        }
      },
    )

    app.get(
      '/v1/me/admission',
      { preHandler: requireStudent(deps), schema: { response: { 200: Admission } } },
      async (request) => {
        const student = studentOf(request)
        if (student.classId === null || student.assignedAt === null) throw new ApiError(409, 'not_assigned')

        const row = await classRow(deps.db, student.classId)
        // A teacher the config no longer lists still gets a name: the id is all that is left of them.
        const teacher = deps.config.teacherPersonas.find((p) => p.id === row.teacherPersonaId)

        return {
          studentId: student.id,
          displayName: displayName(student.ownerName, student.aiName),
          division: student.division,
          slot: student.slot,
          classNo: row.classNo,
          className: className(row.division, row.slot, row.classNo, deps.config),
          teacher: { name: teacher?.name ?? row.teacherPersonaId },
          startsOn: dateIn(deps.config.timezone, student.assignedAt),
          classmates: await classmatesOf(deps.db, student.classId),
        }
      },
    )

    app.get(
      '/v1/me/classmates',
      { preHandler: requireStudent(deps), schema: { response: { 200: Classmates } } },
      async (request) => {
        const student = studentOf(request)
        if (student.classId === null) throw new ApiError(409, 'not_assigned')

        const row = await classRow(deps.db, student.classId)
        return {
          className: className(row.division, row.slot, row.classNo, deps.config),
          classmates: await classmatesOf(deps.db, student.classId),
        }
      },
    )

    app.patch(
      '/v1/me/name',
      { preHandler: requireStudent(deps), schema: { body: RenameRequest, response: { 200: RenameResult } } },
      async (request) => renameStudent(deps, studentOf(request), request.body),
    )

    app.post(
      '/v1/me/re-enroll',
      { preHandler: requireStudent(deps), schema: { response: { 200: ReEnrollResult } } },
      async (request) => reEnrollStudent(deps, studentOf(request)),
    )
  }
}

function classRow(db: Kysely<Database>, classId: number) {
  return db
    .selectFrom('classes')
    .select(['division', 'slot', 'classNo', 'teacherPersonaId'])
    .where('id', '=', classId)
    .executeTakeFirstOrThrow()
}

/** The members of a class, the asking student included, by student number. */
async function classmatesOf(db: Kysely<Database>, classId: number): Promise<Classmate[]> {
  const members = await db
    .selectFrom('students')
    .select(['id', 'ownerName', 'aiName'])
    .where('classId', '=', classId)
    .where('status', 'in', [...MEMBER_STATUSES])
    .orderBy('id')
    .execute()
  return members.map((m) => ({ studentId: m.id, displayName: displayName(m.ownerName, m.aiName) }))
}

async function renameStudent(
  deps: RegistrationDeps,
  current: StudentRow,
  body: Static<typeof RenameRequest>,
): Promise<Static<typeof RenameResult>> {
  const { db, config, moderator, clock } = deps
  const studentId = current.id

  const names = checkNames(body.ownerName, body.aiName, { maxChars: config.nameMaxChars, moderator })
  if (!names.ok) throw invalidNameError(names)
  const newDisplayName = displayName(names.ownerName, names.aiName)
  const now = clock.now()

  return db.transaction().execute(async (trx) => {
    // The slot lock comes first (a student's slot never changes). The nightly job holds it while it reads the names
    // in each class and places newcomers by them, so a rename cannot slip a clashing name in between. Lock order is
    // slot, then student row, then class row, the same as re-enroll's slot, then student row.
    await lock(trx, slotLockKey(current.slot))

    // The student is read again under a row lock. The nightly job may have admitted or dropped them since the key
    // was checked, and two renames by one student must not both pass the cooldown.
    const student = await trx
      .selectFrom('students')
      .selectAll()
      .where('id', '=', studentId)
      .forUpdate()
      .executeTakeFirstOrThrow()

    // Not in a class yet: nobody to announce to and no name to clash with, so the change is free and silent.
    if (student.status === 'pending' || student.status === 'waitlisted') {
      await trx
        .updateTable('students')
        .set({ ownerName: names.ownerName, aiName: names.aiName })
        .where('id', '=', studentId)
        .execute()
      return { displayName: newDisplayName, announced: false }
    }
    if (student.status !== 'active' && student.status !== 'suspended') throw new ApiError(409, 'wrong_status')
    if (student.classId === null) throw new ApiError(409, 'not_assigned')
    const classId = student.classId

    // The class row is locked before the name check and held until commit, so two renames in one class cannot both
    // find the name free.
    await trx.selectFrom('classes').select('id').where('id', '=', classId).forUpdate().executeTakeFirstOrThrow()

    if (student.lastRenamedAt !== null) {
      const allowedAt = new Date(student.lastRenamedAt.getTime() + config.renameCooldownDays * DAY_MS)
      if (now.getTime() < allowedAt.getTime()) {
        throw new ApiError(409, 'rename_cooldown', { retryAfter: dateIn(config.timezone, allowedAt) })
      }
    }

    const classmates = await trx
      .selectFrom('students')
      .select(['ownerName', 'aiName'])
      .where('classId', '=', classId)
      .where('id', '!=', studentId)
      .where('status', 'in', [...MEMBER_STATUSES])
      .execute()
    if (classmates.some((m) => displayName(m.ownerName, m.aiName) === newDisplayName)) throw new ApiError(409, 'name_taken')

    await trx
      .updateTable('students')
      .set({ ownerName: names.ownerName, aiName: names.aiName, lastRenamedAt: now })
      .where('id', '=', studentId)
      .execute()
    // Left unannounced for the class service (phase 2) to pick up.
    await trx
      .insertInto('renameEvents')
      .values({
        studentId,
        classId,
        oldDisplayName: displayName(student.ownerName, student.aiName),
        newDisplayName,
        createdAt: now,
        announcedAt: null,
      })
      .execute()
    return { displayName: newDisplayName, announced: true }
  })
}

/** A dropped student comes back to the queue: they need a seat again, and the nightly job will give them a class. */
async function reEnrollStudent(deps: RegistrationDeps, student: StudentRow): Promise<Static<typeof ReEnrollResult>> {
  const { db, config } = deps
  // Cheap early answer; the status is checked again below, under the locks.
  if (student.status !== 'dropped') throw new ApiError(409, 'wrong_status')

  try {
    return await db.transaction().execute(async (trx) => {
      // The same locks as verify, in the same order (email, then slot), so a re-enroll and a verify cannot overshoot
      // the email limit or the slot capacity between them.
      await lock(trx, `email:${student.email}`)
      await lock(trx, slotLockKey(student.slot))

      const current = await trx
        .selectFrom('students')
        .select('status')
        .where('id', '=', student.id)
        .forUpdate()
        .executeTakeFirstOrThrow()
      if (current.status !== 'dropped') throw new ApiError(409, 'wrong_status')
      // The seat they gave up may have been used since: by their email for another AI, or by their install for a new one.
      if ((await seatsOfEmail(trx, student.email)) >= config.maxStudentsPerEmail) throw new ApiError(409, 'email_limit')

      const status = (await slotOccupancy(trx, student.slot)) >= config.slotCapacity ? 'waitlisted' : 'pending'
      // Back of the queue: `created_at` stays the first registration, `queued_at` is what the nightly job goes by.
      await trx
        .updateTable('students')
        .set({
          status,
          classId: null,
          lessonsAttended: 0,
          lastAttendedAt: null,
          assignedAt: null,
          queuedAt: deps.clock.now(),
        })
        .where('id', '=', student.id)
        .execute()
      return { status }
    })
  } catch (err) {
    if (isInstallSeatViolation(err)) throw new ApiError(409, 'install_has_seat')
    throw err
  }
}
