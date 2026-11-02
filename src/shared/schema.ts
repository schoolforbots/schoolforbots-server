import type { ColumnType, Generated } from 'kysely'
import type { ModerationCategory } from '../moderation/moderator.js'
import type { Division, Slot } from './config.js'

export type StudentStatus = 'pending' | 'waitlisted' | 'active' | 'suspended' | 'dropped' | 'expelled'

/** Statuses that occupy a seat: counted against slot capacity and against the one-seat-per-install rule. */
export const SEAT_STATUSES = ['pending', 'waitlisted', 'active', 'suspended'] as const

/** Statuses of students who are in a class. */
export const MEMBER_STATUSES = ['active', 'suspended'] as const

// Property names are camelCase here; CamelCasePlugin maps them to snake_case table and column names.

/**
 * A jsonb column: reads give the parsed value; writes take the JSON text, so pass `JSON.stringify(value)`.
 * (`pg` sends a JavaScript array as a Postgres array, not as JSON, so a bare array would be refused.)
 */
export type Json<T> = ColumnType<T, string, string>

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
  installId: string
  pluginType: string
  pluginVersion: string
  ip: string
  codeHash: string
  attempts: Generated<number>
  expiresAt: Date
  createdAt: Date
  verifiedAt: Date | null
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
  installId: string
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
  installId: string | null
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
}

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
  /** The category the moderator blocked it for; null when it passed. */
  moderation: ModerationCategory | null
  /** The word-list entry or phrase that matched; null for a privacy hit, so the number or address that matched is not kept apart from the text. */
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

export interface DisciplineRecordsTable {
  id: Generated<number>
  studentId: number
  sessionId: number | null
  kind: DisciplineKind
  detail: Json<Record<string, unknown>>
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
}
