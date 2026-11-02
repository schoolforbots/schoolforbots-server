import type { FastifyBaseLogger } from 'fastify'
import type { Selectable } from 'kysely'
import type { Static } from 'typebox'
import { Value } from 'typebox/value'
import type { RawData, WebSocket } from 'ws'
import {
  ClientMessage,
  type AckMessage,
  type AnswerMessage,
  type ChatReplyMessage,
  type ChatStartMessage,
  type ClosingMessage,
  type HelloMessage,
  type PresenceMessage,
  type QuestionMessage,
  type WelcomeMessage,
} from '../protocol/ws.js'
import { MEMBER_STATUSES } from '../shared/db.js'
import { className, displayName } from '../shared/identity.js'
import { addDaysToDate, atLocalTime, localDate, localMoment } from '../shared/local-time.js'
import type { Database, StudentStatus } from '../shared/schema.js'
import type { ClassDeps } from './app.js'
import { lessonsAttendedBefore, markAttendance } from './attendance.js'
import { classEventMessage, eventsAfter } from './events.js'
import type { HubConnection } from './hub.js'
import type { ActiveSession } from './runtime.js'
import { WS_ERROR_MESSAGES, type WsErrorCode } from './ws-errors.js'

// One student's WebSocket connection to the class, from the upgrade to the close: the checks at the door, hello (and
// its deadline), attendance, welcome, the replay of the class events missed and of what the student is still owed (an
// open call-on), presence, handing each later message to its handler, and the pings that find a client gone.
// Frames of one connection are handled one at a time, in the order they came.

export type StudentRow = Selectable<Database['students']>

/** A student in the class, as the handlers of their messages see them. Built at hello. */
export interface Participant {
  readonly studentId: number
  readonly displayName: string
  readonly classId: number
  readonly sessionId: number
  /** The most rounds the student's plugin holds a conversation for, as its hello said. */
  readonly maxRounds: number
  /** The address the connection came from; null when it is not known. */
  readonly ip: string | null
  readonly pluginType: string
  readonly pluginVersion: string
  /** The lessons the student attended before this session (the probation baseline), whatever this hello recorded. */
  readonly lessonsAttended: number
  /** The session's close, at the end of its closing grace: the student's conversations end then at the latest. */
  readonly closeAt: Date
}

/** What a handler answers; the connection turns it into the `ack` and adds the Chinese `message` for a failure. */
export type AckResult = { ok: true; result?: object } | { ok: false; code: WsErrorCode; extra?: object }

/** What the messages after hello do. Each runs while the student's session is on. */
export interface MessageHandlers {
  chatStart(p: Participant, msg: Static<typeof ChatStartMessage>): Promise<AckResult>
  chatReply(p: Participant, msg: Static<typeof ChatReplyMessage>): Promise<AckResult>
  question(p: Participant, msg: Static<typeof QuestionMessage>): Promise<AckResult>
  answer(p: Participant, msg: Static<typeof AnswerMessage>): Promise<AckResult>
  /**
   * The student joined the class: registers them with the handlers, which may need them before they say anything (a
   * conversation's limit needs the responder's `maxRounds`), and answers what the welcome needs. Called at every hello
   * right after the connection is put in the hub, with no await in between, so nobody can find the student online
   * before the handlers know them. Missing: the whole allowance of starts.
   */
  join?(p: Participant): Promise<{ initiationsLeft: number }>
  /**
   * What the student is owed privately when they join, read after the replay and written right after it: what the
   * handlers sent them before and still stands, such as the `called_on` of a call-on they have not answered (they
   * reconnected since, or the service stopped before it went out). Whatever the hub pushed meanwhile comes after it,
   * so a call that closes during the hello is closed after it is sent; a message pushed meanwhile that is the same as
   * one of these is not sent twice. Missing: nothing is owed.
   */
  resume?(p: Participant): Promise<object[]>
}

/** What the connections of one app share. */
export interface ConnectionContext {
  deps: ClassDeps
  /**
   * The connections whose student the classmates have been told is online: by a `presence { joined }`, or because the
   * connection replaced one that had been. A student whose connection is replaced never left, so nobody is told.
   */
  announced: WeakSet<HubConnection>
}

