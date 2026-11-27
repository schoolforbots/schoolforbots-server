import type { FastifyBaseLogger } from 'fastify'
import type { Static } from 'typebox'
import { Value } from 'typebox/value'
import type { RawData, WebSocket } from 'ws'
import type { RateWindow } from '../shared/rate-window.js'
import {
  type ClubAckMessage,
  ClubClientMessage,
  type ClubHelloMessage,
  type ClubWelcomeMessage,
} from '../protocol/club.js'
import type { ClubDeps } from './app.js'
import {
  type ClubAction,
  type Rejoin,
  clubClosedClosing,
  HELLO_TIMEOUT,
  maintenanceClosing,
  REPLACED,
  SERVICE_STOPPING,
  studentRefusal,
} from './club.js'
import { clubClosedAt } from './hours.js'
import type { ClubClosing, HubConnection } from './hub.js'
import type { AckResult } from './game.js'
import type { InviteTargets } from './invites.js'
import { GONE_STANDING, memberEmails, standingsAmong } from './members.js'
import type { ServerMessage } from './outbox.js'
import { studentPersonWithClass } from './people.js'
import type { ClubStudent } from './rooms.js'
import { CLUB_WS_ERROR_MESSAGES, type ClubWsErrorCode } from './ws-errors.js'

// One student's WebSocket connection to the club, from the upgrade to the close, written after the class service's
// (src/class/connection.ts, which it does not share code with): hello (and its deadline), the checks at the door,
// welcome, what a student who comes back is owed (the room events they missed, their hand and turn, the invitations
// waiting for them), handing each later message to the club, and the pings that find a client gone. Frames of one
// connection are handled one at a time, in the order they came.
//
// Every client message is answered with its `ack` first, and then what handling it sent the student (see outbox.ts):
// while the club handles a message, what comes for this connection is held, and sent right after the ack.
//
// What a connection may cost is bounded as in the class (`club.connection` in the school config): the frames its student
// may send in any minute, over all their connections, the frames it may have waiting to be handled, and what may wait
// to go out to it.

type Hello = Static<typeof ClubHelloMessage>
type Welcome = Static<typeof ClubWelcomeMessage>

// The transport's numbers are the class's (src/class/connection.ts), written again here rather than imported: the
// class connection's module would bring the class service's code with it. (The club service does import two modules
// of the class service that depend on nothing of it: src/class/ticker.ts, and src/class/timeline.ts through the
// maintenance switch.)

/** The most a frame may carry, in bytes; a bigger one is answered `invalid_message` and the connection stays open. */
export const MAX_FRAME_BYTES = 16 * 1024

/** How long a connection has to send a valid hello, by default (see `ClubDeps.helloTimeoutMs`). */
export const HELLO_TIMEOUT_MS = 10_000

/** How often a connection is pinged, by default (see `ClubDeps.pingIntervalMs`). */
export const PING_INTERVAL_MS = 30_000

/** The window `club.connection.framesPerMinute` counts the frames in, by default (see `ClubDeps.rateWindowMs`). */
export const RATE_WINDOW_MS = 60_000

/** The longest id an ack echoes (the protocol's limit); a frame without a valid id is answered with an empty one. */
const MAX_ID = 64

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function frameBytes(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((n, chunk) => n + chunk.length, 0)
  return Buffer.isBuffer(data) ? data.length : data.byteLength
}

function frameText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8')
}

type Ack = Static<typeof ClubAckMessage>

// The results are the club's (a `RoomResult`, a `QuickJoinResult`, a `TurnResult`), which the types do not follow.
function ackMessage(id: string, r: AckResult): Ack {
  if (r.ok) {
    const ack = r.result === undefined ? { type: 'ack', id, ok: true } : { type: 'ack', id, ok: true, result: r.result }
    return ack as Ack
  }
  // code and message come last, so the extra fields can never replace them
  return {
    type: 'ack',
    id,
    ok: false,
    error: { ...r.extra, code: r.code, message: CLUB_WS_ERROR_MESSAGES[r.code] },
  } as Ack
}

const fail = (code: ClubWsErrorCode): AckResult => ({ ok: false, code })

