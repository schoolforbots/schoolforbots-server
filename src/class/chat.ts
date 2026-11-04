import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Static } from 'typebox'
import { maskPrivacy } from '../moderation/mask.js'
import type { ModerationResult, Moderator } from '../moderation/moderator.js'
import type { ChatClosingMessage, ChatEndedMessage, ChatIncomingMessage } from '../protocol/ws.js'
import type { Clock } from '../shared/clock.js'
import type { SchoolConfig } from '../shared/config.js'
import type { Database, MessageKind } from '../shared/schema.js'
import type { AckResult, MessageHandlers, Participant } from './connection.js'
import type { DisciplineRecorder } from './discipline.js'
import type { Hub } from './hub.js'
import type { WsErrorCode } from './ws-errors.js'

// Classmates talking one to one during class, under the school's limits: who may start a conversation and how often,
// whose turn it is, how many rounds a conversation lasts, how long a reply may take, and the last line after the
// dismissal. Every line goes past the moderator before it is forwarded, and every line forwarded or stopped is written
// to the messages table.
//
// Conversations live in memory: the class service runs as one instance, and a restart disconnects everyone. What has
// to outlast a restart is read from the database: how many conversations each student has started this session.
//
// Two connections may call the engine at the same time. Every check of turns, partners and allowances, and the
// reservation that follows from it, runs with no `await` in between, so whoever comes second sees what the first one
// took. After each `await` the conversation is looked at again before anything is forwarded.

/** A line a student said, as the messages table keeps it. */
export interface Line {
  from: Participant
  kind: MessageKind
  conversationId: string | null
  recipientId: number | null
  text: string
  at: Date
}

export type Blocked = Extract<ModerationResult, { verdict: 'blocked' }>

export interface ChatEngine {
  /** Opens a conversation with the classmate `to` by forwarding its first line; ok carries `{ conversationId }`. */
  start(from: Participant, to: number, text: string): Promise<AckResult>
  /** The next line of a conversation, from the side whose turn it is. */
  reply(from: Participant, conversationId: string, text: string): Promise<AckResult>
  /**
   * The student joined the class (hello): the engine registers them, since a conversation's limit needs the
   * responder's `maxRounds` before they have said anything, and answers the starts left for the welcome.
   */
  join(p: Participant): Promise<{ initiationsLeft: number }>
  /** How many conversations the student may still start this session. */
  initiationsLeft(p: Participant): Promise<number>
  /** The student went offline: their conversation ends with `peer_offline`, and the other side is told. */
  onDisconnect(studentId: number): void
  /** The dismissal: no conversation starts any more, and each one going gets one last line (`chat.closing`). */
  startClosing(classId: number): void
  /** The close: whatever conversation of the class is left ends with `dismissal`. */
  endAll(classId: number): void
  /**
   * Ends what is overdue by the clock: a conversation whose awaited line is later than the reply timeout (`timeout`),
   * and one whose session has closed (`dismissal`). The start and the reply of a line look first too; the service
   * calls this on the runtime's interval, so a conversation nobody touches ends on time as well.
   */
  tick(): void
}

export interface ChatEngineDeps {
  db: Kysely<Database>
  config: SchoolConfig
  clock: Clock
  hub: Hub
  moderator: Moderator
  discipline: DisciplineRecorder
  /** Timeline speed (1 is real time): it divides the reply timeout as it does every lesson duration. */
  speed: number
  /** A program log line: numbers and categories only, never what anyone said or what the moderator matched. */
  log?: (obj: object, msg: string) => void
}

type EndReason = Static<typeof ChatEndedMessage>['reason']

interface Conversation {
  readonly id: string
  readonly classId: number
  readonly sessionId: number
  /** The session's close (ms): the conversation ends then at the latest. */
  readonly closeAt: number
  readonly opener: { studentId: number; displayName: string; maxRounds: number }
  readonly responderId: number
  /** The responder's plugin limit: known from their hello, else learnt from their first reply. */
  responderMaxRounds: number | null
  /** The round going on, from 1: the opener's line and the responder's reply. */
  round: number
  /** Whose line is awaited; null while a line is on its way (taken, not yet forwarded). */
  turn: number | null
  /** When the awaited line is overdue (ms). */
  dueAt: number
  /** Whether the first line has reached the responder. Until it has, nobody is told the conversation ended. */
  opened: boolean
  /** After the dismissal: the side whose turn it is has one last line. */
  closing: boolean
  ended: EndReason | null
  /** The side who went offline, when that ended it. */
  offline: number | null
}