type Closing = Static<typeof ClosingMessage>
type Presence = Static<typeof PresenceMessage>
type Classmate = Static<typeof WelcomeMessage>['student']

/** The longest id an ack echoes (the protocol's limit); a frame without a valid id is answered with an empty one. */
const MAX_ID = 64

/**
 * The most a frame may carry, in bytes, as the protocol says. A bigger one is answered `invalid_message` and the
 * connection stays open; `ws` closes the connection only past its own, higher ceiling (see app.ts).
 */
export const MAX_FRAME_BYTES = 16 * 1024

/** How long a connection has to send a valid hello, by default (see `ClassDeps.helloTimeoutMs`). */
export const HELLO_TIMEOUT_MS = 10_000

/** How often a connection is pinged, by default (see `ClassDeps.pingIntervalMs`). */
export const PING_INTERVAL_MS = 30_000

const closing = (reason: Closing['reason'], message: string): Closing => ({ type: 'closing', reason, message })
const REPLACED = closing('replaced', '这个学号在别的地方连上了，这里的连接已经断开。')
const HELLO_TIMEOUT = closing('session_over', '连上以后没有及时收到 hello，连接已经断开。')

/** What a student with no class is told, by status. */
function noClassMessage(status: StudentStatus): string {
  if (status === 'dropped') return '你已经退学，不在任何班级里了，重新报名分班后才能来上课。'
  if (status === 'expelled') return '你已经被开除，不在任何班级里了。'
  return '你还没有分班，分到班级后才能来上课。'
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const typeOf = (message: object): unknown => (message as { type?: unknown }).type

function frameBytes(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((n, chunk) => n + chunk.length, 0)
  return Buffer.isBuffer(data) ? data.length : data.byteLength
}

function frameText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8')
}

function ackMessage(id: string, r: AckResult): Static<typeof AckMessage> {
  if (r.ok) {
    return r.result === undefined ? { type: 'ack', id, ok: true } : { type: 'ack', id, ok: true, result: r.result }
  }
  // code and message come last, so the extra fields can never replace them
  return { type: 'ack', id, ok: false, error: { ...r.extra, code: r.code, message: WS_ERROR_MESSAGES[r.code] } }
}

const fail = (code: WsErrorCode): AckResult => ({ ok: false, code })

/**
 * Serves one connection whose key belongs to `student` (the upgrade checked it). A student who may not come in now
 * (suspended, in no class, or outside the session's doors-to-close) gets a `closing` saying why and is disconnected.
 */
