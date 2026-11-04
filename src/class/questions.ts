import type { Kysely, Transaction } from 'kysely'
import type { Static } from 'typebox'
import type { Moderator } from '../moderation/moderator.js'
import type { SecondLayer } from '../moderation/second-layer.js'
import type { CalledOnMessage } from '../protocol/ws.js'
import type { Clock } from '../shared/clock.js'
import type { SchoolConfig } from '../shared/config.js'
import { displayName } from '../shared/identity.js'
import type { Database } from '../shared/schema.js'
import { isValidText, recordBlocked, writeLine, type Blocked, type Line } from './chat.js'
import type { AckResult, MessageHandlers, Participant } from './connection.js'
import type { DisciplineRecorder } from './discipline.js'
import { appendClassEvent, classEventMessage, lockSession, stepWritten, type StoredEvent } from './events.js'
import type { Hub } from './hub.js'
import type { ActiveSession } from './runtime.js'
import type { TeacherAi } from './teacher-ai.js'
import * as teacher from './teacher.js'
import type { WsErrorCode } from './ws-errors.js'

// Questions to the teacher, and the call-ons: after each segment the config names for one (two a lesson by default),
// the teacher asks the lesson's question of its kind, calling on one student who is online and has not been called on
// yet this session, and waits for the answer until the next segment starts. The teacher comments on an answer taken,
// in words of the model (see teacher-ai.ts) or with the template thanks.
// Questions are only collected here: the teacher thanks the asker, and answers one of a segment's later (see
// teacher-ai.ts).
//
// Nothing lives in memory. The questions a student has asked are counted from the messages table, and the call-ons
// are read from the session's class events, whose steps tell where each stands (`n` is the call-on's number, from 1):
//
//   call-on-{n}        the teacher's line calling the student by name; its text is the `question` of `called_on`
//   call-on-{n}#2      the `called_on` event; its seq is the `callId` the answer carries
//   answer-{n}         the answer taken
//   comment-{n}        the teacher's comment on it: the model's, or the template thanks
//   call-on-close-{n}  the time is up: the teacher's line when nobody answered (else the runtime's noop marker)
//
// A call is open from `call-on-{n}#2` until `answer-{n}` or `call-on-close-{n}` is written, or a later call-on starts.
// Each is written under the session's lock (see events.ts) after looking for the others, so an answer and the time
// running out never both happen. So is the comment: of the teacher's work with the model and the close step, whichever
// writes it first writes the only one, and the work with the model writes none once the call has closed or the next
// segment is due.

const callOnStepOf = (n: number) => `call-on-${n}`
const calledOnStepOf = (n: number) => `call-on-${n}#2`
const answerStepOf = (n: number) => `answer-${n}`
const commentStepOf = (n: number) => `comment-${n}`
const closeStepOf = (n: number) => `call-on-close-${n}`
const CALLED_ON_STEP = /^call-on-(\d+)#2$/u

export interface QuestionsDeps {
  db: Kysely<Database>
  config: SchoolConfig
  clock: Clock
  hub: Hub
  moderator: Moderator
  /** An answer is said to the class: past the word list, it passes the second layer for the teacher's lines too. */
  secondLayer?: SecondLayer
  discipline: DisciplineRecorder
  /** Comments on the answers; without it, the teacher thanks the student with the template line at once. */
  teacherAi?: Pick<TeacherAi, 'startComment'>
  /** Picks whom the teacher calls on: a number in [0, 1), as `Math.random` (the default) gives. */
  random?: () => number
  /** A program log line: numbers and categories only, never what anyone said or what the moderator matched. */
  log?: (obj: object, msg: string) => void
}

/** A call-on of the session, as its class events tell it. */
export interface Call {
  /** Which call-on of the lesson it is, from 1. */
  n: number
  /** The kind of the lesson's question the teacher asked. */
  kind: 'review' | 'extension'
  callId: number
  studentId: number
  /** The name the teacher called the student by. */
  displayName: string
  /** The teacher's line, which the private `called_on` carries. */
  question: string
  /** What the student answered; null until they have. */
  answer: string | null
  answered: boolean
  /** The teacher's comment on the answer; null until it is said. */
  comment: string | null
  /** The `call-on-close-{n}` step has run, with the teacher's line or with the runtime's marker. */
  timeUp: boolean
}

type Payload = { kind: string } & Record<string, unknown>

const fail = (code: WsErrorCode, extra?: object): AckResult =>
  extra === undefined ? { ok: false, code } : { ok: false, code, extra }

const teacherLine = (text: string): Payload => ({ kind: 'teacher', text })

