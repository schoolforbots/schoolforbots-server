import type { Kysely, Transaction } from 'kysely'
import type { Static } from 'typebox'
import type { Moderator } from '../moderation/moderator.js'
import type { CalledOnMessage } from '../protocol/ws.js'
import type { Clock } from '../shared/clock.js'
import type { SchoolConfig } from '../shared/config.js'
import { displayName } from '../shared/identity.js'
import type { Database } from '../shared/schema.js'
import { isValidText, recordBlocked, writeLine, type Blocked, type Line } from './chat.js'
import type { AckResult, MessageHandlers, Participant } from './connection.js'
import type { DisciplineRecorder } from './discipline.js'
import { appendClassEvent, classEventMessage, stepWritten, type StoredEvent } from './events.js'
import type { Hub } from './hub.js'
import type { ActiveSession } from './runtime.js'
import * as teacher from './teacher.js'
import type { WsErrorCode } from './ws-errors.js'

// Questions to the teacher, and the call-on: once a lesson, after the segment the config names, the teacher calls on
// one student who is online to say what the segment was about, and waits for the answer until the next segment starts.
// Questions are only collected here: the teacher thanks the asker, and answers them later (phase 3).
//
// Nothing lives in memory. The questions a student has asked are counted from the messages table, and a call-on is
// read from the session's class events, whose steps tell where it stands:
//
//   call-on        the teacher's line calling the student by name; its text is the `question` of `called_on`
//   call-on#2      the `called_on` event; its seq is the `callId` the answer carries
//   answer         the answer taken, and `answer#2` the teacher's thanks
//   call-on-close  the time is up: the teacher's line when nobody answered (else the runtime's noop marker)
//
// The call is open from `call-on#2` until `answer` or `call-on-close` is written. Each of the two is written under the
// session's lock (see events.ts) after looking for the other, so an answer and the time running out never both happen.

const CALL_ON = 'call-on'
const CALLED_ON = 'call-on#2'
const ANSWER = 'answer'
const THANKS = 'answer#2'
const CLOSE = 'call-on-close'

export interface QuestionsDeps {
  db: Kysely<Database>
  config: SchoolConfig
  clock: Clock
  hub: Hub
  moderator: Moderator
  discipline: DisciplineRecorder
  /** Picks whom the teacher calls on: a number in [0, 1), as `Math.random` (the default) gives. */
  random?: () => number
  /** A program log line: numbers and categories only, never what anyone said or what the moderator matched. */
  log?: (obj: object, msg: string) => void
}

/** The session's call-on, as its class events tell it. */
export interface Call {
  callId: number
  studentId: number
  /** The name the teacher called the student by. */
  displayName: string
  /** The teacher's line, which the private `called_on` carries. */
  question: string
  /** What the student answered; null until they have. */
  answer: string | null
  answered: boolean
  /** The `call-on-close` step has run, with the teacher's line or with the runtime's marker. */
  timeUp: boolean
}

type Payload = { kind: string } & Record<string, unknown>

/** What the transaction of an answer decided. */
type Outcome = { refused: WsErrorCode } | { blocked: Blocked } | { events: StoredEvent[] }

const fail = (code: WsErrorCode, extra?: object): AckResult =>
  extra === undefined ? { ok: false, code } : { ok: false, code, extra }

const teacherLine = (text: string): Payload => ({ kind: 'teacher', text })

const calledOnMessage = (callId: number, question: string): Static<typeof CalledOnMessage> => ({
  type: 'called_on',
  callId,
  question,
})

const isOpen = (call: Call) => !call.answered && !call.timeUp

