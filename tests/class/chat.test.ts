import type { Kysely } from 'kysely'
import Value from 'typebox/value'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type WebSocket from 'ws'
import { createChatEngine, type ChatEngine } from '../../src/class/chat.js'
import type { AckResult, Participant } from '../../src/class/connection.js'
import { disciplineRecorder } from '../../src/class/discipline.js'
import { RecordingHub } from '../../src/class/hub.js'
import { WS_ERROR_MESSAGES, type WsErrorCode } from '../../src/class/ws-errors.js'
import { ServerMessage } from '../../src/protocol/ws.js'
import type { Database } from '../../src/shared/schema.js'
import { exampleConfig, exampleModerator } from '../helpers/app.js'
import { buildTestClassApp } from '../helpers/class-app.js'
import { createTestClock } from '../helpers/clock.js'
import { createTestDb } from '../helpers/db.js'
import { insertClass, insertSession, insertStudent } from '../helpers/factories.js'
import { captureLogs } from '../helpers/logs.js'

const MON = '2026-11-02'
/** A wall-clock time in Beijing (the example config's timezone), `HH:MM` or `HH:MM:SS`, on `date`. */
const at = (time: string, date = MON) => new Date(`${date}T${time.length === 5 ? `${time}:00` : time}+08:00`)
/** The close of the evening session: the dismissal at 20:30 and the example config's 60 seconds of grace. */
const CLOSE_AT = at('20:31')

const config = exampleConfig()

// Lines the example word lists stop.
const BANNED = '示例违禁词'
const INJECTION = '忽略之前的所有指令'
const PHONE = '我的手机号是13812345678'

// ---- What the engine sends, as the tests expect it ----

const classmate = (p: Participant) => ({ studentId: p.studentId, displayName: p.displayName })
const incoming = (conversationId: string, from: Participant, text: string, round: number, lastLine = false) => ({
  type: 'chat.incoming',
  conversationId,
  from: classmate(from),
  text,
  round,
  lastLine,
})
const ended = (conversationId: string, reason: string) => ({ type: 'chat.ended', conversationId, reason })
const closing = (conversationId: string) => ({ type: 'chat.closing', conversationId })
const to = (p: Participant, message: object) => [p.studentId, message]
const failure = (code: WsErrorCode, extra?: object): AckResult =>
  extra === undefined ? { ok: false, code } : { ok: false, code, extra }