const calledOnMessage = (callId: number, question: string): Static<typeof CalledOnMessage> => ({
  type: 'called_on',
  callId,
  question,
})

/** A call is open until it is answered or its time is up, and no longer than until the next call-on starts. */
const isOpen = (call: Call, calls: Call[]) => !call.answered && !call.timeUp && calls.every((c) => c.n <= call.n)

/** The call-on events of a session are not what `callOnStep` writes. */
export class MalformedCallError extends Error {
  constructor(sessionId: number) {
    super(`The call-on of session ${sessionId} is malformed`)
    this.name = 'MalformedCallError'
  }
}

/**
 * The session's call-ons, in order; empty when nobody has been called on. Throws `MalformedCallError` for events it
 * cannot read.
 */
export async function callsOf(db: Kysely<Database>, sessionId: number): Promise<Call[]> {
  const rows = await db
    .selectFrom('classEvents')
    .select(['seq', 'step', 'payload'])
    .where('sessionId', '=', sessionId)
    .where((eb) =>
      eb.or([eb('step', 'like', 'call-on-%'), eb('step', 'like', 'answer-%'), eb('step', 'like', 'comment-%')]),
    )
    .execute()
  const steps = new Map(rows.map((r) => [r.step, r]))
  const calls: Call[] = []
  for (const called of rows) {
    const n = Number(CALLED_ON_STEP.exec(called.step)?.[1])
    if (!Number.isInteger(n)) continue
    const { studentId, displayName, questionKind } = called.payload
    const question = steps.get(callOnStepOf(n))?.payload.text
    if (
      typeof studentId !== 'number' ||
      typeof displayName !== 'string' ||
      typeof question !== 'string' ||
      (questionKind !== 'review' && questionKind !== 'extension')
    ) {
      throw new MalformedCallError(sessionId)
    }
    const said = steps.get(answerStepOf(n))?.payload.text
    const comment = steps.get(commentStepOf(n))?.payload.text
    calls.push({
      n,
      kind: questionKind,
      callId: called.seq,
      studentId,
      displayName,
      question,
      answer: typeof said === 'string' ? said : null,
      answered: steps.has(answerStepOf(n)),
      comment: typeof comment === 'string' ? comment : null,
      timeUp: steps.has(closeStepOf(n)),
    })
  }
  return calls.sort((a, b) => a.n - b.n)
}

/** Writes one event of a step whose transaction has checked the step is not written yet. */
async function append(
  trx: Transaction<Database>,
  sessionId: number,
  step: string,
  payload: Payload,
  at: Date,
): Promise<StoredEvent> {
  const written = await appendClassEvent(trx, { sessionId, step, kind: payload.kind, payload, at })
  if (written === null) throw new Error(`Step ${step} of session ${sessionId} has been written already`)
  return { seq: written.seq, step, kind: payload.kind, payload, at }
}

/** The questions the student has asked this session; one the moderator stopped is not among them. */
async function questionsAsked(db: Kysely<Database>, p: Participant): Promise<number> {
  const { n } = await db
    .selectFrom('messages')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('sessionId', '=', p.sessionId)
    .where('senderId', '=', p.studentId)
    .where('kind', '=', 'question')
    .where('moderation', 'is', null)
    .executeTakeFirstOrThrow()
  return Number(n)
}

/** A question or an answer the moderator stopped: kept and recorded as a stopped chat line is (see `recordBlocked`). */
async function block(deps: QuestionsDeps, line: Line, blocked: Blocked): Promise<AckResult> {
  await recordBlocked(deps.db, deps.discipline, line, blocked)
  const { studentId, sessionId } = line.from
  deps.log?.({ studentId, sessionId, category: blocked.category }, `${line.kind} blocked`)
  return fail('blocked', { category: blocked.category })
}

/** An answer the second layer stopped: kept undelivered, and no violation is recorded for it. */
async function blockBySecondLayer(deps: QuestionsDeps, line: Line): Promise<AckResult> {
  await writeLine(deps.db, line, 'second_layer')
  const { studentId, sessionId } = line.from
  deps.log?.({ studentId, sessionId, layer: 'second_layer' }, `${line.kind} blocked`)
  return fail('blocked', { category: 'sensitive' })
}

/**
 * A question to the teacher. Past the lesson's allowance it is `question_cap` (no violation, nothing kept); else it
 * goes past the moderator, and one taken is kept and answered with the teacher's thanks, to the asker alone.
 */