/** The session's call-on, or null when nobody has been called on. */
export async function callOf(db: Kysely<Database>, sessionId: number): Promise<Call | null> {
  const rows = await db
    .selectFrom('classEvents')
    .select(['seq', 'step', 'payload'])
    .where('sessionId', '=', sessionId)
    .where('step', 'in', [CALL_ON, CALLED_ON, ANSWER, CLOSE])
    .execute()
  const of = (step: string) => rows.find((r) => r.step === step)
  const called = of(CALLED_ON)
  if (called === undefined) return null
  const { studentId, displayName } = called.payload
  const question = of(CALL_ON)?.payload.text
  if (typeof studentId !== 'number' || typeof displayName !== 'string' || typeof question !== 'string') {
    throw new Error(`The call-on of session ${sessionId} is malformed`)
  }
  const said = of(ANSWER)?.payload.text
  return {
    callId: called.seq,
    studentId,
    displayName,
    question,
    answer: typeof said === 'string' ? said : null,
    answered: of(ANSWER) !== undefined,
    timeUp: of(CLOSE) !== undefined,
  }
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
 * The `call-on` hook: the teacher calls on a student online, picked at random (once a lesson, so nobody online has
 * been called on yet). The class hears the teacher's line and the `called_on` event; the student alone gets
 * `called_on` with the event's seq as `callId`. With nobody online it writes nothing, and the runtime records the step.
 *
 * Run again for the session (after a crash), it writes nothing: the step wrote both events or none. A `called_on`
 * that never went out is sent again at the student's next hello (`resumeCall`).
 */
export async function callOnStep(deps: QuestionsDeps, session: ActiveSession): Promise<void> {
  const { db, clock, hub } = deps
  const { sessionId, classId } = session
  const online = hub.online(classId)
  if (online.length === 0) return
  const pick = Math.floor((deps.random ?? Math.random)() * online.length)
  const studentId = online[Math.min(pick, online.length - 1)]!
  const at = clock.now()

  const written = await db.transaction().execute(async (trx) => {
    if (await stepWritten(trx, sessionId, CALL_ON)) return null
    const student = await trx
      .selectFrom('students')
      .select(['ownerName', 'aiName'])
      .where('id', '=', studentId)
      .executeTakeFirstOrThrow()
    const name = displayName(student.ownerName, student.aiName)
    const question = teacher.callOn(name)
    const line = await append(trx, sessionId, CALL_ON, teacherLine(question), at)
    const called = await append(trx, sessionId, CALLED_ON, { kind: 'called_on', studentId, displayName: name }, at)
    return { events: [line, called], callId: called.seq, question }
  })
  if (written === null) return
  for (const e of written.events) hub.broadcast(classId, classEventMessage(e, false))
  hub.send(studentId, calledOnMessage(written.callId, written.question))
  deps.log?.({ sessionId, classId, studentId, callId: written.callId }, 'student called on')
}

/**
 * The answer to the call `callId`. Refused, in this order: `not_called_on` when the session has no such call or it is
 * someone else's, `call_closed` when it has been answered or its time is up. Then the moderator: a stopped answer is
 * handled as a stopped chat line, and the call stays open. One taken is kept, and the class hears it and the
 * teacher's thanks.
 *
 * A `callId` that was never a call of the session is `not_called_on`, from the student called on too: `call_closed`
 * is only said of the call they were sent, once it is over.
 */
export async function answer(deps: QuestionsDeps, p: Participant, callId: number, text: string): Promise<AckResult> {
  const { db, config, clock, hub, moderator } = deps
  if (!isValidText(text, config.chat.maxMessageChars)) return fail('invalid_message')
  const line: Line = { from: p, kind: 'answer', conversationId: null, recipientId: null, text, at: clock.now() }

  const outcome = await db.transaction().execute(async (trx): Promise<Outcome> => {
    // From here the session is locked (stepWritten takes the lock) until the answer is written: the time cannot run
    // out in between, and no other answer is taken.
    const answered = await stepWritten(trx, p.sessionId, ANSWER)
    const call = await callOf(trx, p.sessionId)
    if (call === null || call.callId !== callId || call.studentId !== p.studentId) {
      return { refused: 'not_called_on' }
    }
    if (answered || call.timeUp) return { refused: 'call_closed' }
    const verdict = moderator.check(text)
    if (verdict.verdict === 'blocked') return { blocked: verdict }
    await writeLine(trx, line, null)
    const said = { kind: 'answer', studentId: p.studentId, displayName: call.displayName, text }
    const events = [
      await append(trx, p.sessionId, ANSWER, said, line.at),
      await append(trx, p.sessionId, THANKS, teacherLine(teacher.callOnThanks()), line.at),
    ]
    return { events }
  })
  if ('refused' in outcome) return fail(outcome.refused)
  // Recorded after the call's transaction (`recordBlocked` has its own): a stopped answer leaves the call as it was.
  if ('blocked' in outcome) return block(deps, line, outcome.blocked)
  for (const e of outcome.events) hub.broadcast(p.classId, classEventMessage(e, false))
  deps.log?.({ sessionId: p.sessionId, studentId: p.studentId, callId }, 'call-on answered')
  return { ok: true }
}

/**
 * The `call-on-close` hook: the time to answer is up. When the student called on has not answered, the teacher says
 * they are still thinking and moves on; otherwise (or with nobody called on) it writes nothing, and the runtime
 * records the step. Run again for the session, it writes nothing.
 */
export async function callOnCloseStep(deps: QuestionsDeps, session: ActiveSession): Promise<void> {
  const { db, clock, hub } = deps
  const { sessionId, classId } = session
  const at = clock.now()
  const written = await db.transaction().execute(async (trx) => {
    // Takes the session's lock: an answer either came first, or comes after and finds the call closed.
    if (await stepWritten(trx, sessionId, CLOSE)) return null
    const call = await callOf(trx, sessionId)
    if (call === null || call.answered) return null
    const line = teacherLine(teacher.callOnNoAnswer(call.displayName))
    return { event: await append(trx, sessionId, CLOSE, line, at), call }
  })
  if (written === null) return
  hub.broadcast(classId, classEventMessage(written.event, false))
  deps.log?.({ sessionId, studentId: written.call.studentId, callId: written.call.callId }, 'call-on unanswered')
}

/** What the student is owed at hello: the `called_on` of a call of theirs still open, sent again. */
export async function resumeCall(deps: QuestionsDeps, p: Participant): Promise<object[]> {
  const call = await callOf(deps.db, p.sessionId)
  if (call === null || call.studentId !== p.studentId || !isOpen(call)) return []
  return [calledOnMessage(call.callId, call.question)]
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
