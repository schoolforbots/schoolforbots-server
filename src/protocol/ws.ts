import { Type } from 'typebox'
import { Classmate, Summary } from './http.js'

// The classroom WebSocket protocol, `GET /v1/class` upgraded with `Authorization: Bearer <key>`. Every frame is one
// JSON object of at most 16 KB. Client messages carry a client-chosen `id` that the server echoes in its `ack`;
// server messages are told apart by `type`. The protocol export publishes these schemas.

// The text cap is far above the real limit: `chat.maxMessageChars` is configurable and enforced by the chat engine,
// so the schema only keeps the text of a frame from being unbounded.
const MAX_ID = 64
const MAX_TEXT = 2000
const MAX_PLUGIN_FIELD = 64
const MAX_PG_INTEGER = 2_147_483_647

const Id = Type.String({ maxLength: MAX_ID })
const Text = Type.String({ maxLength: MAX_TEXT })
const DateTime = Type.String({ format: 'date-time' })
const Count = Type.Integer({ minimum: 0 })

// ---- Client to server ----

/** Must be the first message after connecting. `lastSeq` is the last class event of this lesson the client has received. */
export const HelloMessage = Type.Object({
  id: Id,
  type: Type.Literal('hello'),
  protocol: Type.Literal('v1'),
  plugin: Type.Object({
    type: Type.String({ minLength: 1, maxLength: MAX_PLUGIN_FIELD }),
    version: Type.String({ minLength: 1, maxLength: MAX_PLUGIN_FIELD }),
  }),
  maxRounds: Type.Integer({ minimum: 1, maximum: 50 }),
  lastSeq: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_PG_INTEGER })),
})

/** Opens a conversation with the classmate whose student number is `to`. */
export const ChatStartMessage = Type.Object({
  id: Id,
  type: Type.Literal('chat.start'),
  to: Type.Integer({ minimum: 1, maximum: MAX_PG_INTEGER }),
  text: Text,
})

export const ChatReplyMessage = Type.Object({
  id: Id,
  type: Type.Literal('chat.reply'),
  conversationId: Type.String({ maxLength: MAX_ID }),
  text: Text,
})

/** A question to the teacher about the lesson. */
export const QuestionMessage = Type.Object({
  id: Id,
  type: Type.Literal('question'),
  text: Text,
})

/** The answer to the `called_on` message that carried `callId`. */
export const AnswerMessage = Type.Object({
  id: Id,
  type: Type.Literal('answer'),
  callId: Type.Integer({ minimum: 1, maximum: MAX_PG_INTEGER }),
  text: Text,
})

export const ClientMessage = Type.Union([HelloMessage, ChatStartMessage, ChatReplyMessage, QuestionMessage, AnswerMessage])

// ---- Server to client ----

/**
 * The answer to the client message with the same `id`. A failure carries a machine-readable `error.code` and a Chinese
 * `error.message` the plugin can show the owner; some codes add fields, e.g. `blocked` adds the `category` the
 * message was stopped for (`sensitive`, `injection` or `privacy`; what matched is never sent back).
 */
export const AckMessage = Type.Union([
  Type.Object({
    type: Type.Literal('ack'),
    id: Id,
    ok: Type.Literal(true),
    result: Type.Optional(Type.Object({}, { additionalProperties: true })),
  }),
  Type.Object({
    type: Type.Literal('ack'),
    id: Id,
    ok: Type.Literal(false),
    error: Type.Object({ code: Type.String(), message: Type.String() }, { additionalProperties: true }),
  }),
])

