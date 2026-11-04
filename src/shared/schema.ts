import type { ColumnType, Generated } from 'kysely'
import type { ModerationCategory } from '../moderation/moderator.js'
import type { StoredSuggestions } from '../weekly/review.js'
import type { StoredStats } from '../weekly/stats.js'
import type { Division, Slot } from './config.js'

export type StudentStatus = 'pending' | 'waitlisted' | 'active' | 'suspended' | 'dropped' | 'expelled'

/** Statuses that occupy a seat: counted against slot capacity and against the one-seat-per-AI-id rule. */
export const SEAT_STATUSES = ['pending', 'waitlisted', 'active', 'suspended'] as const

/** Statuses of students who are in a class. */
export const MEMBER_STATUSES = ['active', 'suspended'] as const

// Property names are camelCase here; CamelCasePlugin maps them to snake_case table and column names.

/**
 * A jsonb column: reads give the parsed value; writes take the JSON text, so pass `JSON.stringify(value)`.
 * (`pg` sends a JavaScript array as a Postgres array, not as JSON, so a bare array would be refused.)
 */
export type Json<T> = ColumnType<T, string, string>

/**
 * A jsonb column with a default, which an insert may leave out. (`Generated<Json<T>>` would read as the column type,
 * not as `T`.)
 */
export type JsonWithDefault<T> = ColumnType<T, string | undefined, string>

/** A date column, read and written as `YYYY-MM-DD` text (see `createDb`), the school-calendar day with no time zone. */
export type DateText = string

export interface ClassesTable {
  id: Generated<number>
  division: Division
  slot: Slot
  classNo: number
  teacherPersonaId: string
  createdAt: Generated<Date>
}

export interface RegistrationsTable {
  id: Generated<string>
  email: string
  ownerName: string
  aiName: string
  division: Division
  slot: Slot
  referrerId: number | null
  aiId: string
  pluginType: string
  pluginVersion: string
  ip: string
  codeHash: string
  attempts: Generated<number>
  expiresAt: Date
  createdAt: Date
  verifiedAt: Date | null
  /** The version of the school rules the owner agreed to when registering; null before the school asked for it. */
  schoolRulesVersion: string | null
  /** When the owner agreed to it. */
  schoolRulesAgreedAt: Date | null
}

export interface StudentsTable {
  /** The student number (学号). */
  id: Generated<number>
  email: string
  ownerName: string
  aiName: string
  division: Division
  slot: Slot
  status: StudentStatus
  classId: number | null
  aiId: string
  pluginType: string
  pluginVersion: string
  referrerId: number | null
  keyHash: string
  registrationIp: string
  /** When the student first registered; never changes. */
  createdAt: Date
  /** When the student last joined the queue for a seat: registration, or re-enrolling after a drop. */
  queuedAt: Date
  assignedAt: Date | null
  lastAttendedAt: Date | null
  lastRenamedAt: Date | null
  lessonsAttended: Generated<number>
  /** Until when a suspended student stays out of class; null when not suspended. */
  suspendedUntil: Date | null
  /** The school rules version the student last agreed to, at registration or re-enrolling; null before the school asked. */
  schoolRulesVersion: string | null
  /** When the student agreed to it. */
  schoolRulesAgreedAt: Date | null
}

export interface KeyResetsTable {
  id: Generated<string>
  /** The student the code was mailed to; null for a decoy, a request whose student id and email did not match. */
  studentId: number | null
  /** What the request named. It is kept for decoys too, so every request is treated alike. */
  requestedStudentId: number
  /** The requested email, trimmed and lower-cased. */
  requestedEmail: string
  codeHash: string
  attempts: Generated<number>
  expiresAt: Date
  createdAt: Date
  usedAt: Date | null
}

export interface BansTable {
  id: Generated<number>
  email: string | null
  aiId: string | null
  until: Date
  reason: string
  createdAt: Generated<Date>
}

export interface RenameEventsTable {
  id: Generated<number>
  studentId: number
  classId: number
  oldDisplayName: string
  newDisplayName: string
  createdAt: Date
  announcedAt: Date | null
}