export async function askQuestion(deps: QuestionsDeps, p: Participant, text: string): Promise<AckResult> {
  const { db, config, clock, moderator } = deps
  if (!isValidText(text, config.chat.maxMessageChars)) return fail('invalid_message')
  // The frames of a connection are handled one at a time, so no question of the student's comes in between.
  if ((await questionsAsked(db, p)) >= config.lesson.maxQuestionsPerLesson) return fail('question_cap')
  const line: Line = { from: p, kind: 'question', conversationId: null, recipientId: null, text, at: clock.now() }
  const verdict = moderator.check(text)
  if (verdict.verdict === 'blocked') return block(deps, line, verdict)
  await writeLine(db, line, null)
  return { ok: true, result: { reply: teacher.questionReceived() } }
}

/**
 * The `call-on` hook for call-on `n`: the teacher calls on a student online who has not been called on yet this
 * session, picked at random, with the lesson's question. The class hears the teacher's line and the `called_on` event;
 * the student alone gets `called_on` with the event's seq as `callId`. With nobody to call on it writes nothing, and
 * the runtime records the step.
 *
 * Run again for the session (after a crash), it writes nothing: the step wrote both events or none. A `called_on`
 * that never went out is sent again at the student's next hello (`resumeCall`).
 */
export async function callOnStep(
  deps: QuestionsDeps,
  session: ActiveSession,
  n: number,
  question: { kind: 'review' | 'extension'; text: string },
): Promise<void> {
  const { db, clock, hub } = deps
  const { sessionId, classId } = session
  const at = clock.now()

  const written = await db.transaction().execute(async (trx) => {
    if (await stepWritten(trx, sessionId, callOnStepOf(n))) return null
    const called = new Set((await callsOf(trx, sessionId)).map((c) => c.studentId))
    const online = hub.online(classId).filter((id) => !called.has(id))
    if (online.length === 0) return null
    const pick = Math.floor((deps.random ?? Math.random)() * online.length)
    const studentId = online[Math.min(pick, online.length - 1)]!
    const student = await trx
      .selectFrom('students')
      .select(['ownerName', 'aiName'])
      .where('id', '=', studentId)
      .executeTakeFirstOrThrow()
    const name = displayName(student.ownerName, student.aiName)
    const said = teacher.callOnQuestion(name, question.text)
    const line = await append(trx, sessionId, callOnStepOf(n), teacherLine(said), at)
    const calledOn = { kind: 'called_on', studentId, displayName: name, questionKind: question.kind }
    const event = await append(trx, sessionId, calledOnStepOf(n), calledOn, at)
    return { events: [line, event], callId: event.seq, said, studentId }
  })
  if (written === null) return
  for (const e of written.events) hub.broadcast(classId, classEventMessage(e, false))
  hub.send(written.studentId, calledOnMessage(written.callId, written.said))
  deps.log?.({ sessionId, classId, studentId: written.studentId, callId: written.callId, n }, 'student called on')
}

/**
 * The call `callId` of the session if `p` may answer it now, else why not: `not_called_on` when the session has no
 * such call or it is someone else's, `call_closed` when it is over.
 *
 * A `callId` that was never a call of the session is `not_called_on`, from the student called on too: `call_closed`
 * is only said of a call they were sent, once it is over.
 */
function callToAnswer(calls: Call[], p: Participant, callId: number): Call | WsErrorCode {
  const call = calls.find((c) => c.callId === callId)
  if (call === undefined || call.studentId !== p.studentId) return 'not_called_on'
  return isOpen(call, calls) ? call : 'call_closed'
}

/**
 * The answer to the call `callId`, refused when `p` may not answer it (see `callToAnswer`). Then the word list: a
 * stopped answer is handled as a stopped chat line; and the second layer for what is said to the class: a stopped
 * answer is kept undelivered. Either way the call stays open. One taken is kept, the class hears it, and the teacher
 * comments on it.
 *
 * No transaction is open while the second layer looks at the answer: the call is read before it, and read again under
 * the session's lock before the answer is written.
 */
