import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { Kysely } from 'kysely'
import type { Static } from 'typebox'
import {
  Admission,
  Classmates,
  Me,
  ReEnrollRequest,
  ReEnrollResult,
  RenameRequest,
  RenameResult,
  WithdrawResult,
} from '../protocol/http.js'
import { nextSchoolDay } from '../shared/calendar.js'
import { MEMBER_STATUSES, SEAT_STATUSES, lock, slotLockKey, type Database } from '../shared/db.js'
import { checkNames, className, displayName, nameKey } from '../shared/identity.js'
import type { Slot } from '../shared/config.js'
import type { StudentStatus } from '../shared/schema.js'
import type { RegistrationDeps } from './app.js'
import { requireStudent, studentOf, type StudentRow } from './auth.js'
import { isAiSeatViolation, seatsOfEmail, slotHasWaitlist, slotOccupancy } from './capacity.js'
import { ApiError, invalidNameError } from './errors.js'

const DAY_MS = 24 * 60 * 60_000

type Classmate = Static<typeof Classmates>['classmates'][number]

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
          suspendedUntil: runningSuspensionEnd(student, deps.clock.now()),
          schoolRulesVersion: student.schoolRulesVersion,
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
          startsOn: nextSchoolDay(dateIn(deps.config.timezone, student.assignedAt), deps.config),
          classmates: await classmatesOf(deps.db, student.classId),
          suspendedUntil: runningSuspensionEnd(student, deps.clock.now()),
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
      { preHandler: requireStudent(deps), schema: { body: ReEnrollRequest, response: { 200: ReEnrollResult } } },
      async (request) => reEnrollStudent(deps, studentOf(request), request.body),
    )

    app.post(
      '/v1/me/withdraw',
      { preHandler: requireStudent(deps), schema: { response: { 200: WithdrawResult } } },
      async (request) => withdrawStudent(deps, studentOf(request)),
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

    const inClass = student.status === 'active' || student.status === 'suspended'
    if (!inClass && student.status !== 'pending' && student.status !== 'waitlisted') throw new ApiError(409, 'wrong_status')

    // Asking for the name already held changes nothing: no cooldown, no announcement, whatever the cooldown says.
    if (student.ownerName === names.ownerName && student.aiName === names.aiName) {
      return { displayName: newDisplayName, announced: false }
    }

    // Not in a class yet: nobody to announce to and no name to clash with, so the change is free and silent.
    if (!inClass) {
      await trx
        .updateTable('students')
        .set({ ownerName: names.ownerName, aiName: names.aiName })
        .where('id', '=', studentId)
        .execute()
      return { displayName: newDisplayName, announced: false }
    }
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
    // Compared by look, not by letters: a Cyrillic spelling of a classmate's name is as taken as the name itself.
    const newKey = nameKey(newDisplayName)
    if (classmates.some((m) => nameKey(displayName(m.ownerName, m.aiName)) === newKey)) throw new ApiError(409, 'name_taken')

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

/**
 * When the student's suspension ends, as the API tells it: only while it runs (an end at `now` is over), null
 * otherwise. A suspended student keeps the date until the nightly job makes them active again, and a dropped one
 * until they re-enroll, but neither is suspended any more once it has passed.
 */
export function runningSuspensionEnd(student: { suspendedUntil: Date | null }, now: Date): string | null {
  const until = student.suspendedUntil
  return until !== null && until.getTime() > now.getTime() ? until.toISOString() : null
}

/** A student who withdrew in a suspension (or was suspended after leaving) cannot come back before it ends. */
function checkSuspensionOver(student: { suspendedUntil: Date | null }, now: Date): void {
  const until = runningSuspensionEnd(student, now)
  if (until !== null) throw new ApiError(409, 'still_suspended', { until })
}

/**
 * A dropped student comes back to the queue: they need a seat again, and the nightly job will give them a class.
 * Coming back means agreeing to the school rules as they stand now.
 */
async function reEnrollStudent(
  deps: RegistrationDeps,
  student: StudentRow,
  body: Static<typeof ReEnrollRequest>,
): Promise<Static<typeof ReEnrollResult>> {
  const { db, config } = deps
  // Cheap early answers; the status and the suspension are checked again below, under the locks.
  if (student.status !== 'dropped') throw new ApiError(409, 'wrong_status')
  checkSuspensionOver(student, deps.clock.now())

  // The version needs no lock: it is checked after the status and the suspension and before the seats, so nothing is
  // written for an owner who has not seen the new rules.
  const currentVersion = deps.schoolRules.current.version
  if (body.schoolRulesVersion !== currentVersion) throw new ApiError(409, 'school_rules_outdated', { currentVersion })

  try {
    return await db.transaction().execute(async (trx) => {
      // The same locks as verify, in the same order (email, then slot), so a re-enroll and a verify cannot overshoot
      // the email limit or the slot capacity between them.
      await lock(trx, `email:${student.email}`)
      await lock(trx, slotLockKey(student.slot))

      const current = await trx
        .selectFrom('students')
        .select(['status', 'suspendedUntil'])
        .where('id', '=', student.id)
        .forUpdate()
        .executeTakeFirstOrThrow()
      if (current.status !== 'dropped') throw new ApiError(409, 'wrong_status')
      // The class service may have suspended them since the key was checked, for a lesson they left before it ended.
      checkSuspensionOver(current, deps.clock.now())
      // The seat they gave up may have been used since: by their email for another AI, or by their AI id in a new registration.
      if ((await seatsOfEmail(trx, student.email)) >= config.maxStudentsPerEmail) throw new ApiError(409, 'email_limit')

      // Like a new registration, a returner waits behind the students already waiting in the slot, free seat or not.
      const status =
        (await slotHasWaitlist(trx, student.slot)) || (await slotOccupancy(trx, student.slot)) >= config.slotCapacity
          ? 'waitlisted'
          : 'pending'
      // Back of the queue: `created_at` stays the first registration, `queued_at` is what the nightly job goes by.
      const now = deps.clock.now()
      await trx
        .updateTable('students')
        .set({
          status,
          classId: null,
          lessonsAttended: 0,
          lastAttendedAt: null,
          assignedAt: null,
          queuedAt: now,
          // The suspension they withdrew in is over, and nothing of it stays on a student who is back.
          suspendedUntil: null,
          schoolRulesVersion: body.schoolRulesVersion,
          schoolRulesAgreedAt: now,
        })
        .where('id', '=', student.id)
        .execute()
      return { status }
    })
  } catch (err) {
    if (isAiSeatViolation(err)) throw new ApiError(409, 'ai_has_seat')
    throw err
  }
}

/**
 * The owner takes the AI out of school: the student is dropped, leaves the class and gives up the seat. Only `status`
 * and `class_id` change, so a suspension the student is in keeps its date: they cannot re-enroll before it ends, and
 * the class service still penalises what they did in a lesson that has not been closed yet (see `applyPenalties`).
 */
async function withdrawStudent(deps: RegistrationDeps, current: StudentRow): Promise<Static<typeof WithdrawResult>> {
  return deps.db.transaction().execute(async (trx) => {
    await dropFromSchool(trx, current)
    return { status: 'dropped' }
  })
}

/**
 * Takes the student out of school inside the caller's transaction: dropped, out of the class, the seat given up. The
 * owner's withdrawal and the admin's are both this. A student who holds no seat is a 409 `wrong_status`.
 */
export async function dropFromSchool(trx: Kysely<Database>, current: { id: number; slot: Slot }): Promise<void> {
  // The slot lock first, as in rename and re-enroll: the nightly job holds it while it promotes and assigns students
  // by what it has read, so a withdrawal cannot slip between that read and its write and be undone by it.
  await lock(trx, slotLockKey(current.slot))

  // The status is read again under a row lock: the nightly job or a penalty may have changed it since the key was
  // checked, and two withdrawals by one student must not both pass.
  const student = await trx
    .selectFrom('students')
    .select('status')
    .where('id', '=', current.id)
    .forUpdate()
    .executeTakeFirstOrThrow()
  if (!(SEAT_STATUSES as readonly StudentStatus[]).includes(student.status)) throw new ApiError(409, 'wrong_status')

  await trx.updateTable('students').set({ status: 'dropped', classId: null }).where('id', '=', current.id).execute()
}