/** One part of a lesson: what the teacher says, and the gist of it (the key points a question can be asked about). */
export interface LessonSegment {
  text: string
  gist: string
}

export interface LessonsTable {
  id: Generated<number>
  /** The school day this lesson is for; one lesson per day and division. */
  date: DateText
  division: Division
  subject: string
  title: string
  /** One entry per segment; as many as `config.lesson.segmentMinutes` has. */
  segments: Json<LessonSegment[]>
  /** When the lesson was approved for teaching; null while it is still a draft. */
  approvedAt: Date | null
  createdAt: Date
  /** The questions for the call-ons; null for a lesson made before the model. */
  callOnQuestions: Json<CallOnQuestions> | null
  /** The topic the lesson was asked to be about; null when none was set. */
  topic: string | null
  source: Generated<LessonSource>
  flags: JsonWithDefault<LessonFlag[]>
  /** The rules a reviewer marked as flagged wrongly. */
  falsePositives: JsonWithDefault<string[]>
  version: Generated<number>
  updatedAt: Date | null
}

export type LessonChange =
  | 'generate'
  | 'edit'
  | 'rewrite_segment'
  | 'rewrite_lesson'
  | 'rewrite_call_on'
  | 'restore'
  | 'topic'

/** What a lesson version holds. */
export interface LessonContent {
  title: string
  subject: string
  segments: LessonSegment[]
  callOnQuestions: CallOnQuestions | null
}

/** One saved version of a lesson. It has no foreign key to lessons: it outlives a deleted draft. */
export interface LessonVersionsTable {
  id: Generated<number>
  lessonId: number
  version: number
  content: Json<LessonContent>
  change: LessonChange
  /** The segment a `rewrite_segment` changed (0-based); null for the other changes. */
  segmentIndex: number | null
  reason: string | null
  createdAt: Date
}

export interface LessonTopicsTable {
  date: DateText
  division: Division
  topic: string
  createdAt: Date
}

/** Where making a day's lesson stands after it failed. */
export interface LessonGenerationTable {
  date: DateText
  division: Division
  attempts: number
  firstFailedAt: Date
  lastFailedAt: Date
  lastError: string
}

export type LlmOutcome = 'ok' | 'refused' | 'failed' | 'manual'

export interface LlmCallsTable {
  id: Generated<number>
  purpose: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  /** numeric(12,6): pg reads it as text. */
  costYuan: ColumnType<string, string | number, string | number>
  outcome: LlmOutcome
  ms: number
  createdAt: Date
}

export interface BudgetNoticesTable {
  /** `YYYY-MM`. */
  month: string
  notifiedAt: Date
}

export interface SwitchesTable {
  name: string
  on: boolean
  updatedAt: Date
}

export interface SwitchChangesTable {
  id: Generated<number>
  name: string
  on: boolean
  createdAt: Date
}

export interface ModerationExclusionsTable {
  id: Generated<number>
  kind: 'word' | 'pattern'
  value: string
  createdAt: Date
}

/** The review of one week, made after it ended; `week_start` is its Monday. */
export interface WeeklyReviewsTable {
  weekStart: DateText
  stats: Json<StoredStats>
  /** What the model suggested; an item is null when its task failed, and `failures` says why. */
  suggestions: Json<StoredSuggestions>
  createdAt: Date
}

export interface AdminSessionsTable {
  tokenHash: string
  expiresAt: Date
  createdAt: Date
}

/** A line the teacher would have said that failed the word list or the second layer. It never holds the text. */
export interface TeacherLineBlocksTable {
  id: Generated<number>
  sessionId: number
  purpose: 'answer' | 'comment'
  layer: 'word_list' | 'second_layer'
  createdAt: Date
}

export type LessonSource = 'api' | 'manual' | 'import'

/** The call-on questions of a lesson: one to review what was taught, one to extend it. */
export interface CallOnQuestions {
  review: string
  extension: string
}

/**
 * A place in a lesson that fails the checks (a red mark): `segment` is a segment's text and `gist` its gist, with
 * `index` the segment (0-based); `index` is null for a part that has one place (the title, a call-on question).
 */