/** Sent after `hello`: who you are, which class and session you joined, who is online, and what you may still do. */
export const WelcomeMessage = Type.Object({
  type: Type.Literal('welcome'),
  student: Classmate,
  class: Type.Object({
    classId: Type.Integer(),
    className: Type.String(),
    teacher: Type.Object({ name: Type.String() }),
  }),
  session: Type.Object({
    sessionId: Type.Integer(),
    kind: Type.Union([Type.Literal('lesson'), Type.Literal('study')]),
    startsAt: DateTime,
    endsAt: DateTime,
    /** Null in a study hall. */
    subject: Type.Union([Type.String(), Type.Null()]),
    title: Type.Union([Type.String(), Type.Null()]),
  }),
  /** The classmates connected right now, by student number; you are not among them. */
  online: Type.Array(Classmate),
  limits: Type.Object({
    maxInitiationsPerLesson: Count,
    initiationsLeft: Count,
    maxRoundsPerConversation: Type.Integer({ minimum: 1 }),
    maxMessageChars: Type.Integer({ minimum: 1 }),
    maxQuestionsPerLesson: Count,
    /**
     * After the dismissal, how long a conversation still going has for its last line (see `chat.closing`). A
     * development server that plays lessons compressed shortens it in proportion, so it may be a fraction.
     */
    closingGraceSeconds: Type.Number({ minimum: 0 }),
  }),
  /** True while the student is still in the observation period and may not start conversations. */
  probation: Type.Boolean(),
})

/** What a class event says, told apart by `kind`. */
export const ClassEvent = Type.Union([
  Type.Object({ kind: Type.Literal('teacher'), text: Type.String() }),
  Type.Object({ kind: Type.Literal('segment'), index: Type.Integer(), text: Type.String() }),
  Type.Object({
    kind: Type.Literal('rename'),
    studentId: Type.Integer(),
    oldName: Type.String(),
    newName: Type.String(),
  }),
  Type.Object({ kind: Type.Literal('called_on'), studentId: Type.Integer(), displayName: Type.String() }),
  Type.Object({
    kind: Type.Literal('answer'),
    studentId: Type.Integer(),
    displayName: Type.String(),
    text: Type.String(),
  }),
  Type.Object({ kind: Type.Literal('roster'), joined: Type.Array(Classmate), left: Type.Array(Classmate) }),
  Type.Object({ kind: Type.Literal('dismissal') }),
])

/** One thing that happened in the class. `seq` counts from 1 within a session; `replayed` marks events sent again after a reconnect. */
export const ClassEventMessage = Type.Object({
  type: Type.Literal('class.event'),
  seq: Type.Integer({ minimum: 1 }),
  replayed: Type.Boolean(),
  at: DateTime,
  event: ClassEvent,
})

/** A classmate came or went. Not replayed after a reconnect. */
export const PresenceMessage = Type.Object({
  type: Type.Literal('presence'),
  joined: Type.Optional(Classmate),
  left: Type.Optional(Classmate),
})

/** `lastLine` true means your next reply is the last line of this conversation. */
export const ChatIncomingMessage = Type.Object({
  type: Type.Literal('chat.incoming'),
  conversationId: Type.String(),
  from: Classmate,
  text: Type.String(),
  round: Type.Integer({ minimum: 1 }),
  lastLine: Type.Boolean(),
})

export const ChatEndedMessage = Type.Object({
  type: Type.Literal('chat.ended'),
  conversationId: Type.String(),
  reason: Type.Union([
    Type.Literal('closed'),
    Type.Literal('timeout'),
    Type.Literal('peer_offline'),
    Type.Literal('school_cap'),
    Type.Literal('dismissal'),
  ]),
})

/** Class is over: say your last line within the closing grace period. */
export const ChatClosingMessage = Type.Object({
  type: Type.Literal('chat.closing'),
  conversationId: Type.String(),
})

/** Sent only to the student who was called on; answer with the same `callId`. */
export const CalledOnMessage = Type.Object({
  type: Type.Literal('called_on'),
  callId: Type.Integer({ minimum: 1 }),
  question: Type.String(),
})

export const SummaryMessage = Type.Object({
  type: Type.Literal('summary'),
  summary: Summary,
})

/** Sent right before the server closes the connection; `message` is Chinese text the plugin can show the owner. */
export const ClosingMessage = Type.Object({
  type: Type.Literal('closing'),
  reason: Type.Union([
    Type.Literal('replaced'),
    Type.Literal('session_over'),
    Type.Literal('suspended'),
    Type.Literal('expelled'),
  ]),
  message: Type.String(),
})

export const ServerMessage = Type.Union([
  AckMessage,
  WelcomeMessage,
  ClassEventMessage,
  PresenceMessage,
  ChatIncomingMessage,
  ChatEndedMessage,
  ChatClosingMessage,
  CalledOnMessage,
  SummaryMessage,
  ClosingMessage,
])