/**
 * Why nobody may come in now, as the `closing` that says so, or null: the service stopping, then the clubs switched
 * off or closed by the timetable, then maintenance.
 */
export function clubDoor(deps: ClubDeps, now: Date): ClubClosing | null {
  if (deps.stopping?.() === true) return SERVICE_STOPPING
  const enabled = deps.clubEnabled?.() ?? deps.config.club.enabled
  if (!enabled) return clubClosedClosing(null, deps.config)
  const closed = (deps.closedAt ?? ((at: Date) => clubClosedAt(deps.config, at)))(now)
  if (closed.closed) return clubClosedClosing(closed.reopensAt, deps.config)
  const m = deps.maintenance?.() ?? null
  return m === null ? null : maintenanceClosing(m)
}

/**
 * Serves one connection whose key belongs to the student `studentId` (the upgrade checked it), from `ip` (null when
 * not known), which only the game is told (see `SessionStart.addresses`): it is never sent to anyone, nor logged by
 * the club code. `frames` counts the frames of every student over all their connections, the app's one for all (see
 * `buildClubApp`).
 */
export function serveConnection(
  deps: ClubDeps,
  socket: WebSocket,
  p: { studentId: number; ip: string | null; log: FastifyBaseLogger; frames: RateWindow<number> },
): void {
  const { db, config, clock, club } = deps
  const { studentId, ip, log, frames } = p
  const limits = config.club.connection
  const maxSendBufferBytes = limits.maxSendBufferKiB * 1024

  // Set at hello, when the connection is registered in the hub.
  let me: ClubStudent | null = null
  let registered = false
  // Set when the connection is over (see `leave`).
  let left = false
  // While the club handles a message of this connection, what is sent to it waits here, to go out after the ack.
  let held: ServerMessage[] | null = null
  // Set when more waits to go out than `maxSendBufferKiB`: nothing more is written, and the connection is dropped.
  let overflowed = false
  // The transport's timers, on real time: the deadline for hello, and the pings. Both stop when the connection is over.
  let helloTimer: NodeJS.Timeout | undefined
  let pingTimer: NodeJS.Timeout | undefined
  const stopTimers = (): void => {
    clearTimeout(helloTimer)
    clearInterval(pingTimer)
  }

  const overflow = (): void => {
    if (overflowed) return
    overflowed = true
    log.info({ studentId, bufferedBytes: socket.bufferedAmount }, 'club connection fell behind')
    setImmediate(dropSocket)
  }
  const write = (message: object): void => {
    if (socket.readyState !== socket.OPEN || overflowed) return
    socket.send(JSON.stringify(message))
    if (socket.bufferedAmount > maxSendBufferBytes) overflow()
  }
  // The server closing the connection: the student is gone from this moment, not only once the client has answered.
  const closeSocket = (code: number): void => {
    stopTimers()
    socket.close(code)
    leave()
  }
  const dropSocket = (): void => {
    stopTimers()
    socket.terminate()
    leave()
  }
  const sendClosing = (message: ClubClosing): void => {
    write(message)
    closeSocket(1000)
  }

  const connection: HubConnection = {
    studentId,
    send(message) {
      if (held !== null) held.push(message)
      else write(message)
    },
    close(message) {
      sendClosing(message)
    },
  }

  // ---- The transport ----

  helloTimer = setTimeout(() => {
    if (socket.readyState !== socket.OPEN) return
    log.info({ studentId }, 'club connection sent no hello in time')
    sendClosing(HELLO_TIMEOUT)
  }, deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS)

  let answered = true
  socket.on('pong', () => {
    answered = true
  })
  pingTimer = setInterval(() => {
    if (socket.readyState !== socket.OPEN) return
    if (!answered) {
      log.info({ studentId }, 'club connection stopped answering pings')
      dropSocket()
      return
    }
    answered = false
    socket.ping()
  }, deps.pingIntervalMs ?? PING_INTERVAL_MS)

  // ---- hello ----

  async function onHello(hello: Hello): Promise<void> {
    const door = clubDoor(deps, clock.now())
    if (door !== null) return refuse(door)

    // Whether the student may come in is judged as the service's rounds judge it (`standingsAmong`). The key was the
    // student's at the upgrade; a student gone since is no member of anything.
    const standings = await standingsAmong(db, [studentId], club.game.club)
    const refusal = studentRefusal(standings.get(studentId) ?? GONE_STANDING, club.game, config, clock.now())
    if (refusal !== null) return refuse(refusal)
    // Their name and class, for `welcome` and the rooms. Gone, or out of their class, since the line above: the
    // standing of a student gone.
    const r = await db
      .selectFrom('students as s')
      .innerJoin('classes as c', 'c.id', 's.classId')
      .select(['s.id', 's.ownerName', 's.aiName', 's.email', 's.aiType', 's.avatarBackground', 's.avatarBorder', 'c.division', 'c.slot', 'c.classNo'])
      .where('s.id', '=', studentId)
      .executeTakeFirst()
    if (r === undefined) return refuse(studentRefusal(GONE_STANDING, club.game, config, clock.now())!)
    const student: ClubStudent = {
      person: studentPersonWithClass(r, { division: r.division, slot: r.slot, classNo: r.classNo }, config),
      email: r.email,
      address: ip,
    }
    const stats = await club.game.stats(studentId)
    // The client may have gone meanwhile; a closed connection must never be registered.
    if (socket.readyState !== socket.OPEN) return
    // Nor may one come in once the doors have closed meanwhile: the close has disconnected everyone it found in the
    // hub, and a connection registered now would stay behind it. From here to the end nothing is awaited, so a close
    // that comes later finds this connection in the hub.
    const now = clock.now()
    const late = clubDoor(deps, now)
    if (late !== null) return refuse(late)

    // From the moment the connection is in the hub until the welcome and what follows it are out, whatever the club
    // sends it waits, and goes out after them, in order.
    held = []
    let queued: ServerMessage[]
    let replaced: HubConnection | undefined
    let back: Rejoin
    try {
      replaced = club.hub.add(connection)
      registered = true
      me = student
      // The old connection's close finds a newer one in the hub, so the student is not taken for gone.
      replaced?.close(REPLACED)
      back = club.rejoined(studentId, hello, now, ip)
    } finally {
      queued = held
      held = null
    }
    const welcome: Welcome = {
      type: 'welcome',
      student: student.person,
      club: { id: club.game.club, name: club.game.name },
      closesAt: club.rooms.closesAt(now).toISOString(),
      limits: {
        framesPerMinute: limits.framesPerMinute,
        timeBankSeconds: config.club.timeBankSeconds,
        inviteSeconds: config.club.inviteSeconds,
        idleMinutes: config.club.idleMinutes,
        idleDecideSeconds: config.club.idleDecideSeconds,
        maxSpectators: config.club.maxSpectators,
        reactMinIntervalSeconds: config.club.reactMinIntervalSeconds,
        reactsPerGame: config.club.reactsPerGame,
      },
      reactions: {
        kinds: [...club.game.reactions.kinds],
        visibility: [...club.game.reactions.visibility],
        emoji: [...club.wordLists.emoji],
        phrases: club.wordLists.phrases.map((phrase) => ({ id: phrase.id, text: phrase.text })),
      },
      stats,
      rules: club.game.rules(),
      room: back.room,
    }
    write(ackMessage(hello.id, { ok: true }))
    write(welcome)
    for (const m of back.replay) write(m)
    for (const m of back.resend) write(m)
    for (const m of back.invites) write(m)
    for (const m of queued) write(m)
    log.info(
      { studentId, roomId: back.roomId, replayed: back.replay.length, replaced: replaced !== undefined },
      'student joined club',
    )
  }

  function refuse(closing: ClubClosing): void {
    log.info({ studentId, reason: closing.reason }, 'club connection refused')
    sendClosing(closing)
  }

  // ---- Every frame ----

  /** Whether the club is closed now for what a student asks of it: switched off, closed, or under maintenance. */
  const closedNow = (now: Date): boolean => {
    const door = clubDoor(deps, now)
    return door !== null && door.reason !== 'service_stopping'
  }

  /**
   * The ack for a message, and what handling it sent this connection, to go out after the ack; null when the
   * connection is over before the message could be handled (then nothing is done, nor answered).
   */
  async function onAction(
    student: ClubStudent,
    msg: ClubAction,
  ): Promise<{ ack: AckResult; held: ServerMessage[] } | null> {
    if (closedNow(clock.now())) return { ack: fail('club_closed'), held: [] }
    const ids = club.targetsOf(msg)
    if (ids.length > 0) {
      const found = await memberEmails(db, ids, club.game.club)
      // Looked at again after the lookup: the connection may be over (closed, replaced, disconnected with everyone
      // as the doors closed), and then the message is not handled at all, or the club may have closed meanwhile.
      if (left || socket.readyState !== socket.OPEN) return null
      if (closedNow(clock.now())) return { ack: fail('club_closed'), held: [] }
      return handled(student, msg, (id) => {
        const email = found.get(id)
        return email === undefined ? null : { studentId: id, email }
      })
    }
    return handled(student, msg, () => null)
  }

  /** Handles the message, holding what the club sends this connection meanwhile (see `onAction`). */
  function handled(student: ClubStudent, msg: ClubAction, targets: InviteTargets) {
    // Synchronous from here: what the club sends this connection while it handles the message waits for the ack.
    held = []
    try {
      const ack = club.handle(student, msg, targets, clock.now())
      return { ack, held }
    } finally {
      held = null
    }
  }

  /** Handles a frame; one that came past the student's rate (`withinRate` was false) is only answered so. */
  async function onFrame(data: RawData, withinRate: boolean): Promise<void> {
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
    if (!withinRate) return reply(id, fail('rate_limited'))
    // Looked at before the schema, whose literal 'v1' would make any other protocol just an invalid message.
    if (isObject(frame) && frame.type === 'hello' && frame.protocol !== 'v1') {
      return reply(id, fail('protocol_unsupported'))
    }
    if (!Value.Check(ClubClientMessage, frame)) return reply(id, fail('invalid_message'))

    const msg = frame
    if (msg.type === 'hello') {
      if (me !== null || msg.club !== club.game.club) return reply(msg.id, fail('invalid_message'))
      clearTimeout(helloTimer)
      return onHello(msg)
    }
    const student = me
    if (student === null) return reply(msg.id, fail('hello_required'))
    const result = await onAction(student, msg)
    if (result === null) return
    const { ack, held: after } = result
    reply(msg.id, ack)
    for (const m of after) write(m)
  }

  // Counted for the student, from the upgrade on, whatever connection the frames come on: a student who reconnects goes
  // on with the window their earlier connections filled. A frame past `framesPerMinute` does not count.
  const withinRate = (): boolean => frames.allow(studentId, performance.now())

  // Attached before anything is awaited, so no frame is missed. Whether a frame is within the rate is decided when it
  // comes, not when its turn does; its answer still comes in order.
  let queue = Promise.resolve()
  let waiting = 0
  socket.on('message', (data) => {
    if (socket.readyState !== socket.OPEN) return
    if (waiting >= limits.maxQueuedFrames) {
      log.info({ studentId }, 'club connection sent too many frames at once')
      closeSocket(1008)
      return
    }
    const allowed = withinRate()
    waiting++
    queue = queue
      .then(() => onFrame(data, allowed))
      .catch((err: unknown) => {
        // Only that a frame failed is logged, never what it said.
        log.error({ err, studentId }, 'club connection frame failed')
        try {
          deps.onInternalError?.()
        } catch {
          // Counting an error must not change what happens to the connection.
        }
        closeSocket(1011)
      })
      .finally(() => {
        waiting--
      })
  })

  socket.on('close', () => {
    stopTimers()
    leave()
  })

  /**
   * The connection is over, whoever closed it; runs once. Only the student going offline counts: a connection
   * replaced by a newer one is not the student leaving.
   */
  function leave(): void {
    if (left || !registered) return
    left = true
    if (!club.hub.remove(connection)) return
    log.info({ studentId }, 'student left club')
    try {
      club.left(studentId, clock.now())
    } catch (err) {
      log.error({ err, studentId }, 'club disconnect failed')
    }
  }
}