/** Per session: the conversations each student has started, read from the database once and counted here after. */
interface Starts {
  classId: number
  closeAt: number
  count: Map<number, number>
}

const fail = (code: WsErrorCode, extra?: object): AckResult =>
  extra === undefined ? { ok: false, code } : { ok: false, code, extra }

const closingMessage = (conversationId: string): Static<typeof ChatClosingMessage> => ({
  type: 'chat.closing',
  conversationId,
})

/**
 * Whether a line can be taken at all: something besides blanks, at most `maxChars` characters (code points), and no
 * NUL, which a Postgres text column cannot hold.
 */
export function isValidText(text: string, maxChars: number): boolean {
  if (text.trim() === '' || text.includes('\u0000')) return false
  let n = 0
  for (const _ of text) if (++n > maxChars) return false
  return true
}

/**
 * Writes a line to the messages table: forwarded when `blocked` is null, else stopped: by the word list for its
 * category, or by the second layer (`second_layer`).
 */
export async function writeLine(
  trx: Kysely<Database>,
  line: Line,
  blocked: Blocked | 'second_layer' | null,
): Promise<number> {
  const { from } = line
  const byWordList = blocked === 'second_layer' ? null : blocked
  const row = await trx
    .insertInto('messages')
    .values({
      sessionId: from.sessionId,
      classId: from.classId,
      kind: line.kind,
      conversationId: line.conversationId,
      senderId: from.studentId,
      recipientId: line.recipientId,
      text: line.text,
      moderation: blocked === 'second_layer' ? blocked : (byWordList?.category ?? null),
      // The rule that hit, never what it matched: a privacy hit names no rule, so the number or address that matched is
      // not kept apart from the text. The second layer names none either.
      matchedTerm: byWordList?.rule ?? null,
      delivered: blocked === null,
      ip: from.ip,
      pluginType: from.pluginType,
      pluginVersion: from.pluginVersion,
      createdAt: line.at,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

/**
 * A line the moderator stopped: written undelivered, with the record it earns, in one transaction. A privacy hit is a
 * `privacy_block` every time; any other hit breaks the school rule, recorded once per lesson and naming the rule.
 * Either quotes the line with any number or address masked: the moderator stops at its first hit, so a line stopped
 * for a banned word may still hold a phone number, and the quote reaches the owner's records and summaries.
 */
export async function recordBlocked(
  db: Kysely<Database>,
  discipline: DisciplineRecorder,
  line: Line,
  blocked: Blocked,
): Promise<void> {
  const { studentId, sessionId } = line.from
  const privacy = blocked.category === 'privacy'
  const quote = maskPrivacy(line.text)
  await db.transaction().execute(async (trx) => {
    await writeLine(trx, line, blocked)
    await discipline.record(trx, {
      studentId,
      sessionId,
      kind: privacy ? 'privacy_block' : 'school_rule',
      detail: privacy ? { quote } : { category: blocked.category, quote },
      matchedTerm: blocked.rule,
      at: line.at,
    })
  })
}

/**
 * The conversations of the session the student started: those whose first delivered line the student sent. A first
 * line that never reached the classmate opened nothing, and a stopped one is not delivered either.
 */
async function countStarts(db: Kysely<Database>, p: Participant): Promise<number> {
  const { n } = await db
    .selectFrom('messages as m')
    .select((eb) => eb.fn.count<string>('m.conversationId').distinct().as('n'))
    .where('m.sessionId', '=', p.sessionId)
    .where('m.senderId', '=', p.studentId)
    .where('m.kind', '=', 'chat')
    .where('m.delivered', '=', true)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('messages as e')
            .select('e.id')
            .whereRef('e.sessionId', '=', 'm.sessionId')
            .whereRef('e.conversationId', '=', 'm.conversationId')
            .where('e.delivered', '=', true)
            .whereRef('e.id', '<', 'm.id'),
        ),
      ),
    )
    .executeTakeFirstOrThrow()
  return Number(n)
}

/** The message handlers the class app takes from the engine. */
export function chatHandlers(
  engine: ChatEngine,
): Required<Pick<MessageHandlers, 'chatStart' | 'chatReply' | 'join'>> {
  return {
    chatStart: (p, msg) => engine.start(p, msg.to, msg.text),
    chatReply: (p, msg) => engine.reply(p, msg.conversationId, msg.text),
    join: (p) => engine.join(p),
  }
}