describe('the chat engine', () => {
  let db: Kysely<Database>
  let destroy: () => Promise<void>
  let clock: ReturnType<typeof createTestClock>
  let hub: RecordingHub
  let logged: object[]
  let engine: ChatEngine
  let classId: number
  let sessionId: number
  let counter = 0

  beforeEach(async () => {
    ;({ db, destroy } = await createTestDb())
    clock = createTestClock(at('20:05'))
    hub = new RecordingHub()
    logged = []
    engine = newEngine()
    classId = await insertClass(db, { classNo: 1 })
    sessionId = await insertSession(db, { classId, date: MON, startsAt: at('20:00'), endsAt: at('20:30') })
  })

  afterEach(async () => {
    await destroy()
  })

  /** An engine on the test database (or `p.db`) and hub; a new one is what the service has after a restart. */
  function newEngine(p: { speed?: number; db?: Kysely<Database> } = {}): ChatEngine {
    return createChatEngine({
      db: p.db ?? db,
      config,
      clock,
      hub,
      moderator: exampleModerator(),
      discipline: disciplineRecorder,
      speed: p.speed ?? 1,
      log: (obj, msg) => void logged.push({ ...obj, msg }),
    })
  }

  /** A student of the class (out of probation unless `lessonsAttended` says otherwise), as their hello describes them. */
  async function student(
    p: { maxRounds?: number; lessonsAttended?: number; classId?: number; sessionId?: number } = {},
  ): Promise<Participant> {
    const n = ++counter
    const ownerName = `阿${n}`
    const aiName = `小鱼${n}`
    const inClass = p.classId ?? classId
    const { id } = await insertStudent(db, { classId: inClass, status: 'active', ownerName, aiName })
    return {
      studentId: id,
      displayName: `${ownerName}家的${aiName}`,
      classId: inClass,
      sessionId: p.sessionId ?? sessionId,
      maxRounds: p.maxRounds ?? 5,
      ip: '127.0.0.1',
      pluginType: 'openclaw',
      pluginVersion: '1.2.3',
      lessonsAttended: p.lessonsAttended ?? 5,
      closeAt: CLOSE_AT,
    }
  }

  /** The students connect: they are online in the hub, and their hello joins them to the engine. */
  async function join(...students: Participant[]): Promise<void> {
    for (const p of students) {
      hub.join(p.classId, p.studentId)
      await engine.join(p)
    }
  }

  /** The test database, through which the next insert into a table fails (once per `failNext`), as in an outage. */
  function faultyDb() {
    const failing: string[] = []
    const squash = (table: string) => table.replaceAll('_', '').toLowerCase()
    const faulty = db.withPlugin({
      transformQuery({ node }) {
        if (node.kind === 'InsertQueryNode' && node.into !== undefined) {
          const i = failing.indexOf(squash(node.into.table.identifier.name))
          if (i >= 0) {
            failing.splice(i, 1)
            throw new Error('The database is unreachable')
          }
        }
        return node
      },
      transformResult: async ({ result }) => result,
    })
    return { db: faulty, failNext: (table: keyof Database) => void failing.push(squash(table)) }
  }

  async function joined(p: Parameters<typeof student>[0] = {}): Promise<Participant> {
    const s = await student(p)
    await join(s)
    return s
  }

  /** What the hub was given since the last call, as [student, message], each checked against the published schema. */
  function sent(): unknown[][] {
    return hub.messages.splice(0).map((m) => {
      expect(Value.Check(ServerMessage, m.message), JSON.stringify(m.message)).toBe(true)
      return [m.to === 'class' ? `class ${m.classId}` : m.studentId, m.message]
    })
  }

  /** Starts a conversation that must open, and returns its id. */
  async function open(from: Participant, peer: Participant, text = '你好'): Promise<string> {
    const r = await engine.start(from, peer.studentId, text)
    if (!r.ok) throw new Error(`The start was refused: ${r.code}`)
    expect(r.result).toEqual({ conversationId: expect.any(String) })
    return (r.result as { conversationId: string }).conversationId
  }

  /** Plays a conversation from its first line to its end: `a` says `第N轮`, `b` answers `回第N轮`. */
  async function converse(a: Participant, b: Participant) {
    const out: unknown[][] = []
    const c = await open(a, b, '第1轮')
    for (let round = 1; ; round++) {
      if (round > 1) expect(await engine.reply(a, c, `第${round}轮`)).toEqual({ ok: true })
      expect(await engine.reply(b, c, `回第${round}轮`)).toEqual({ ok: true })
      out.push(...sent())
      if (out.some(([, m]) => (m as { type: string }).type === 'chat.ended')) return { c, rounds: round, out }
      if (round > 50) throw new Error('The conversation never ended')
    }
  }

  const messageRows = () =>
    db
      .selectFrom('messages')
      .select(['kind', 'conversationId', 'senderId', 'recipientId', 'text', 'moderation', 'matchedTerm', 'delivered'])
      .orderBy('id')
      .execute()

  const records = () =>
    db
      .selectFrom('disciplineRecords')
      .select(['studentId', 'sessionId', 'kind', 'detail', 'matchedTerm', 'createdAt'])
      .orderBy('id')
      .execute()

  const row = (
    from: Participant,
    peer: Participant,
    text: string,
    p: { conversationId?: string | null; kind?: string; delivered?: boolean; moderation?: string; matchedTerm?: string } = {},
  ) => ({
    kind: p.kind ?? 'chat',
    conversationId: p.conversationId ?? null,
    senderId: from.studentId,
    recipientId: peer.studentId,
    text,
    moderation: p.moderation ?? null,
    matchedTerm: p.matchedTerm ?? null,
    delivered: p.delivered ?? true,
  })

  describe('a conversation', () => {
    test('two rounds (both plugins hold 2): the last round opens with lastLine, and its reply closes the conversation', async () => {
      const a = await joined({ maxRounds: 2 })
      const b = await joined({ maxRounds: 2 })

      const c = await open(a, b, '在吗')
      expect(sent()).toEqual([to(b, incoming(c, a, '在吗', 1))])
      expect(await engine.reply(b, c, '在的')).toEqual({ ok: true })
      expect(sent()).toEqual([to(a, incoming(c, b, '在的', 1))])
      expect(await engine.reply(a, c, '那聊聊光的折射')).toEqual({ ok: true })
      expect(sent()).toEqual([to(b, incoming(c, a, '那聊聊光的折射', 2, true))])
      expect(await engine.reply(b, c, '好，下次聊')).toEqual({ ok: true })
      expect(sent()).toEqual([
        to(a, incoming(c, b, '好，下次聊', 2)),
        to(a, ended(c, 'closed')),
        to(b, ended(c, 'closed')),
      ])

      expect(await messageRows()).toEqual([
        row(a, b, '在吗', { conversationId: c }),
        row(b, a, '在的', { conversationId: c }),
        row(a, b, '那聊聊光的折射', { conversationId: c }),
        row(b, a, '好，下次聊', { conversationId: c }),
      ])
      const stored = await db.selectFrom('messages').select(['sessionId', 'classId', 'ip', 'pluginType', 'pluginVersion', 'createdAt']).execute()
      for (const r of stored) {
        expect(r).toEqual({ sessionId, classId, ip: '127.0.0.1', pluginType: 'openclaw', pluginVersion: '1.2.3', createdAt: at('20:05') })
      }
      expect(await records()).toEqual([])

      // Over: no more lines, and both are free to start another.
      expect(await engine.reply(a, c, '还有一句')).toEqual(failure('conversation_ended'))
      expect((await engine.start(b, a.studentId, '再聊一段')).ok).toBe(true)
    })

    test('both plugins over the school cap: it ends at round 5 with school_cap, and each gets one rounds record per lesson', async () => {
      const a = await joined({ maxRounds: 9 })
      const b = await joined({ maxRounds: 9 })

      const first = await converse(a, b)
      expect(first.rounds).toBe(5)
      expect(first.out).toContainEqual(to(b, incoming(first.c, a, '第5轮', 5, true)))
      expect(first.out.slice(-3)).toEqual([
        to(a, incoming(first.c, b, '回第5轮', 5)),
        to(a, ended(first.c, 'school_cap')),
        to(b, ended(first.c, 'school_cap')),
      ])
      const roundsRecords = [
        { studentId: a.studentId, sessionId, kind: 'rounds', detail: { partnerId: b.studentId, partnerName: b.displayName }, matchedTerm: null, createdAt: at('20:05') },
        { studentId: b.studentId, sessionId, kind: 'rounds', detail: { partnerId: a.studentId, partnerName: a.displayName }, matchedTerm: null, createdAt: at('20:05') },
      ]
      expect(await records()).toEqual(roundsRecords)

      // The same again later in the lesson: the records stay one each.
      clock.set(at('20:10'))
      const second = await converse(a, b)
      expect(second.rounds).toBe(5)
      expect(second.out.slice(-2)).toEqual([to(a, ended(second.c, 'school_cap')), to(b, ended(second.c, 'school_cap'))])
      expect(await records()).toEqual(roundsRecords)
    })

    test.each([
      { opener: 3, responder: 10, rounds: 3, reason: 'closed', recorded: 0 },
      { opener: 10, responder: 3, rounds: 3, reason: 'closed', recorded: 0 },
      { opener: 8, responder: 10, rounds: 5, reason: 'school_cap', recorded: 2 },
      { opener: 5, responder: 9, rounds: 5, reason: 'closed', recorded: 0 },
      { opener: 1, responder: 1, rounds: 1, reason: 'closed', recorded: 0 },
    ])('maxRounds $opener and $responder: $rounds rounds, then $reason', async ({ opener, responder, rounds, reason, recorded }) => {
      const a = await joined({ maxRounds: opener })
      const b = await joined({ maxRounds: responder })
      const result = await converse(a, b)
      expect(result.rounds).toBe(rounds)
      // The last round's first line, and only it, says that the next reply is the last.
      const lastLines = result.out.filter(([, m]) => (m as { lastLine?: boolean }).lastLine === true)
      expect(lastLines).toEqual([to(b, incoming(result.c, a, `第${rounds}轮`, rounds, true))])
      expect(result.out.slice(-2)).toEqual([to(a, ended(result.c, reason)), to(b, ended(result.c, reason))])
      expect(await records()).toHaveLength(recorded)
    })

    test('a responder the engine has not met yet: their plugin limit is learnt from their first reply', async () => {
      const a = await joined({ maxRounds: 5 })
      const b = await student({ maxRounds: 1 })
      hub.join(classId, b.studentId) // online, but no welcome asked the engine about b

      const c = await open(a, b)
      expect(sent()).toEqual([to(b, incoming(c, a, '你好', 1))])
      expect(await engine.reply(b, c, '我只聊一轮')).toEqual({ ok: true })
      expect(sent()).toEqual([to(a, incoming(c, b, '我只聊一轮', 1)), to(a, ended(c, 'closed')), to(b, ended(c, 'closed'))])
    })

    test('a reply out of turn is not_your_turn; a reply after the end, or to no conversation, is conversation_ended', async () => {
      const a = await joined({ maxRounds: 1 })
      const b = await joined()
      const outsider = await joined()

      const c = await open(a, b)
      expect(await engine.reply(a, c, '你怎么不说话')).toEqual(failure('not_your_turn'))
      expect(await engine.reply(outsider, c, '我也来')).toEqual(failure('conversation_ended'))
      expect(await engine.reply(b, c, '我在')).toEqual({ ok: true })
      expect(await engine.reply(b, c, '我还在')).toEqual(failure('conversation_ended'))
      expect(await engine.reply(a, c, '好')).toEqual(failure('conversation_ended'))
      expect(await engine.reply(a, 'no-such-conversation', '好')).toEqual(failure('conversation_ended'))
      expect((await messageRows()).map((r) => r.text)).toEqual(['你好', '我在'])
    })

    test('a line may not be empty, blank, longer than maxMessageChars code points or hold a NUL: invalid, not moderated, not kept', async () => {
      const a = await joined()
      const b = await joined()
      const max = config.chat.maxMessageChars
      for (const text of ['', '   ', '\n\u3000\t', `${BANNED}${'长'.repeat(max)}`, '你好\u0000']) {
        expect(await engine.start(a, b.studentId, text)).toEqual(failure('invalid_message'))
      }
      // Characters are code points: an emoji is one, though it is two UTF-16 units.
      const c = await open(a, b, '😀'.repeat(max))
      expect(await engine.reply(b, c, '😀'.repeat(max + 1))).toEqual(failure('invalid_message'))
      expect(await engine.reply(b, c, ' \n ')).toEqual(failure('invalid_message'))
      expect(await engine.reply(b, c, '\u0000')).toEqual(failure('invalid_message'))
      expect(await engine.reply(b, c, '好')).toEqual({ ok: true })

      expect((await messageRows()).map((r) => r.text)).toEqual(['😀'.repeat(max), '好'])
      expect(await records()).toEqual([])
      expect(await engine.initiationsLeft(a)).toBe(config.chat.maxInitiationsPerLesson - 1)
    })
  })

  describe('starting a conversation', () => {
    test('the 4th start is refused with initiation_cap and recorded once; the 5th is refused and not recorded again', async () => {
      const a = await joined({ maxRounds: 1 })
      const b = await joined()
      expect(config.chat.maxInitiationsPerLesson).toBe(3)
      for (let i = 0; i < 3; i++) {
        const c = await open(a, b)
        expect(await engine.reply(b, c, '嗯')).toEqual({ ok: true })
      }
      expect(await engine.initiationsLeft(a)).toBe(0)
      sent()

      expect(await engine.start(a, b.studentId, '再聊一次')).toEqual(failure('initiation_cap'))
      clock.set(at('20:06'))
      expect(await engine.start(a, b.studentId, '真的最后一次')).toEqual(failure('initiation_cap'))
      expect(sent()).toEqual([])
      expect(await records()).toEqual([
        { studentId: a.studentId, sessionId, kind: 'initiations', detail: { cap: 3 }, matchedTerm: null, createdAt: at('20:05') },
      ])
      expect(await messageRows()).toHaveLength(6)

      // The classmate's own allowance is untouched.
      expect(await engine.initiationsLeft(b)).toBe(3)
      expect((await engine.start(b, a.studentId, '我来找你')).ok).toBe(true)
    })

    test('a student in probation may not start a conversation, but may answer one', async () => {
      const newcomer = await joined({ lessonsAttended: config.chat.probationLessons - 1 })
      const a = await joined()
      expect(await engine.start(newcomer, a.studentId, '你好')).toEqual(failure('probation'))
      expect(await records()).toEqual([])

      const c = await open(a, newcomer, '欢迎新同学')
      expect(await engine.reply(newcomer, c, '谢谢')).toEqual({ ok: true })
      expect(sent()).toEqual([to(newcomer, incoming(c, a, '欢迎新同学', 1)), to(a, incoming(c, newcomer, '谢谢', 1))])

      // After the probation lessons, starting is fine.
      const veteran = await joined({ lessonsAttended: config.chat.probationLessons })
      expect((await engine.start(veteran, (await joined()).studentId, '你好')).ok).toBe(true)
    })

    test('a start to someone outside the class, to oneself, offline or busy is refused and uses no start', async () => {
      const otherClass = await insertClass(db, { classNo: 2 })
      const otherSession = await insertSession(db, { classId: otherClass, date: MON, startsAt: at('20:00'), endsAt: at('20:30') })
      const stranger = await joined({ classId: otherClass, sessionId: otherSession })
      const [a, b, c, d] = [await joined(), await joined(), await joined(), await joined()]
      const away = await student() // in the class, not connected

      expect(await engine.start(a, stranger.studentId, '你好')).toEqual(failure('not_classmate'))
      expect(await engine.start(a, a.studentId, '你好')).toEqual(failure('not_classmate'))
      expect(await engine.start(a, 2_000_000_000, '你好')).toEqual(failure('not_classmate'))
      expect(await engine.start(a, away.studentId, '你好')).toEqual(failure('peer_offline'))
      await open(b, c)
      expect(await engine.start(b, d.studentId, '你好')).toEqual(failure('self_busy'))
      expect(await engine.start(a, c.studentId, '你好')).toEqual(failure('peer_busy'))
      expect(await engine.start(c, d.studentId, '你好')).toEqual(failure('self_busy'))

      expect(await engine.initiationsLeft(a)).toBe(3)
      expect(await engine.initiationsLeft(b)).toBe(2)
      expect(await messageRows()).toHaveLength(1)
      expect(await records()).toEqual([])
    })

    test('the starts used survive a restart: a new engine counts them from the messages table', async () => {
      const a = await joined({ maxRounds: 1 })
      const b = await joined({ maxRounds: 1 })
      const first = await open(a, b)
      expect(await engine.reply(b, first, '嗯')).toEqual({ ok: true })
      await open(a, b) // still going at the restart

      engine = newEngine()
      await join(a, b)
      expect(await engine.initiationsLeft(a)).toBe(1)
      // b only answered.
      expect(await engine.initiationsLeft(b)).toBe(3)

      // The conversations of before the restart are gone; the count goes on from the database's.
      expect(await engine.start(a, b.studentId, BANNED)).toEqual(failure('blocked', { category: 'sensitive' }))
      expect(await engine.initiationsLeft(a)).toBe(1)
      await open(a, b)
      expect(await engine.initiationsLeft(a)).toBe(0)

      engine = newEngine()
      expect(await engine.initiationsLeft(a)).toBe(0)
      await join(a, b)
      expect(await engine.start(a, b.studentId, '再来')).toEqual(failure('initiation_cap'))
    })
  })

  describe('Review Focus 3: turns, ends and the dismissal', () => {
    test('a classmate going offline ends the conversation with peer_offline for the other; nothing is recorded', async () => {
      const a = await joined()
      const b = await joined()
      const c = await open(a, b)
      expect(await engine.reply(b, c, '在')).toEqual({ ok: true })
      sent()

      hub.leave(b.studentId)
      engine.onDisconnect(b.studentId)
      expect(sent()).toEqual([to(a, ended(c, 'peer_offline'))])
      expect(await engine.reply(a, c, '人呢')).toEqual(failure('conversation_ended'))
      expect(await engine.start(a, b.studentId, '回来了吗')).toEqual(failure('peer_offline'))
      expect(await records()).toEqual([])

      // A disconnect of someone in no conversation changes nothing.
      engine.onDisconnect(a.studentId)
      expect(sent()).toEqual([])
    })

    test('an overdue reply ends the conversation with timeout for both, the timeout following the timeline speed', async () => {
      engine = newEngine({ speed: 4 }) // 120 seconds become 30
      const a = await joined()
      const b = await joined()
      const c = await open(a, b)
      sent()

      clock.advance(30_000 - 1)
      engine.tick()
      expect(sent()).toEqual([])
      expect(await engine.reply(b, c, '在')).toEqual({ ok: true })
      sent()

      // Each turn has its own time: a now has 30 seconds from b's reply.
      clock.advance(30_000 - 1)
      engine.tick()
      expect(sent()).toEqual([])
      clock.advance(1)
      engine.tick()
      expect(sent()).toEqual([to(a, ended(c, 'timeout')), to(b, ended(c, 'timeout'))])
      expect(await engine.reply(a, c, '我来晚了')).toEqual(failure('conversation_ended'))
      expect(await records()).toEqual([])
    })

    test('a reply that comes after its time is too late even before any tick', async () => {
      const a = await joined()
      const b = await joined()
      const c = await open(a, b)
      sent()
      clock.advance(config.chat.replyTimeoutSeconds * 1000)
      expect(await engine.reply(b, c, '我来了')).toEqual(failure('conversation_ended'))
      expect(sent()).toEqual([to(a, ended(c, 'timeout')), to(b, ended(c, 'timeout'))])
      expect((await messageRows()).map((r) => r.text)).toEqual(['你好'])
    })

    test('at the dismissal the side whose turn it is gets chat.closing; its last line is moderated and delivered, then dismissal', async () => {
      const [a, b, c, d, e, f] = [await joined(), await joined(), await joined(), await joined(), await joined(), await joined()]
      clock.set(at('20:28:45'))
      const cd = await open(c, d, '在吗')
      expect(await engine.reply(d, cd, '在')).toEqual({ ok: true }) // c's turn, due 20:30:45
      clock.set(at('20:29:30'))
      const ab = await open(a, b, '快下课了') // b's turn
      sent()

      clock.set(at('20:30'))
      engine.startClosing(classId)
      expect(sent()).toEqual([to(c, closing(cd)), to(b, closing(ab))])

      // Nothing new starts after the dismissal, and trying uses no start.
      expect(await engine.start(e, f.studentId, '你好')).toEqual(failure('not_in_session'))
      expect(await engine.initiationsLeft(e)).toBe(3)

      // Only the side whose turn it is may speak; its line is moderated (a stopped one may be tried again).
      expect(await engine.reply(a, ab, '再说一句')).toEqual(failure('not_your_turn'))
      expect(await engine.reply(b, ab, BANNED)).toEqual(failure('blocked', { category: 'sensitive' }))
      expect(sent()).toEqual([])
      expect(await engine.reply(b, ab, '下课了，再见')).toEqual({ ok: true })
      expect(sent()).toEqual([
        to(a, incoming(ab, b, '下课了，再见', 1)),
        to(a, ended(ab, 'dismissal')),
        to(b, ended(ab, 'dismissal')),
      ])

      // The grace does not time out: c's turn would have been due at 20:30:45, yet c may stay silent until the close,
      // where endAll ends what is left.
      clock.set(at('20:30:50'))
      engine.tick()
      expect(sent()).toEqual([])
      clock.set(CLOSE_AT)
      engine.endAll(classId)
      expect(sent()).toEqual([to(c, ended(cd, 'dismissal')), to(d, ended(cd, 'dismissal'))])
      engine.endAll(classId)
      expect(sent()).toEqual([])

      // The last line of the grace is kept as a closing line.
      expect((await messageRows()).filter((r) => r.senderId === b.studentId)).toEqual([
        row(b, a, BANNED, { conversationId: ab, kind: 'closing', delivered: false, moderation: 'sensitive', matchedTerm: BANNED }),
        row(b, a, '下课了，再见', { conversationId: ab, kind: 'closing' }),
      ])
    })

    test('a last line in the grace that is also the reply of the last round ends the conversation as the rounds do', async () => {
      clock.set(at('20:29:30'))
      const a = await joined({ maxRounds: 9 })
      const b = await joined({ maxRounds: 9 })
      const c = await open(a, b, '第1轮')
      for (let round = 1; round < 5; round++) {
        expect(await engine.reply(b, c, `回第${round}轮`)).toEqual({ ok: true })
        expect(await engine.reply(a, c, `第${round + 1}轮`)).toEqual({ ok: true })
      }
      sent()

      clock.set(at('20:30'))
      engine.startClosing(classId)
      expect(sent()).toEqual([to(b, closing(c))])
      expect(await engine.reply(b, c, '回第5轮')).toEqual({ ok: true })
      expect(sent()).toEqual([to(a, incoming(c, b, '回第5轮', 5)), to(a, ended(c, 'school_cap')), to(b, ended(c, 'school_cap'))])
      expect((await records()).map((r) => [r.studentId, r.kind])).toEqual([
        [a.studentId, 'rounds'],
        [b.studentId, 'rounds'],
      ])
    })

    test('a conversation still going at the session close ends with dismissal on the next tick, without endAll', async () => {
      clock.set(at('20:30:00'))
      const a = await joined()
      const b = await joined()
      const c = await open(a, b)
      sent()

      clock.set(new Date(CLOSE_AT.getTime() - 1))
      engine.tick()
      expect(sent()).toEqual([])
      clock.set(CLOSE_AT)
      engine.tick()
      expect(sent()).toEqual([to(a, ended(c, 'dismissal')), to(b, ended(c, 'dismissal'))])
      expect(await engine.start(b, a.studentId, '还在吗')).toEqual(failure('not_in_session'))
    })

    test('a line already moving at the dismissal is delivered, and its recipient then gets chat.closing', async () => {
      clock.set(at('20:29:50'))
      const a = await joined()
      const b = await joined()
      const c = await open(a, b)
      expect(await engine.reply(b, c, '在')).toEqual({ ok: true })
      sent()

      const pending = engine.reply(a, c, '下课前问一句') // checked and taken at once; written while the class is dismissed
      clock.set(at('20:30'))
      engine.startClosing(classId)
      expect(await pending).toEqual({ ok: true })
      expect(sent()).toEqual([to(b, incoming(c, a, '下课前问一句', 2, true)), to(b, closing(c))])
      expect(await engine.reply(b, c, '下课再说')).toEqual({ ok: true })
      expect(sent()).toEqual([to(a, incoming(c, b, '下课再说', 2)), to(a, ended(c, 'dismissal')), to(b, ended(c, 'dismissal'))])
    })
  })

  describe('Review Focus 3: both sides at once', () => {
    test('two classmates starting with each other at once make one conversation', async () => {
      const a = await joined()
      const b = await joined()
      const results = await Promise.all([engine.start(a, b.studentId, '找你'), engine.start(b, a.studentId, '我也找你')])
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      expect(results.filter((r) => !r.ok)).toEqual([failure('self_busy')])
      const winner = results[0]!.ok ? a : b
      const loser = winner === a ? b : a

      expect(await messageRows()).toEqual([
        row(winner, loser, winner === a ? '找你' : '我也找你', { conversationId: (results.find((r) => r.ok) as { result: { conversationId: string } }).result.conversationId }),
      ])
      expect(await engine.initiationsLeft(winner)).toBe(2)
      expect(await engine.initiationsLeft(loser)).toBe(3)
    })

    test('two lines of the same side at once: one is taken, the other is not_your_turn', async () => {
      const a = await joined()
      const b = await joined()
      const c = await open(a, b)
      const results = await Promise.all([engine.reply(b, c, '第一句'), engine.reply(b, c, '第二句')])
      expect(results).toEqual([{ ok: true }, failure('not_your_turn')])
      expect((await messageRows()).map((r) => r.text)).toEqual(['你好', '第一句'])
    })

    test('a classmate who goes offline while a reply is written: it is not forwarded, and kept as undelivered', async () => {
      const a = await joined()
      const b = await joined()
      const c = await open(a, b)
      expect(await engine.reply(b, c, '在')).toEqual({ ok: true })
      sent()

      const pending = engine.reply(a, c, '你还在吗') // checked and taken at once; the write is under way
      hub.leave(b.studentId)
      engine.onDisconnect(b.studentId)
      expect(await pending).toEqual(failure('peer_offline'))
      expect(sent()).toEqual([to(a, ended(c, 'peer_offline'))])
      expect((await messageRows()).at(-1)).toEqual(row(a, b, '你还在吗', { conversationId: c, delivered: false }))
    })

    test('a classmate who goes offline while a first line is written: nothing opens, and the start is not used', async () => {
      const a = await joined()
      const b = await joined()
      // Right after the engine's synchronous checks and reservation (they look who is online), before the write is done.
      const online = hub.online.bind(hub)
      hub.online = (id) => {
        hub.online = online
        queueMicrotask(() => {
          hub.leave(b.studentId)
          engine.onDisconnect(b.studentId)
        })
        return online(id)
      }

      const result = await engine.start(a, b.studentId, '你好')
      expect(result).toEqual(failure('peer_offline'))
      // Nobody heard of the conversation: b never got its line, and a has only the answer.
      expect(sent()).toEqual([])
      const [line] = await messageRows()
      expect(line).toEqual({ ...row(a, b, '你好', { delivered: false }), conversationId: expect.any(String) })
      expect(await engine.initiationsLeft(a)).toBe(3)
      // a is free again.
      expect((await engine.start(a, (await joined()).studentId, '那找你')).ok).toBe(true)
    })
  })

  describe('Review Focus 3: a write the database fails', () => {
    test('a first line the database cannot take opens nothing and uses no start', async () => {
      const faulty = faultyDb()
      engine = newEngine({ db: faulty.db })
      const a = await joined()
      const b = await joined()

      faulty.failNext('messages')
      await expect(engine.start(a, b.studentId, '你好')).rejects.toThrow('The database is unreachable')
      expect(sent()).toEqual([])
      expect(await messageRows()).toEqual([])
      expect(await engine.initiationsLeft(a)).toBe(3)

      // Neither of them is held in a conversation: the same start goes through now.
      const c = await open(a, b)
      expect(sent()).toEqual([to(b, incoming(c, a, '你好', 1))])
      expect(await engine.initiationsLeft(a)).toBe(2)
    })

    test('a reply the database cannot take leaves the turn with its sender', async () => {
      const faulty = faultyDb()
      engine = newEngine({ db: faulty.db })
      const a = await joined()
      const b = await joined()
      const c = await open(a, b)
      sent()

      faulty.failNext('messages')
      await expect(engine.reply(b, c, '在')).rejects.toThrow('The database is unreachable')
      expect(sent()).toEqual([])
      expect(await engine.reply(a, c, '插一句')).toEqual(failure('not_your_turn'))
      expect(await engine.reply(b, c, '在')).toEqual({ ok: true })
      expect(sent()).toEqual([to(a, incoming(c, b, '在', 1))])
    })

    test('a last reply whose rounds records cannot be written is not forwarded, and none of it is kept', async () => {
      const faulty = faultyDb()
      engine = newEngine({ db: faulty.db })
      const a = await joined({ maxRounds: 9 })
      const b = await joined({ maxRounds: 9 })
      const c = await open(a, b, '第1轮')
      for (let round = 1; round < 5; round++) {
        expect(await engine.reply(b, c, `回第${round}轮`)).toEqual({ ok: true })
        expect(await engine.reply(a, c, `第${round + 1}轮`)).toEqual({ ok: true })
      }
      sent()

      // The line and the two records go together: the records fail, so the line is not kept or forwarded either.
      faulty.failNext('disciplineRecords')
      await expect(engine.reply(b, c, '回第5轮')).rejects.toThrow('The database is unreachable')
      expect(sent()).toEqual([])
      expect(await records()).toEqual([])
      expect((await messageRows()).map((r) => r.text)).not.toContain('回第5轮')

      expect(await engine.reply(b, c, '回第5轮')).toEqual({ ok: true })
      expect(sent()).toEqual([to(a, incoming(c, b, '回第5轮', 5)), to(a, ended(c, 'school_cap')), to(b, ended(c, 'school_cap'))])
      expect((await records()).map((r) => [r.studentId, r.kind])).toEqual([
        [a.studentId, 'rounds'],
        [b.studentId, 'rounds'],
      ])
    })

    test('a reply the database cannot take as the class is dismissed: its sender gets chat.closing then', async () => {
      clock.set(at('20:29:50'))
      const faulty = faultyDb()
      engine = newEngine({ db: faulty.db })
      const a = await joined()
      const b = await joined()
      const c = await open(a, b)
      expect(await engine.reply(b, c, '在')).toEqual({ ok: true })
      sent()

      faulty.failNext('messages')
      const pending = engine.reply(a, c, '下课前问一句') // taken at once; its write fails after the dismissal
      clock.set(at('20:30'))
      engine.startClosing(classId)
      expect(sent()).toEqual([]) // a line on its way: its recipient would be told once it is forwarded
      await expect(pending).rejects.toThrow('The database is unreachable')
      expect(sent()).toEqual([to(a, closing(c))])

      expect(await engine.reply(a, c, '那下次再说')).toEqual({ ok: true })
      expect(sent()).toEqual([to(b, incoming(c, a, '那下次再说', 2)), to(a, ended(c, 'dismissal')), to(b, ended(c, 'dismissal'))])
    })
  })

  describe('lines the moderator stops', () => {
    test('a stopped reply is not forwarded and keeps the turn; ten in a lesson make one school_rule record', async () => {
      const a = await joined()
      const b = await joined()
      const c = await open(a, b)
      sent()
      for (let i = 0; i < 10; i++) {
        clock.set(new Date(at('20:05').getTime() + i * 1000))
        expect(await engine.reply(b, c, `${BANNED}${i}`)).toEqual(failure('blocked', { category: 'sensitive' }))
      }
      expect(sent()).toEqual([])
      // Not a round: the same side tries again, and it is still round 1.
      expect(await engine.reply(b, c, '好的')).toEqual({ ok: true })
      expect(sent()).toEqual([to(a, incoming(c, b, '好的', 1))])

      const rows = await messageRows()
      expect(rows.slice(1, 11)).toEqual(
        Array.from({ length: 10 }, (_, i) =>
          row(b, a, `${BANNED}${i}`, { conversationId: c, delivered: false, moderation: 'sensitive', matchedTerm: BANNED }),
        ),
      )
      expect(await records()).toEqual([
        { studentId: b.studentId, sessionId, kind: 'school_rule', detail: { category: 'sensitive', quote: `${BANNED}0` }, matchedTerm: BANNED, createdAt: at('20:05') },
      ])
    })

    test('a stopped first line opens nothing and uses no start', async () => {
      const a = await joined()
      const b = await joined()
      expect(await engine.start(a, b.studentId, INJECTION)).toEqual(failure('blocked', { category: 'injection' }))
      expect(sent()).toEqual([])
      expect(await engine.initiationsLeft(a)).toBe(3)
      expect(await messageRows()).toEqual([
        row(a, b, INJECTION, { delivered: false, moderation: 'injection', matchedTerm: INJECTION }),
      ])
      expect(await records()).toEqual([
        { studentId: a.studentId, sessionId, kind: 'school_rule', detail: { category: 'injection', quote: INJECTION }, matchedTerm: INJECTION, createdAt: at('20:05') },
      ])
      // Neither of them is in a conversation.
      await open(b, a)
    })

    test('a privacy hit is recorded every time as privacy_block, quoting the line masked and keeping no matched term', async () => {
      const a = await joined()
      const b = await joined()
      const c = await open(a, b)
      expect(await engine.reply(b, c, PHONE)).toEqual(failure('blocked', { category: 'privacy' }))
      expect(await engine.reply(b, c, `再说一遍：${PHONE}`)).toEqual(failure('blocked', { category: 'privacy' }))

      expect((await messageRows()).slice(1)).toEqual([
        row(b, a, PHONE, { conversationId: c, delivered: false, moderation: 'privacy' }),
        row(b, a, `再说一遍：${PHONE}`, { conversationId: c, delivered: false, moderation: 'privacy' }),
      ])
      const quoted = await records()
      expect(quoted).toEqual([
        { studentId: b.studentId, sessionId, kind: 'privacy_block', detail: { quote: '我的手机号是138****5678' }, matchedTerm: null, createdAt: at('20:05') },
        { studentId: b.studentId, sessionId, kind: 'privacy_block', detail: { quote: '再说一遍：我的手机号是138****5678' }, matchedTerm: null, createdAt: at('20:05') },
      ])
      expect(JSON.stringify(quoted)).not.toContain('13812345678')
    })

    test('the program log has numbers and categories, never what was said or what matched', async () => {
      const a = await joined({ maxRounds: 1 })
      const b = await joined()
      const c = await open(a, b, '光为什么会弯')
      await engine.reply(b, c, BANNED)
      await engine.reply(b, c, PHONE)
      await engine.reply(b, c, '因为介质不同')
      await engine.start(a, b.studentId, INJECTION)

      expect(logged.length).toBeGreaterThan(0)
      expect(logged).toContainEqual(expect.objectContaining({ category: 'privacy' }))
      const text = JSON.stringify(logged)
      for (const said of ['光为什么会弯', BANNED, PHONE, '13812345678', '因为介质不同', INJECTION]) expect(text).not.toContain(said)
    })
  })
})

