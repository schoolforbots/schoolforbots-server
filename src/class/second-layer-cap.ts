import type { Participant } from './connection.js'

// How many of a student's lines the second layer has stopped this lesson, chat lines and answers together. Once that
// is `limit`, the student's lines that pass the word list are not sent to the second layer for the rest of the lesson:
// each is answered as one it stopped (`blocked`, `sensitive`), and not kept. So a student who says the same thing again
// and again costs at most `limit` model checks and `limit` messages rows a lesson.
//
// Counted in memory, per session: a restart starts every count afresh. A session is forgotten at its close.

export interface SecondLayerCap {
  /** Whether the second layer has stopped `limit` of the student's lines this session. */
  reached(p: Participant): boolean
  /** The second layer stopped one more of the student's lines. Logged once, when the count reaches the limit. */
  count(p: Participant): void
  /** Forgets the sessions that have closed by `now` (ms). */
  expire(now: number): void
  /** Forgets the sessions of the class (its close). */
  endClass(classId: number): void
}

interface SessionCount {
  classId: number
  closeAt: number
  blocks: Map<number, number>
}

export function createSecondLayerCap(
  limit: number,
  log: (obj: object, msg: string) => void = () => {},
): SecondLayerCap {
  const sessions = new Map<number, SessionCount>()

  return {
    reached(p) {
      return (sessions.get(p.sessionId)?.blocks.get(p.studentId) ?? 0) >= limit
    },

    count(p) {
      let s = sessions.get(p.sessionId)
      if (s === undefined) {
        s = { classId: p.classId, closeAt: p.closeAt.getTime(), blocks: new Map() }
        sessions.set(p.sessionId, s)
      }
      const n = (s.blocks.get(p.studentId) ?? 0) + 1
      s.blocks.set(p.studentId, n)
      if (n === limit) {
        log(
          { studentId: p.studentId, sessionId: p.sessionId, limit },
          "second layer limit reached: no more of the student's lines go to it this lesson",
        )
      }
    },

    expire(now) {
      for (const [sessionId, s] of sessions) if (now >= s.closeAt) sessions.delete(sessionId)
    },

    endClass(classId) {
      for (const [sessionId, s] of sessions) if (s.classId === classId) sessions.delete(sessionId)
    },
  }
}