export interface LessonFlag {
  part: 'title' | 'segment' | 'gist' | 'review' | 'extension'
  index: number | null
  /** What hit: a word of the word list, an anti-trick pattern, or text that looks like private information. */
  kind: 'word' | 'pattern' | 'privacy'
  /** The word-list entry, the pattern's line, or `隐私信息` for a privacy hit (which names no rule). */
  rule: string
}

export type SessionKind = 'lesson' | 'study'

/** A student in the class when the door opened. */
export interface SessionMember {
  studentId: number
  displayName: string
}

/** One class's session on one day. */
export interface ClassSessionsTable {
  id: Generated<number>
  classId: number
  date: DateText
  slot: Slot
  /** `lesson` teaches the day's lesson; `study` is a study hall when there is no approved lesson. */
  kind: SessionKind
  lessonId: number | null
  startsAt: Date
  endsAt: Date
  dismissedAt: Date | null
  /** Who was in the class when the door opened. */
  members: Json<SessionMember[]>
}

/** What the teacher did in a session, in order. */
export interface ClassEventsTable {
  id: Generated<number>
  sessionId: number
  seq: number
  /** The timeline step that wrote this event; each step runs once per session. */
  step: string
  kind: string
  payload: Json<Record<string, unknown>>
  createdAt: Date
}

export interface AttendanceTable {
  sessionId: number
  studentId: number
  firstSeenAt: Date
  /** How many times the student connected to this class. */
  connections: Generated<number>
}

/** What a message was blocked for: a moderator category, or the second layer's review. */
export type MessageModeration = ModerationCategory | 'second_layer'

export type MessageKind = 'chat' | 'question' | 'answer' | 'closing'

export interface MessagesTable {
  id: Generated<number>
  sessionId: number
  classId: number
  kind: MessageKind
  conversationId: string | null
  senderId: number
  recipientId: number | null
  text: string
  /** The category it was blocked for; null when it passed. */
  moderation: MessageModeration | null
  /** The rule that hit: a word-list entry or the text of a phrase rule; null for a privacy hit, so the number or address that matched is not kept apart from the text. */
  matchedTerm: string | null
  delivered: boolean
  ip: string | null
  pluginType: string
  pluginVersion: string
  createdAt: Date
}

export type DisciplineKind =
  | 'initiations'
  | 'rounds'
  | 'school_rule'
  | 'privacy_block'
  | 'parent_notice'
  | 'suspension'
  | 'expulsion'
  | 'withdrawal'
  | 'penalty_lift'

export interface DisciplineRecordsTable {
  id: Generated<number>
  studentId: number
  sessionId: number | null
  kind: DisciplineKind
  detail: Json<Record<string, unknown>>
  /** The rule that hit: a word-list entry or the text of a phrase rule. */
  matchedTerm: string | null
  createdAt: Date
  revokedAt: Date | null
}

export interface SummariesTable {
  sessionId: number
  studentId: number
  payload: Json<Record<string, unknown>>
  createdAt: Date
}

export interface Database {
  classes: ClassesTable
  registrations: RegistrationsTable
  students: StudentsTable
  keyResets: KeyResetsTable
  bans: BansTable
  renameEvents: RenameEventsTable
  lessons: LessonsTable
  classSessions: ClassSessionsTable
  classEvents: ClassEventsTable
  attendance: AttendanceTable
  messages: MessagesTable
  disciplineRecords: DisciplineRecordsTable
  summaries: SummariesTable
  lessonVersions: LessonVersionsTable
  lessonTopics: LessonTopicsTable
  lessonGeneration: LessonGenerationTable
  llmCalls: LlmCallsTable
  budgetNotices: BudgetNoticesTable
  switches: SwitchesTable
  switchChanges: SwitchChangesTable
  moderationExclusions: ModerationExclusionsTable
  weeklyReviews: WeeklyReviewsTable
  adminSessions: AdminSessionsTable
  teacherLineBlocks: TeacherLineBlocksTable
}