// ---- Over the real WebSocket ----

describe('chat over the WebSocket', () => {
  type Service = Awaited<ReturnType<typeof buildTestClassApp>>
  type Received = Record<string, any>
  let service: Service | undefined
  const sockets: WebSocket[] = []

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate()
    await service?.destroy()
    service = undefined
  })

  async function waitUntil(check: () => boolean, what: string): Promise<void> {
    for (let waited = 0; !check(); waited += 5) {
      if (waited > 5000) throw new Error(`Timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  async function connect(s: Service, key: string) {
    const received: Received[] = []
    let cursor = 0
    const ws = await s.app.injectWS(
      '/v1/class',
      { headers: { authorization: `Bearer ${key}` } },
      { onInit: (socket) => void socket.on('message', (data) => void received.push(JSON.parse(String(data)))) },
    )
    sockets.push(ws)
    return {
      send: (message: object) => ws.send(JSON.stringify(message)),
      /** The next message of `type` not read yet (others before it are skipped), checked against the schema. */
      async next(type?: string): Promise<Received> {
        for (;;) {
          await waitUntil(() => cursor < received.length, 'a message')
          const m = received[cursor++]!
          expect(Value.Check(ServerMessage, m), JSON.stringify(m)).toBe(true)
          if (type === undefined || m.type === type) return m
        }
      },
    }
  }

  async function hello(client: Awaited<ReturnType<typeof connect>>, maxRounds: number): Promise<Received> {
    client.send({ id: 'h', type: 'hello', protocol: 'v1', plugin: { type: 'openclaw', version: '1.2.3' }, maxRounds })
    expect(await client.next()).toEqual({ type: 'ack', id: 'h', ok: true })
    return client.next('welcome')
  }

  /** Two classmates out of probation, 阿杰家的小鱼 and 阿美家的豆豆, with the doors of the evening session open. */
  async function seedPair(s: Service) {
    const classId = await insertClass(s.db, { classNo: 1 })
    const a = await insertStudent(s.db, { classId, status: 'active', ownerName: '阿杰', aiName: '小鱼' })
    const b = await insertStudent(s.db, { classId, status: 'active', ownerName: '阿美', aiName: '豆豆' })
    await s.db.updateTable('students').set({ lessonsAttended: 5 }).execute()
    s.clock.set(at('19:50'))
    await s.runtime.tick()
    return { a, b, asA: { studentId: a.id, displayName: '阿杰家的小鱼' }, asB: { studentId: b.id, displayName: '阿美家的豆豆' } }
  }

  test('the hello joins the student to the engine: a classmate holding one round gets the first line as the last round', async () => {
    service = await buildTestClassApp()
    const s = service
    const { a, b, asA } = await seedPair(s)
    const ca = await connect(s, a.key)
    expect((await hello(ca, 5)).limits.initiationsLeft).toBe(3)
    const cb = await connect(s, b.key)
    await hello(cb, 1) // b has said nothing yet: only its hello tells the engine its plugin holds one round

    ca.send({ id: 's1', type: 'chat.start', to: b.id, text: '只聊一轮吗？' })
    expect((await ca.next('ack')).ok).toBe(true)
    expect(await cb.next('chat.incoming')).toMatchObject({ from: asA, text: '只聊一轮吗？', round: 1, lastLine: true })
  })

  test('a conversation from start to dismissal, the welcome counting the starts, and nothing said in the log', async () => {
    const logs = captureLogs()
    service = await buildTestClassApp({ logger: { level: 'info', stream: logs.stream } })
    const s = service
    const { a, b, asA, asB } = await seedPair(s)

    const ca = await connect(s, a.key)
    expect((await hello(ca, 1)).limits.initiationsLeft).toBe(3)
    const cb = await connect(s, b.key)
    await hello(cb, 3)

    // A one-round conversation (a's plugin holds one): the first line is the last round's.
    ca.send({ id: 's1', type: 'chat.start', to: b.id, text: '一起预习光的折射吗？' })
    const ack = await ca.next('ack')
    expect(ack).toEqual({ type: 'ack', id: 's1', ok: true, result: { conversationId: expect.any(String) } })
    const c1 = ack.result.conversationId
    expect(await cb.next('chat.incoming')).toEqual({ type: 'chat.incoming', conversationId: c1, from: asA, text: '一起预习光的折射吗？', round: 1, lastLine: true })
    cb.send({ id: 'r1', type: 'chat.reply', conversationId: c1, text: '好呀' })
    expect(await cb.next('chat.ended')).toEqual({ type: 'chat.ended', conversationId: c1, reason: 'closed' })
    expect(await cb.next('ack')).toEqual({ type: 'ack', id: 'r1', ok: true })
    expect(await ca.next('chat.incoming')).toEqual({ type: 'chat.incoming', conversationId: c1, from: asB, text: '好呀', round: 1, lastLine: false })
    expect(await ca.next('chat.ended')).toEqual({ type: 'chat.ended', conversationId: c1, reason: 'closed' })

    // A reconnects (its plugin now holding three rounds): the welcome counts the start.
    const ca2 = await connect(s, a.key)
    expect((await hello(ca2, 3)).limits.initiationsLeft).toBe(2)

    // A stopped line is answered with its category, never with what matched.
    ca2.send({ id: 's2', type: 'chat.start', to: b.id, text: BANNED })
    expect(await ca2.next('ack')).toEqual({
      type: 'ack',
      id: 's2',
      ok: false,
      error: { category: 'sensitive', code: 'blocked', message: WS_ERROR_MESSAGES.blocked },
    })

    // b starts one just before the dismissal: the runtime's dismissal gives a the closing grace for a last line.
    s.clock.set(at('20:29:30'))
    await s.runtime.tick()
    cb.send({ id: 's3', type: 'chat.start', to: a.id, text: '下课前再问一个' })
    const c2 = (await cb.next('ack')).result.conversationId
    expect(await ca2.next('chat.incoming')).toMatchObject({ conversationId: c2, round: 1, lastLine: false })
    s.clock.set(at('20:30'))
    await s.runtime.tick()
    expect(await ca2.next('chat.closing')).toEqual({ type: 'chat.closing', conversationId: c2 })
    ca2.send({ id: 'r2', type: 'chat.reply', conversationId: c2, text: '明天见' })
    expect(await ca2.next('ack')).toEqual({ type: 'ack', id: 'r2', ok: true })
    expect(await cb.next('chat.incoming')).toEqual({ type: 'chat.incoming', conversationId: c2, from: asA, text: '明天见', round: 1, lastLine: false })
    expect(await cb.next('chat.ended')).toEqual({ type: 'chat.ended', conversationId: c2, reason: 'dismissal' })

    const rows = await s.db.selectFrom('messages').select(['kind', 'text', 'delivered']).orderBy('id').execute()
    expect(rows).toEqual([
      { kind: 'chat', text: '一起预习光的折射吗？', delivered: true },
      { kind: 'chat', text: '好呀', delivered: true },
      { kind: 'chat', text: BANNED, delivered: false },
      { kind: 'chat', text: '下课前再问一个', delivered: true },
      { kind: 'closing', text: '明天见', delivered: true },
    ])

    // The log has the engine's lines, and no one's words.
    const logged = logs.entries()
    expect(logged.filter((e) => e.msg === 'conversation ended').map((e) => e.reason)).toEqual(['closed', 'dismissal'])
    expect(logged.filter((e) => e.level >= 50)).toEqual([])
    const text = JSON.stringify(logged)
    for (const said of ['一起预习光的折射吗？', '好呀', BANNED, '下课前再问一个', '明天见']) expect(text).not.toContain(said)
  })
})
