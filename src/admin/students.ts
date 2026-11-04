import { TypeBoxValidatorCompiler, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { FastifyPluginAsync } from 'fastify'
import type { Kysely } from 'kysely'
import { Type } from 'typebox'
import { lockStudentsOfAiIds, suspendAiStudents } from '../class/discipline.js'
import { liftPenalty } from '../discipline/revoke.js'
import { ApiError } from '../registration/errors.js'
import { dropFromSchool } from '../registration/me.js'
import { className } from '../shared/identity.js'
import { recordText } from '../shared/record-text.js'
import type { Database, DisciplineKind, MessageKind, MessageModeration, StudentStatus } from '../shared/schema.js'
import type { AdminDeps } from './app.js'

// Looking up a student, and the penalties the admin gives by hand: suspend, withdraw, lift. Every one is written as a
// discipline record with `detail.by = 'admin'`, which the owner reads in the school record ("老师手动...") and which
// the rule exclusions leave alone (a penalty the breaks did not earn is not theirs to take back). The log names the
// student's number and the action, never a name, address or line.

const DAY_MS = 24 * 60 * 60_000
/** The longest a suspension can be given for by hand. */
export const MAX_SUSPEND_DAYS = 365
const DEFAULT_MESSAGE_LIMIT = 50
const MAX_MESSAGE_LIMIT = 50

const NOT_FOUND = new ApiError(404, 'not_found')
const NOTHING_TO_LIFT = '这个学生现在没有处罚可以解除。'
const EXPELLED = '被开除的学生不能再停课，要先解除处罚。'

export interface StudentView {
  id: number
  ownerName: string
  aiName: string
  email: string
  aiId: string
  status: StudentStatus
  classId: number | null
  /** Null when the student is in no class. */
  className: string | null
  /** The end of the suspension the student row holds, as stored; it may be past (the nightly job clears it). */
  suspendedUntil: string | null
  registeredAt: string
  registrationIp: string
  schoolRulesVersion: string | null
  lessonsAttended: number
  lastAttendedAt: string | null
}

export interface MessageView {
  id: number
  kind: MessageKind
  text: string
  moderation: MessageModeration | null
  matchedTerm: string | null
  delivered: boolean
  ip: string | null
  pluginType: string
  pluginVersion: string
  createdAt: string
  sessionId: number
}

export interface RecordView {
  id: number
  kind: DisciplineKind
  at: string
  /** The words the owner reads for the record. */
  text: string
  revoked: boolean
  revokedAt: string | null
  sessionId: number | null
  matchedTerm: string | null
  /** 'admin' for what the admin did by hand, null for what the school did. */
  by: 'admin' | null
}

/** A student number in the path: plain digits that fit the column, else the student cannot exist. */
function studentIdOf(params: unknown): number {
  const { id } = params as { id: string }
  if (!/^[0-9]{1,9}$/.test(id)) throw NOT_FOUND
  return Number(id)
}

/** A whole number in plain digits from `min` to `max`; `fallback` when the parameter is missing; else a 400. */
function wholeNumber(text: string | undefined, p: { fallback: number; min: number; max: number }): number {
  if (text === undefined) return p.fallback
  const n = /^[0-9]{1,9}$/.test(text) ? Number(text) : NaN
  if (!(n >= p.min && n <= p.max)) throw new ApiError(400, 'invalid_request')
  return n
}

export function studentRoutes(deps: AdminDeps): FastifyPluginAsync {
  const { db, config, clock } = deps

  async function studentView(id: number, from: Kysely<Database> = db): Promise<StudentView> {
    const s = await from.selectFrom('students').selectAll().where('id', '=', id).executeTakeFirst()
    if (s === undefined) throw NOT_FOUND
    let name: string | null = null
    if (s.classId !== null) {
      const c = await from
        .selectFrom('classes')
        .select(['division', 'slot', 'classNo'])
        .where('id', '=', s.classId)
        .executeTakeFirst()
      if (c !== undefined) name = className(c.division, c.slot, c.classNo, config)
    }
    return {
      id: s.id,
      ownerName: s.ownerName,
      aiName: s.aiName,
      email: s.email,
      aiId: s.aiId,
      status: s.status,
      classId: s.classId,
      className: name,
      suspendedUntil: s.suspendedUntil?.toISOString() ?? null,
      registeredAt: s.createdAt.toISOString(),
      registrationIp: s.registrationIp,
      schoolRulesVersion: s.schoolRulesVersion,
      lessonsAttended: s.lessonsAttended,
      lastAttendedAt: s.lastAttendedAt?.toISOString() ?? null,
    }
  }

  const exists = async (id: number) => {
    const row = await db.selectFrom('students').select('id').where('id', '=', id).executeTakeFirst()
    if (row === undefined) throw NOT_FOUND
  }

  return async (instance) => {
    const app = instance.withTypeProvider<TypeBoxTypeProvider>()
    app.setValidatorCompiler(TypeBoxValidatorCompiler)

    app.get('/students/:id', async (request): Promise<StudentView> => studentView(studentIdOf(request.params)))

    app.get(
      '/students/:id/messages',
      { schema: { querystring: Type.Object({ before: Type.Optional(Type.String()), limit: Type.Optional(Type.String()) }) } },
      async (request): Promise<{ messages: MessageView[]; nextBefore: number | null }> => {
        const id = studentIdOf(request.params)
        await exists(id)
        const limit = wholeNumber(request.query.limit, { fallback: DEFAULT_MESSAGE_LIMIT, min: 1, max: MAX_MESSAGE_LIMIT })
        const before = request.query.before === undefined ? null : wholeNumber(request.query.before, { fallback: 0, min: 0, max: 2_147_483_647 })
        // One more than asked for tells whether there is a next page.
        const rows = await db
          .selectFrom('messages')
          .select(['id', 'kind', 'text', 'moderation', 'matchedTerm', 'delivered', 'ip', 'pluginType', 'pluginVersion', 'createdAt', 'sessionId'])
          .where('senderId', '=', id)
          .$if(before !== null, (qb) => qb.where('id', '<', before!))
          .orderBy('id', 'desc')
          .limit(limit + 1)
          .execute()
        const page = rows.slice(0, limit)
        return {
          messages: page.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
          nextBefore: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
        }
      },
    )

    app.get('/students/:id/records', async (request): Promise<{ records: RecordView[] }> => {
      const id = studentIdOf(request.params)
      await exists(id)
      const rows = await db
        .selectFrom('disciplineRecords')
        .select(['id', 'kind', 'detail', 'matchedTerm', 'sessionId', 'createdAt', 'revokedAt'])
        .where('studentId', '=', id)
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .execute()
      return {
        records: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          at: r.createdAt.toISOString(),
          text: recordText(r, config.timezone),
          revoked: r.revokedAt !== null,
          revokedAt: r.revokedAt?.toISOString() ?? null,
          sessionId: r.sessionId,
          matchedTerm: r.matchedTerm,
          by: r.detail.by === 'admin' ? 'admin' : null,
        })),
      }
    })

    // `days` is read by hand: a value the schema turned away would be a 400, and the admin should be told what is wrong.
    app.post(
      '/students/:id/suspend',
      { schema: { body: Type.Object({ days: Type.Optional(Type.Unknown()) }, { additionalProperties: false }) } },
      async (request): Promise<StudentView> => {
        const id = studentIdOf(request.params)
        const { days } = request.body
        if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_SUSPEND_DAYS) {
          throw new ApiError(422, 'invalid_request', {}, `停课天数要是 1 到 ${MAX_SUSPEND_DAYS} 之间的整数。`)
        }
        // Checked first: the lock below reads the AI ids of the students it is given and has none for an unknown one.
        await exists(id)
        const now = clock.now()
        const until = new Date(now.getTime() + days * DAY_MS)
        const view = await db.transaction().execute(async (trx) => {
          const students = await lockStudentsOfAiIds(trx, [id])
          const student = students.get(id)
          if (student === undefined) throw NOT_FOUND
          if (student.status === 'expelled') throw new ApiError(409, 'wrong_status', {}, EXPELLED)
          // As after class: every student of the AI id who is not expelled (a lesson under way is not interrupted; the
          // next connection is refused).
          const reached = [...students.values()].filter((s) => s.status !== 'expelled')
          await suspendAiStudents(trx, reached, until)
          const alsoApplied = reached.filter((s) => s.aiId === student.aiId && s.id !== id).map((s) => s.id)
          await recordByAdmin(trx, id, 'suspension', now, { until: until.toISOString(), alsoApplied, days })
          return studentView(id, trx)
        })
        request.log.info({ studentId: id, action: 'suspend', days }, 'admin penalty')
        return view
      },
    )

    app.post('/students/:id/withdraw', async (request): Promise<StudentView> => {
      const id = studentIdOf(request.params)
      const view = await db.transaction().execute(async (trx) => {
        const student = await trx.selectFrom('students').select(['id', 'slot']).where('id', '=', id).executeTakeFirst()
        if (student === undefined) throw NOT_FOUND
        await dropFromSchool(trx, student)
        await recordByAdmin(trx, id, 'withdrawal', clock.now(), {})
        return studentView(id, trx)
      })
      request.log.info({ studentId: id, action: 'withdraw' }, 'admin penalty')
      return view
    })

    app.post('/students/:id/lift', async (request): Promise<StudentView> => {
      const id = studentIdOf(request.params)
      const now = clock.now()
      const view = await db.transaction().execute(async (trx) => {
        await exists(id)
        const outcome = await liftPenalty(trx, config, id, now)
        // Only this student's breaks: a penalty that reached them from an AI-id sibling is lifted for the whole AI id,
        // but the sibling's own breaks are theirs to have taken back (lift them from the sibling's page).
        // The breaks of the window are taken back with the penalty, so the next break does not add up to it again.
        const { numUpdatedRows } = await trx
          .updateTable('disciplineRecords')
          .set({ revokedAt: now })
          .where('studentId', '=', id)
          .where('kind', '=', 'school_rule')
          .where('revokedAt', 'is', null)
          .where('createdAt', '>=', new Date(now.getTime() - config.revocationWindowDays * DAY_MS))
          .executeTakeFirstOrThrow()
        const revokedBreaks = Number(numUpdatedRows)
        if (outcome === 'none' && revokedBreaks === 0) throw new ApiError(409, 'wrong_status', {}, NOTHING_TO_LIFT)
        await recordByAdmin(trx, id, 'penalty_lift', now, { outcome, revokedBreaks })
        return studentView(id, trx)
      })
      request.log.info({ studentId: id, action: 'lift' }, 'admin penalty')
      return view
    })
  }
}

/** The record of what the admin did by hand, on the student it was done to. */
async function recordByAdmin(
  trx: Kysely<Database>,
  studentId: number,
  kind: DisciplineKind,
  at: Date,
  detail: Record<string, unknown>,
): Promise<void> {
  await trx
    .insertInto('disciplineRecords')
    .values({ studentId, sessionId: null, kind, detail: JSON.stringify({ ...detail, by: 'admin' }), matchedTerm: null, createdAt: at, revokedAt: null })
    .execute()
}
