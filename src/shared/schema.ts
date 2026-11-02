import type { Generated } from 'kysely'
import type { Division, Slot } from './config.js'

export type StudentStatus = 'pending' | 'waitlisted' | 'active' | 'suspended' | 'dropped' | 'expelled'

/** Statuses that occupy a seat: counted against slot capacity and against the one-seat-per-install rule. */
export const SEAT_STATUSES = ['pending', 'waitlisted', 'active', 'suspended'] as const

/** Statuses of students who are in a class. */
export const MEMBER_STATUSES = ['active', 'suspended'] as const

// Property names are camelCase here; CamelCasePlugin maps them to snake_case table and column names.

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
  createdAt: Date
  assignedAt: Date | null
  lastAttendedAt: Date | null
  lastRenamedAt: Date | null
  lessonsAttended: Generated<number>
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

export interface Database {
  classes: ClassesTable
  registrations: RegistrationsTable
  students: StudentsTable
  keyResets: KeyResetsTable
  bans: BansTable
  renameEvents: RenameEventsTable
}