export function createChatEngine(deps: ChatEngineDeps): ChatEngine {
  const { db, config, clock, hub, moderator, discipline } = deps
  const log = deps.log ?? (() => {})
  const limits = config.chat
  const replyTimeoutMs = (limits.replyTimeoutSeconds * 1000) / deps.speed
  const closingGraceMs = (config.lesson.closingGraceSeconds * 1000) / deps.speed

  const conversations = new Map<string, Conversation>()
  /** The conversation each student is in. */
  const busy = new Map<number, Conversation>()
  /** The students connected, as their hello described them (see `join`); forgotten when they go offline. */
  const participants = new Map<number, Participant>()
  /** The classes in their closing grace, until when (ms): nothing starts there. Forgotten at the close. */
  const closing = new Map<number, number>()
  const starts = new Map<number, Starts>()

  const online = (classId: number, studentId: number) => hub.online(classId).includes(studentId)
  const otherSide = (c: Conversation, studentId: number) =>
    studentId === c.opener.studentId ? c.responderId : c.opener.studentId
  const isParty = (c: Conversation, studentId: number) =>
    studentId === c.opener.studentId || studentId === c.responderId
  /** Whether the student's session no longer takes new conversations: closed, or past its dismissal. */
  const sessionOver = (p: Participant, now: number) =>
    now >= p.closeAt.getTime() || (closing.get(p.classId) ?? -Infinity) > now

  function startsOf(p: Participant): Starts {
    let s = starts.get(p.sessionId)
    if (s === undefined) {
      s = { classId: p.classId, closeAt: p.closeAt.getTime(), count: new Map() }
      starts.set(p.sessionId, s)
    }
    return s
  }

  /** How many conversations the student has started this session; read from the database the first time. */
  async function loadStarts(p: Participant): Promise<number> {
    const known = startsOf(p).count.get(p.studentId)
    if (known !== undefined) return known
    const n = await countStarts(db, p)
    // Two first reads may overlap: the first to finish is kept, so a start counted since then stays counted. (No start
    // is counted before a first read has finished: the start waits for its own.)
    const { count } = startsOf(p)
    if (!count.has(p.studentId)) count.set(p.studentId, n)
    return count.get(p.studentId) ?? n
  }

  /** The class a student is in, from the database; null when none (or no such student). */
  async function classOf(studentId: number): Promise<number | null> {
    const row = await db.selectFrom('students').select('classId').where('id', '=', studentId).executeTakeFirst()
    return row?.classId ?? null
  }

  /** Takes a conversation out of the engine, telling nobody. */
  function forget(c: Conversation): void {
    conversations.delete(c.id)
    for (const id of [c.opener.studentId, c.responderId]) if (busy.get(id) === c) busy.delete(id)
  }

  /** Ends a conversation and tells both sides, or only the one still there when the other went offline. */
  function end(c: Conversation, reason: EndReason, offline: number | null = null): void {
    if (c.ended !== null) return
    c.ended = reason
    c.offline = offline
    forget(c)
    // A conversation whose first line has not reached the responder was never seen: the start is answered instead.
    if (c.opened) {
      const message: Static<typeof ChatEndedMessage> = { type: 'chat.ended', conversationId: c.id, reason }
      for (const id of [c.opener.studentId, c.responderId]) if (id !== offline) hub.send(id, message)
    }
    log({ conversationId: c.id, sessionId: c.sessionId, reason }, 'conversation ended')
  }

  /** Ends what is overdue at `now` and forgets what belongs to sessions that have closed. */
  function expire(now: number): void {
    for (const c of [...conversations.values()]) {
      if (now >= c.closeAt) end(c, 'dismissal')
      // The closing grace does not time out: it lasts until the close.
      else if (!c.closing && c.turn !== null && now >= c.dueAt) end(c, 'timeout')
    }
    for (const [classId, until] of closing) if (now >= until) closing.delete(classId)
    for (const [sessionId, s] of starts) if (now >= s.closeAt) starts.delete(sessionId)
    for (const [studentId, p] of participants) if (now >= p.closeAt.getTime()) participants.delete(studentId)
  }

  /** The rounds the conversation lasts: the smaller plugin limit, or the school's. */
  const capOf = (c: Conversation) =>
    Math.min(c.opener.maxRounds, c.responderMaxRounds ?? Infinity, limits.maxRoundsPerConversation)

  /**
   * How a line of `from` ends the conversation by the rounds: the last round's reply ends it, `school_cap` when both
   * plugins would have gone on past the school's limit (it is the school's doing then), else `closed`. Null otherwise.
   */
  function endingOf(c: Conversation, from: Participant): 'school_cap' | 'closed' | null {
    if (from.studentId === c.opener.studentId || c.round < capOf(c)) return null
    const schoolCap = limits.maxRoundsPerConversation
    return c.opener.maxRounds > schoolCap && (c.responderMaxRounds ?? 0) > schoolCap ? 'school_cap' : 'closed'
  }

  /**
   * Forwards a line that has been written and moves the conversation on: to the other side's turn, or to its end
   * when the line was its last.
   */
  function forward(c: Conversation, from: Participant, text: string, closingLine: boolean): void {
    const to = otherSide(c, from.studentId)
    const byOpener = from.studentId === c.opener.studentId
    const ending = endingOf(c, from)
    // `lastLine`: the recipient's next line is the conversation's last. A closing line has no reply at all.
    const lastLine = !closingLine && ending === null && (c.closing || (byOpener && c.round >= capOf(c)))
    const message: Static<typeof ChatIncomingMessage> = {
      type: 'chat.incoming',
      conversationId: c.id,
      from: { studentId: from.studentId, displayName: from.displayName },
      text,
      round: c.round,
      lastLine,
    }
    hub.send(to, message)
    c.opened = true

    if (ending !== null) return end(c, ending)
    if (closingLine) return end(c, 'dismissal')
    if (!byOpener) c.round++
    c.turn = to
    c.dueAt = clock.now().getTime() + replyTimeoutMs
    if (c.closing) hub.send(to, closingMessage(c.id))
  }

  async function block(line: Line, blocked: Blocked): Promise<AckResult> {
    await recordBlocked(db, discipline, line, blocked)
    const { studentId, sessionId } = line.from
    log({ studentId, sessionId, conversationId: line.conversationId, category: blocked.category }, 'chat line blocked')
    return fail('blocked', { category: blocked.category })
  }

  /**
   * Writes the reply that ends a conversation at the school's limit together with a class-rule record for each side,
   * naming the other, before it is forwarded: a line delivered always has its records. They stand if the classmate
   * leaves before it is forwarded, for the rounds were talked.
   */
  async function writeSchoolCapReply(c: Conversation, line: Line): Promise<number> {
    const { opener, sessionId } = c
    const { from, at } = line
    const rounds = (studentId: number, partnerId: number, partnerName: string) => ({
      studentId,
      sessionId,
      kind: 'rounds' as const,
      detail: { partnerId, partnerName },
      at,
    })
    return db.transaction().execute(async (trx) => {
      const id = await writeLine(trx, line, null)
      await discipline.record(trx, rounds(opener.studentId, from.studentId, from.displayName))
      await discipline.record(trx, rounds(from.studentId, opener.studentId, opener.displayName))
      return id
    })
  }

  async function initiationsLeft(p: Participant): Promise<number> {
    return Math.max(0, limits.maxInitiationsPerLesson - (await loadStarts(p)))
  }

  const markUndelivered = (id: number) =>
    db.updateTable('messages').set({ delivered: false }).where('id', '=', id).execute()

  return {
    async start(from, to, text) {
      if (!isValidText(text, limits.maxMessageChars)) return fail('invalid_message')
      if (sessionOver(from, clock.now().getTime())) return fail('not_in_session')
      if (from.lessonsAttended < limits.probationLessons) return fail('probation')
      const loaded = await loadStarts(from)
      // Someone online in the class is a classmate; anyone else is looked up, to tell "not in your class" from offline.
      const peerClass = to === from.studentId || online(from.classId, to) ? from.classId : await classOf(to)

      // From here every check and the reservation run with no await between them. The only awaits are those of a
      // refusal (recording the initiation cap, writing a stopped line), and it returns right after.
      const at = clock.now()
      const now = at.getTime()
      expire(now)
      if (sessionOver(from, now)) return fail('not_in_session')
      const s = startsOf(from)
      const used = s.count.get(from.studentId) ?? loaded
      if (used >= limits.maxInitiationsPerLesson) {
        const { studentId, sessionId } = from
        const detail = { cap: limits.maxInitiationsPerLesson }
        await discipline.record(db, { studentId, sessionId, kind: 'initiations', detail, at })
        return fail('initiation_cap')
      }
      if (to === from.studentId || peerClass !== from.classId) return fail('not_classmate')
      if (!online(from.classId, to)) return fail('peer_offline')
      if (busy.has(from.studentId)) return fail('self_busy')
      if (busy.has(to)) return fail('peer_busy')
      const verdict = moderator.check(text)
      // A stopped first line opens nothing, so it uses no start.
      if (verdict.verdict === 'blocked') {
        return block({ from, kind: 'chat', conversationId: null, recipientId: to, text, at }, verdict)
      }

      const c: Conversation = {
        id: randomUUID(),
        classId: from.classId,
        sessionId: from.sessionId,
        closeAt: from.closeAt.getTime(),
        opener: { studentId: from.studentId, displayName: from.displayName, maxRounds: from.maxRounds },
        responderId: to,
        responderMaxRounds: participants.get(to)?.maxRounds ?? null,
        round: 1,
        turn: null,
        dueAt: Infinity,
        opened: false,
        closing: false,
        ended: null,
        offline: null,
      }
      conversations.set(c.id, c)
      busy.set(from.studentId, c)
      busy.set(to, c)
      s.count.set(from.studentId, used + 1)
      const refund = () => s.count.set(from.studentId, Math.max(0, (s.count.get(from.studentId) ?? 1) - 1))

      let id: number
      try {
        id = await writeLine(db, { from, kind: 'chat', conversationId: c.id, recipientId: to, text, at }, null)
      } catch (err) {
        forget(c)
        refund()
        throw err
      }
      if (c.ended !== null) {
        // The classmate left, or the session closed, while the line was written: it opened nothing.
        refund()
        await markUndelivered(id)
        if (c.offline === to) return fail('peer_offline')
        return fail(c.ended === 'dismissal' ? 'not_in_session' : 'conversation_ended')
      }
      forward(c, from, text, false)
      log({ conversationId: c.id, sessionId: c.sessionId, from: from.studentId, to }, 'conversation started')
      return { ok: true, result: { conversationId: c.id } }
    },

    async reply(from, conversationId, text) {
      if (!isValidText(text, limits.maxMessageChars)) return fail('invalid_message')

      // From here every check and the reservation run with no await between them; only a stopped line awaits (its
      // writing), and it returns right after.
      const at = clock.now()
      expire(at.getTime())
      const c = conversations.get(conversationId)
      if (c === undefined || !isParty(c, from.studentId)) return fail('conversation_ended')
      if (c.turn !== from.studentId) return fail('not_your_turn')
      const to = otherSide(c, from.studentId)
      const closingLine = c.closing
      // The last line of the closing grace is kept as a `closing` message.
      const kind = closingLine ? 'closing' : 'chat'
      const line: Line = { from, kind, conversationId: c.id, recipientId: to, text, at }
      const verdict = moderator.check(text)
      // A stopped line changes nothing in the conversation: it is not a round, and the same side may try again.
      if (verdict.verdict === 'blocked') return block(line, verdict)

      c.turn = null
      if (from.studentId === c.responderId) c.responderMaxRounds ??= from.maxRounds
      let id: number
      try {
        id = endingOf(c, from) === 'school_cap' ? await writeSchoolCapReply(c, line) : await writeLine(db, line, null)
      } catch (err) {
        if (c.ended === null) {
          c.turn = from.studentId
          // The dismissal came while the line was on its way: its sender is the one to tell now.
          if (c.closing && !closingLine) hub.send(from.studentId, closingMessage(c.id))
        }
        throw err
      }
      if (c.ended !== null) {
        await markUndelivered(id)
        return fail(c.offline === to ? 'peer_offline' : 'conversation_ended')
      }
      forward(c, from, text, closingLine)
      return { ok: true }
    },

    // Registered before the first await: the connection layer calls this right after putting the student in the hub,
    // so no classmate can find them online without the engine knowing them.
    async join(p) {
      participants.set(p.studentId, p)
      return { initiationsLeft: await initiationsLeft(p) }
    },

    initiationsLeft,

    onDisconnect(studentId) {
      participants.delete(studentId)
      const c = busy.get(studentId)
      if (c !== undefined) end(c, 'peer_offline', studentId)
    },

    startClosing(classId) {
      const now = clock.now().getTime()
      // What was overdue before the dismissal timed out; it gets no grace.
      expire(now)
      // For the grace counted from now, which ends no earlier than the session's close: `endAll` forgets it then, and
      // should the close not come live, the class's next session still starts afresh.
      closing.set(classId, now + closingGraceMs)
      for (const c of conversations.values()) {
        if (c.classId !== classId || c.closing) continue
        c.closing = true
        // A line on its way is forwarded first; its recipient is told then.
        if (c.turn !== null) hub.send(c.turn, closingMessage(c.id))
      }
    },

    endAll(classId) {
      for (const c of [...conversations.values()]) if (c.classId === classId) end(c, 'dismissal')
      closing.delete(classId)
      for (const [sessionId, s] of starts) if (s.classId === classId) starts.delete(sessionId)
      for (const [studentId, p] of participants) if (p.classId === classId) participants.delete(studentId)
    },

    tick() {
      expire(clock.now().getTime())
    },
  }
}