export async function answer(deps: QuestionsDeps, p: Participant, callId: number, text: string): Promise<AckResult> {
  const { db, config, clock, hub, moderator } = deps
  if (!isValidText(text, config.chat.maxMessageChars)) return fail('invalid_message')
  const line: Line = { from: p, kind: 'answer', conversationId: null, recipientId: null, text, at: clock.now() }

  const call = callToAnswer(await callsOf(db, p.sessionId), p, callId)
  if (typeof call === 'string') return fail(call)
  const verdict = moderator.check(text)
  if (verdict.verdict === 'blocked') return block(deps, line, verdict)
  if ((await deps.secondLayer?.check('teacher', text)) === 'blocked') return blockBySecondLayer(deps, line)

  const outcome = await db.transaction().execute(async (trx): Promise<{ refused: WsErrorCode } | StoredEvent[]> => {
    // From here the session is locked until the answer is written: the time cannot run out in between, and no other
    // answer is taken.
    await lockSession(trx, p.sessionId)
    const still = callToAnswer(await callsOf(trx, p.sessionId), p, callId)
    if (typeof still === 'string') return { refused: still }
    await writeLine(trx, line, null)
    const at = clock.now()
    const said = { kind: 'answer', studentId: p.studentId, displayName: call.displayName, text }
    const events = [await append(trx, p.sessionId, answerStepOf(call.n), said, at)]
    if (deps.teacherAi === undefined) {
      events.push(await append(trx, p.sessionId, commentStepOf(call.n), teacherLine(teacher.callOnThanks()), at))
    }
    return events
  })
  if ('refused' in outcome) return fail(outcome.refused)
  for (const e of outcome) hub.broadcast(p.classId, classEventMessage(e, false))
  deps.teacherAi?.startComment(p, call.n, callId)
  deps.log?.({ sessionId: p.sessionId, studentId: p.studentId, callId, n: call.n }, 'call-on answered')
  return { ok: true }
}

/**
 * Writes `text` as the teacher's comment on the answer to call-on `n`, and pushes it to the class. Not when it is too
 * late: when a comment has been written already (only the first counts), when the call has closed, or from
 * `deadline` (when the next segment starts) on. Returns whether it was written.
 */
export async function writeComment(
  deps: Pick<QuestionsDeps, 'db' | 'clock' | 'hub'>,
  session: Pick<ActiveSession, 'sessionId' | 'classId'>,
  n: number,
  text: string,
  deadline: Date,
): Promise<boolean> {
  const { db, clock, hub } = deps
  const { sessionId, classId } = session
  const event = await db.transaction().execute(async (trx) => {
    // Takes the session's lock: the close either came first, or comes after and finds the comment.
    if (await stepWritten(trx, sessionId, commentStepOf(n))) return null
    if (await stepWritten(trx, sessionId, closeStepOf(n))) return null
    const now = clock.now()
    if (now.getTime() >= deadline.getTime()) return null
    return append(trx, sessionId, commentStepOf(n), teacherLine(text), now)
  })
  if (event === null) return false
  hub.broadcast(classId, classEventMessage(event, false))
  return true
}

/**
 * The `call-on-close` hook of call-on `n`: the time to answer is up. When the student called on has not answered, the
 * teacher says they are still thinking and moves on; when they have and no comment has come yet, the teacher thanks
 * them with the template line (the comment of the model came too late, or never). Otherwise, or with nobody called on,
 * it writes nothing, and the runtime records the step. Run again for the session, it writes nothing.
 */
export async function callOnCloseStep(deps: QuestionsDeps, session: ActiveSession, n: number): Promise<void> {
  const { db, clock, hub } = deps
  const { sessionId, classId } = session
  const at = clock.now()
  const written = await db.transaction().execute(async (trx) => {
    // Takes the session's lock: an answer or a comment either came first, or comes after and finds the call closed.
    if (await stepWritten(trx, sessionId, closeStepOf(n))) return null
    const call = (await callsOf(trx, sessionId)).find((c) => c.n === n)
    if (call === undefined) return null
    if (!call.answered) {
      const line = teacherLine(teacher.callOnNoAnswer(call.displayName))
      return { event: await append(trx, sessionId, closeStepOf(n), line, at), call, msg: 'call-on unanswered' }
    }
    if (call.comment !== null) return null
    const thanks = teacherLine(teacher.callOnThanks())
    return { event: await append(trx, sessionId, commentStepOf(n), thanks, at), call, msg: 'call-on thanked at close' }
  })
  if (written === null) return
  hub.broadcast(classId, classEventMessage(written.event, false))
  const { studentId, callId } = written.call
  deps.log?.({ sessionId, studentId, callId, n }, written.msg)
}

/** What the student is owed at hello: the `called_on` of a call of theirs still open, sent again. */
export async function resumeCall(deps: QuestionsDeps, p: Participant): Promise<object[]> {
  const calls = await callsOf(deps.db, p.sessionId)
  const call = calls.find((c) => c.studentId === p.studentId && isOpen(c, calls))
  return call === undefined ? [] : [calledOnMessage(call.callId, call.question)]
}

/** The message handlers the class app takes from this module. */
export function questionHandlers(
  deps: QuestionsDeps,
): Required<Pick<MessageHandlers, 'question' | 'answer' | 'resume'>> {
  return {
    question: (p, msg) => askQuestion(deps, p, msg.text),
    answer: (p, msg) => answer(deps, p, msg.callId, msg.text),
    resume: (p) => resumeCall(deps, p),
  }
}