export function serveConnection(
  ctx: ConnectionContext,
  socket: WebSocket,
  p: { student: StudentRow; ip: string | null; log: FastifyBaseLogger },
): void {
  const { deps, announced } = ctx
  const { db, config, clock, runtime, hub } = deps
  const { student, ip, log } = p
  const studentId = student.id

  // Set at hello, when the connection is registered in the hub.
  let participant: Participant | null = null
  let registered = false
  // Set when the connection is over (see `leave`).
  let left = false
  // From the moment the connection is registered until the welcome and the replay are out, what the hub sends waits
  // here, so that nothing pushed meanwhile comes before the welcome, goes missing or comes twice. A `closing` does not
  // wait: it is the last message, and the connection closes right after it.
  let pending: object[] | null = null
  // The transport's timers, on real time (see `ClassDeps`): the deadline for hello, and the pings. Both stop when the
  // connection is over.
  let helloTimer: NodeJS.Timeout | undefined
  let pingTimer: NodeJS.Timeout | undefined
  const stopTimers = (): void => {
    clearTimeout(helloTimer)
    clearInterval(pingTimer)
  }

  const write = (message: object): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
  }
  // The server closing the connection: the student is gone from this moment, not only once the client has answered
  // the close (which may take until `ws` gives up waiting, if the client has vanished).
  const closeSocket = (code: number): void => {
    stopTimers()
    socket.close(code)
    leave()
  }
  // A client that no longer answers is not waited for: the connection is torn down without a close handshake.
  const dropSocket = (): void => {
    stopTimers()
    socket.terminate()
    leave()
  }
  const sendClosing = (message: Closing): void => {
    write(message)
    closeSocket(1000)
  }

  /** Outside a session: the next starts at today's start of the student's slot if that is to come, else tomorrow's. */
  const outsideSession = (): Closing => {
    const now = clock.now()
    const { start } = config.slots[student.slot]
    const today = localDate(now, config.timezone)
    const todays = atLocalTime(today, start, config.timezone)
    const next =
      todays.getTime() > now.getTime() ? todays : atLocalTime(addDaysToDate(today, 1), start, config.timezone)
    return closing('session_over', `现在不在上课时间，下一节课在 ${localMoment(next, config.timezone)} 开始。`)
  }

  // ---- At the door ----

  /** The student's class, or why the student may not come in now. */
  const atTheDoor = (): { classId: number } | { refusal: Closing } => {
    const until = student.suspendedUntil
    if (student.status === 'suspended' && (until === null || until.getTime() > clock.now().getTime())) {
      const message =
        until === null ? '你正在停课，暂时不能来上课。' : `你正在停课，${localMoment(until, config.timezone)} 以后才能回来上课。`
      return { refusal: closing('suspended', message) }
    }
    if (student.classId === null || !(MEMBER_STATUSES as readonly StudentStatus[]).includes(student.status)) {
      return { refusal: closing('session_over', noClassMessage(student.status)) }
    }
    if (runtime.currentSession(student.classId) === null) return { refusal: outsideSession() }
    return { classId: student.classId }
  }
  const door = atTheDoor()
  if ('refusal' in door) {
    log.info({ studentId, reason: door.refusal.reason }, 'class connection refused')
    sendClosing(door.refusal)
    return
  }
  const { classId } = door

  // ---- The transport ----

  // A connection that says nothing holds a socket for nothing. A valid hello stops this (see `onFrame`).
  helloTimer = setTimeout(() => {
    if (socket.readyState !== socket.OPEN) return
    log.info({ studentId }, 'class connection sent no hello in time')
    sendClosing(HELLO_TIMEOUT)
  }, deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS)

  // A client gone without a close (a dead network, a frozen process) answers no pings: one that has not answered the
  // previous ping by the next is dropped, and the student leaves as after any other close.
  let answered = true
  socket.on('pong', () => {
    answered = true
  })
  pingTimer = setInterval(() => {
    if (socket.readyState !== socket.OPEN) return
    if (!answered) {
      log.info({ studentId }, 'class connection stopped answering pings')
      dropSocket()
      return
    }
    answered = false
    socket.ping()
  }, deps.pingIntervalMs ?? PING_INTERVAL_MS)

  // ---- The connection as the hub sees it ----

  const connection: HubConnection = {
    studentId,
    classId,
    send(message) {
      if (pending !== null && typeOf(message) !== 'closing') pending.push(message)
      else write(message)
    },
    close() {
      closeSocket(1000)
    },
  }

  const classmateOf = (x: Participant): Classmate => ({ studentId: x.studentId, displayName: x.displayName })

  // ---- hello ----

  async function onHello(hello: Static<typeof HelloMessage>): Promise<void> {
    const session = runtime.currentSession(classId)
    if (session === null) {
      sendClosing(outsideSession())
      return
    }
    const { sessionId } = session

    // The baseline is read before this hello's attendance is recorded (R8), and leaves out this session if an earlier
    // connection already recorded it, so a reconnect does not end the probation in the middle of a lesson.
    const lessonsAttended = await lessonsAttendedBefore(db, { sessionId, studentId })
    await markAttendance(db, { sessionId, studentId, at: clock.now() })
    const me: Participant = {
      studentId,
      displayName: displayName(student.ownerName, student.aiName),
      classId,
      sessionId,
      maxRounds: hello.maxRounds,
      ip,
      pluginType: hello.plugin.type,
      pluginVersion: hello.plugin.version,
      lessonsAttended,
      closeAt: session.closeAt,
    }
    // The client may have gone while the attendance was written; a closed connection must never be registered.
    if (socket.readyState !== socket.OPEN) return
    // Nor may one join a session that closed meanwhile: its close may already have disconnected everyone it found in
    // the hub, so a connection registered now would stay behind it. Checked right before registering, with no await in
    // between, so a close that comes later finds this connection and disconnects it.
    if (runtime.currentSession(classId)?.sessionId !== sessionId) {
      sendClosing(outsideSession())
      return
    }

    pending = []
    const replaced = hub.add(connection)
    // Right after the hub, with no await in between (see `MessageHandlers.join`).
    const joined = deps.handlers?.join?.(me)
    registered = true
    participant = me
    if (replaced !== undefined) {
      if (announced.has(replaced)) announced.add(connection)
      replaced.send(REPLACED)
      replaced.close()
    }

    const welcome = await buildWelcome(me, session, joined)
    const events = await eventsAfter(db, sessionId, hello.lastSeq ?? 0)
    // After the replay is read, so it knows at least as much as the replay (see `MessageHandlers.resume`).
    const owed = (await deps.handlers?.resume?.(me)) ?? []
    // Closed meanwhile (by the client, or by the session's close): the close handler has done the rest.
    if (socket.readyState !== socket.OPEN) return

    write(ackMessage(hello.id, { ok: true }))
    write(welcome)
    let seen = hello.lastSeq ?? 0
    for (const e of events) {
      write(classEventMessage(e, true))
      seen = Math.max(seen, e.seq)
    }
    for (const m of owed) write(m)
    const resent = new Set(owed.map((m) => JSON.stringify(m)))
    const queued = pending
    pending = null
    for (const m of queued) {
      // An event pushed while the replay was read is in the replay already.
      const seq = (m as { seq?: unknown }).seq
      if (typeOf(m) === 'class.event' && typeof seq === 'number' && seq <= seen) continue
      // As is a private message pushed while what was owed was read.
      if (resent.has(JSON.stringify(m))) continue
      write(m)
    }

    if (!announced.has(connection)) {
      announced.add(connection)
      const presence: Presence = { type: 'presence', joined: classmateOf(me) }
      for (const other of hub.online(classId)) if (other !== studentId) hub.send(other, presence)
    }
    log.info({ studentId, classId, sessionId, replaced: replaced !== undefined }, 'student joined class')
  }

  async function buildWelcome(
    me: Participant,
    session: ActiveSession,
    joined: Promise<{ initiationsLeft: number }> | undefined,
  ): Promise<Static<typeof WelcomeMessage>> {
    const others = hub.online(classId).filter((id) => id !== studentId)
    const [online, classRow, lesson, { initiationsLeft }] = await Promise.all([
      others.length === 0
        ? []
        : db
            .selectFrom('students')
            .select(['id', 'ownerName', 'aiName'])
            .where('id', 'in', others)
            .orderBy('id')
            .execute(),
      db
        .selectFrom('classes')
        .select(['division', 'slot', 'classNo', 'teacherPersonaId'])
        .where('id', '=', classId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('classSessions as s')
        .leftJoin('lessons as l', 'l.id', 's.lessonId')
        .select(['l.subject', 'l.title'])
        .where('s.id', '=', session.sessionId)
        .executeTakeFirstOrThrow(),
      // The chat engine counts the conversations already started this session.
      joined ?? { initiationsLeft: config.chat.maxInitiationsPerLesson },
    ])
    // As the runtime does: a teacher the config no longer lists is just 老师.
    const teacher = config.teacherPersonas.find((t) => t.id === classRow.teacherPersonaId)?.name ?? '老师'
    return {
      type: 'welcome',
      student: classmateOf(me),
      class: {
        classId,
        className: className(classRow.division, classRow.slot, classRow.classNo, config),
        teacher: { name: teacher },
      },
      session: {
        sessionId: session.sessionId,
        kind: session.kind,
        startsAt: session.startsAt.toISOString(),
        endsAt: session.endsAt.toISOString(),
        subject: lesson.subject ?? null,
        title: lesson.title ?? null,
      },
      online: online.map((s) => ({ studentId: s.id, displayName: displayName(s.ownerName, s.aiName) })),
      limits: {
        maxInitiationsPerLesson: config.chat.maxInitiationsPerLesson,
        initiationsLeft,
        maxRoundsPerConversation: config.chat.maxRoundsPerConversation,
        maxMessageChars: config.chat.maxMessageChars,
        maxQuestionsPerLesson: config.lesson.maxQuestionsPerLesson,
        // The grace the runtime's timeline gives, so it is scaled with the timeline speed like the close itself.
        closingGraceSeconds: (session.closeAt.getTime() - session.endsAt.getTime()) / 1000,
      },
      probation: me.lessonsAttended < config.chat.probationLessons,
    }
  }

  // ---- Every frame ----

  async function dispatch(
    me: Participant,
    msg: Exclude<Static<typeof ClientMessage>, { type: 'hello' }>,
  ): Promise<AckResult> {
    const handlers = deps.handlers ?? {}
    const missing = fail('invalid_message')
    switch (msg.type) {
      case 'chat.start':
        return handlers.chatStart === undefined ? missing : handlers.chatStart(me, msg)
      case 'chat.reply':
        return handlers.chatReply === undefined ? missing : handlers.chatReply(me, msg)
      case 'question':
        return handlers.question === undefined ? missing : handlers.question(me, msg)
      case 'answer':
        return handlers.answer === undefined ? missing : handlers.answer(me, msg)
    }
  }

  async function onFrame(data: RawData): Promise<void> {
    if (socket.readyState !== socket.OPEN) return
    const reply = (id: string, r: AckResult) => write(ackMessage(id, r))

    if (frameBytes(data) > MAX_FRAME_BYTES) return reply('', fail('invalid_message'))
    let frame: unknown
    try {
      frame = JSON.parse(frameText(data))
    } catch {
      return reply('', fail('invalid_message'))
    }
    const id = isObject(frame) && typeof frame.id === 'string' && frame.id.length <= MAX_ID ? frame.id : ''
    // Looked at before the schema, whose literal 'v1' would make any other protocol just an invalid message.
    if (isObject(frame) && frame.type === 'hello' && frame.protocol !== 'v1') {
      return reply(id, fail('protocol_unsupported'))
    }
    if (!Value.Check(ClientMessage, frame)) return reply(id, fail('invalid_message'))

    const msg = frame
    if (msg.type === 'hello') {
      if (participant !== null) return reply(msg.id, fail('invalid_message'))
      // In time: the deadline is met, however long the hello takes and whatever it leads to (the student joins, or is
      // told why not and disconnected).
      clearTimeout(helloTimer)
      return onHello(msg)
    }
    const me = participant
    if (me === null) return reply(msg.id, fail('hello_required'))
    const current = runtime.currentSession(classId)
    if (current === null || current.sessionId !== me.sessionId) return reply(msg.id, fail('not_in_session'))
    reply(msg.id, await dispatch(me, msg))
  }

  // Attached before anything is awaited, so no frame is missed.
  let queue = Promise.resolve()
  socket.on('message', (data) => {
    queue = queue
      .then(() => onFrame(data))
      .catch((err: unknown) => {
        // Only what kind of frame failed is logged, never what it said.
        log.error({ err, studentId }, 'class connection frame failed')
        closeSocket(1011)
      })
  })

  socket.on('close', () => {
    stopTimers()
    leave()
  })

  /**
   * The connection is over, whoever closed it; runs once. Only the student going offline counts: a connection
   * replaced by a newer one is not the student leaving. Classmates are told only while the session is on: at its
   * close everyone goes at once, and nobody is left to tell.
   */
  function leave(): void {
    if (left || !registered || participant === null) return
    left = true
    if (!hub.remove(connection)) return
    log.info({ studentId, classId }, 'student left class')
    try {
      deps.hooks.onDisconnect(studentId)
    } catch (err) {
      log.error({ err, studentId }, 'onDisconnect hook failed')
    }
    const current = runtime.currentSession(classId)
    if (announced.has(connection) && current !== null && current.sessionId === participant.sessionId) {
      const presence: Presence = { type: 'presence', left: classmateOf(participant) }
      hub.broadcast(classId, presence)
    }
  }
}
