import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { appendClassEvent, classEventMessage, eventsAfter, NOOP } from '../../src/class/events.js'
import type { Database } from '../../src/shared/schema.js'
import { createTestDb } from '../helpers/db.js'
import { insertClass, insertSession } from '../helpers/factories.js'

let db: Kysely<Database>
let destroy: () => Promise<void>

beforeEach(async () => {
  ;({ db, destroy } = await createTestDb())
})

afterEach(async () => {
  await destroy()
})

const AT = new Date('2026-11-02T20:00:00+08:00')

async function newSession(classNo = 1): Promise<number> {
  const classId = await insertClass(db, { classNo })
  return insertSession(db, {
    classId,
    date: '2026-11-02',
    startsAt: AT,
    endsAt: new Date(AT.getTime() + 30 * 60_000),
  })
}

const append = (sessionId: number, step: string, kind = 'teacher', payload: object = { kind, text: step }) =>
  db.transaction().execute((trx) => appendClassEvent(trx, { sessionId, step, kind, payload, at: AT }))

describe('appendClassEvent', () => {
  test('numbers the events of a session from 1 and writes a step only once', async () => {
    const sessionId = await newSession()
    expect(await append(sessionId, 'opening')).toEqual({ seq: 1 })
    expect(await append(sessionId, 'segment-1')).toEqual({ seq: 2 })
    expect(await append(sessionId, 'opening')).toBeNull()
    expect(await append(sessionId, 'segment-2')).toEqual({ seq: 3 })

    const rows = await db.selectFrom('classEvents').select(['seq', 'step']).orderBy('seq').execute()
    expect(rows).toEqual([
      { seq: 1, step: 'opening' },
      { seq: 2, step: 'segment-1' },
      { seq: 3, step: 'segment-2' },
    ])
  })

  test('numbers every session on its own', async () => {
    const a = await newSession(1)
    const b = await newSession(2)
    expect(await append(a, 'opening')).toEqual({ seq: 1 })
    expect(await append(b, 'opening')).toEqual({ seq: 1 })
    expect(await append(a, 'segment-1')).toEqual({ seq: 2 })
  })

  test('numbers a noop marker below zero, so the events the class sees stay 1, 2, 3', async () => {
    const sessionId = await newSession()
    expect(await append(sessionId, 'opening')).toEqual({ seq: 1 })
    expect(await append(sessionId, 'callouts-1', NOOP, {})).toEqual({ seq: -1 })
    expect(await append(sessionId, 'segment-2')).toEqual({ seq: 2 })
    expect(await append(sessionId, 'call-on', NOOP, {})).toEqual({ seq: -2 })
    expect(await append(sessionId, 'callouts-1', NOOP, {})).toBeNull()
    expect(await append(sessionId, 'segment-3')).toEqual({ seq: 3 })
  })

  test('a noop marker comes first and the first event the class sees is still 1', async () => {
    const sessionId = await newSession()
    expect(await append(sessionId, 'callouts-1', NOOP, {})).toEqual({ seq: -1 })
    expect(await append(sessionId, 'opening')).toEqual({ seq: 1 })
  })

  test('writers at the same moment take turns and get consecutive numbers', async () => {
    const sessionId = await newSession()
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => append(sessionId, `step-${i}`)),
    )
    expect(results.map((r) => r?.seq).sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  test('two writers of the same step at the same moment write it once', async () => {
    const sessionId = await newSession()
    const results = await Promise.all([append(sessionId, 'opening'), append(sessionId, 'opening')])
    expect(results.filter((r) => r !== null)).toEqual([{ seq: 1 }])
    expect(await db.selectFrom('classEvents').select('seq').execute()).toHaveLength(1)
  })
})

describe('eventsAfter', () => {
  test('returns the events after lastSeq in order, without the noop markers', async () => {
    const sessionId = await newSession()
    await append(sessionId, 'opening', 'teacher', { kind: 'teacher', text: '同学们好' })
    await append(sessionId, 'callouts-1', NOOP, {})
    await append(sessionId, 'segment-1', 'segment', { kind: 'segment', index: 1, text: '正文' })
    await append(sessionId, 'dismissal', 'dismissal', { kind: 'dismissal' })

    const all = await eventsAfter(db, sessionId, 0)
    expect(all).toEqual([
      { seq: 1, step: 'opening', kind: 'teacher', payload: { kind: 'teacher', text: '同学们好' }, at: AT },
      { seq: 2, step: 'segment-1', kind: 'segment', payload: { kind: 'segment', index: 1, text: '正文' }, at: AT },
      { seq: 3, step: 'dismissal', kind: 'dismissal', payload: { kind: 'dismissal' }, at: AT },
    ])
    expect((await eventsAfter(db, sessionId, 2)).map((e) => e.seq)).toEqual([3])
    expect(await eventsAfter(db, sessionId, 3)).toEqual([])
  })

  test('only reads the session asked for', async () => {
    const a = await newSession(1)
    const b = await newSession(2)
    await append(a, 'opening')
    expect(await eventsAfter(db, b, 0)).toEqual([])
  })
})

describe('classEventMessage', () => {
  test('is the class.event message for a stored event', () => {
    const message = classEventMessage(
      { seq: 4, step: 'segment-2', kind: 'segment', payload: { kind: 'segment', index: 2, text: '正文' }, at: AT },
      true,
    )
    expect(message).toEqual({
      type: 'class.event',
      seq: 4,
      replayed: true,
      at: '2026-11-02T12:00:00.000Z',
      event: { kind: 'segment', index: 2, text: '正文' },
    })
  })
})
