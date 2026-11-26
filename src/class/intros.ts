import type { Kysely } from 'kysely'
import type { Database } from '../shared/db.js'
import { displayName } from '../shared/identity.js'
import type { SessionMember } from '../shared/schema.js'

// The newcomers of a session and their self-introductions. A newcomer is a member at the doors whose introduction was
// not read in this class yet: placed for the first time, moved here, or back from leaving the school into another
// class than the one that last welcomed them. The first session of a class has every member new; a member who did not
// come is read out all the same. Each is read once per class: the opening marks them as introduced here.

export interface Intro {
  studentId: number
  ownerName: string
  aiName: string
  displayName: string
  intro: string
}

export interface Newcomers {
  /** Every newcomer, by student number. */
  newcomers: number[]
  /**
   * Who the teacher welcomes, by student number with the name as it is now: the newcomers, and the members in
   * `rejoined` back in a class that introduced them before (welcomed, not introduced again).
   */
  welcomed: { studentId: number; ownerName: string; aiName: string }[]
  /** The intros of the newcomers who have one, in the same order. */
  intros: Intro[]
}

/**
 * The payload of one `intros` event is kept under this many bytes of JSON, so the `class.event` frame around it stays
 * well within the 16 KB a WebSocket frame may have.
 */
export const INTROS_EVENT_BYTES = 12_000

/**
 * The members of `classId`'s session that have not been introduced in the class, read in the session's transaction.
 * `rejoined` are the members the roster change found joining since the class's previous session.
 */
export async function newcomersOf(
  trx: Kysely<Database>,
  classId: number,
  members: SessionMember[],
  rejoined: number[] = [],
): Promise<Newcomers> {
  if (members.length === 0) return { newcomers: [], welcomed: [], intros: [] }
  const rows = await trx
    .selectFrom('students')
    .select(['id', 'ownerName', 'aiName', 'intro', 'introClassId'])
    .where(
      'id',
      'in',
      members.map((m) => m.studentId),
    )
    .orderBy('id')
    .execute()
  const fresh = rows.filter((r) => r.introClassId !== classId)
  const back = new Set(rejoined)
  return {
    newcomers: fresh.map((r) => r.id),
    welcomed: rows
      .filter((r) => r.introClassId !== classId || back.has(r.id))
      .map((r) => ({ studentId: r.id, ownerName: r.ownerName, aiName: r.aiName })),
    intros: fresh
      .filter((r) => r.intro !== null)
      .map((r) => ({
        studentId: r.id,
        ownerName: r.ownerName,
        aiName: r.aiName,
        displayName: displayName(r.ownerName, r.aiName),
        intro: r.intro as string,
      })),
  }
}

/** Marks the newcomers as introduced in `classId`. */
export async function markIntroduced(trx: Kysely<Database>, classId: number, studentIds: number[]): Promise<void> {
  if (studentIds.length === 0) return
  await trx.updateTable('students').set({ introClassId: classId }).where('id', 'in', studentIds).execute()
}

/** The intros in as few groups as fit `maxBytes` of JSON each (an intro is at most a few hundred bytes, so one always fits). */
export function chunkIntros(intros: Intro[], maxBytes = INTROS_EVENT_BYTES): Intro[][] {
  const chunks: Intro[][] = []
  let current: Intro[] = []
  let bytes = Buffer.byteLength(JSON.stringify({ kind: 'intros', intros: [] }))
  for (const intro of intros) {
    const size = Buffer.byteLength(JSON.stringify(intro)) + 1
    if (current.length > 0 && bytes + size > maxBytes) {
      chunks.push(current)
      current = []
      bytes = Buffer.byteLength(JSON.stringify({ kind: 'intros', intros: [] }))
    }
    current.push(intro)
    bytes += size
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}
