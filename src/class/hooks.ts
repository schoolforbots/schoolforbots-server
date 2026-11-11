import type { Kysely } from 'kysely'
import type { Clock } from '../shared/clock.js'
import type { SchoolConfig } from '../shared/config.js'
import type { Database } from '../shared/schema.js'
import type { ChatEngine } from './chat.js'
import { applyPenalties, calloutsForWindow } from './discipline.js'
import type { Hub } from './hub.js'
import { callOnCloseStep, callOnStep, type QuestionsDeps } from './questions.js'
import type { ActiveSession } from './runtime.js'
import { writeSummaries } from './summaries.js'
import type { TeacherAi } from './teacher-ai.js'

/**
 * What the lesson runtime leaves to the other parts of the class service. The runtime calls each hook at its step;
 * the parts that fill them in (discipline, chat, call-on, summaries) come in later and are assembled here.
 *
 * `callOn` and `callOnClose` may write class events of their own step: the first under the step's name (`call-on-1`,
 * `call-on-close-1`), any more as `<step>#2`, `<step>#3` ... (see events.ts), and push them after committing. The close
 * may write the teacher's comment on the answer instead (`comment-1`, see questions.ts). When the hook wrote nothing
 * under the step's name, the runtime records the step with a `noop` marker after it returns. A step that has run is not
 * run again after a restart.
 *
 * A session the service catches up after its close (it was down through it), or after its class has opened a newer
 * one, is finished quietly: `callOn`, `callOnClose`, `startClosing` and `endAll` are not called, `callouts` is (its
 * lines are recorded, not pushed), and `afterClass` is called with `live: false`. So is a session cut short by
 * maintenance, whose steps before the close are skipped without calling any hook (see `cutShort` in runtime.ts).
 */
export interface LessonHooks {
  /** The teacher's discipline callouts for what was recorded in [from, to); empty when there is nothing to say. */
  callouts(session: ActiveSession, from: Date, to: Date): Promise<string[]>
  /** The teacher calls on a student with the `n`th call-on of the config (from 1) and its lesson question. */
  callOn(session: ActiveSession, n: number, question: { kind: 'review' | 'extension'; text: string }): Promise<void>
  /** The time to answer the `n`th call-on is up: the next segment starts. */
  callOnClose(session: ActiveSession, n: number): Promise<void>
  /**
   * The teacher starts answering the students' questions of segment `k`: those asked in `window.from` to `window.to`,
   * to be answered by `window.deadline`. Returns at once; the work goes on in the background.
   */
  startAnswering(session: ActiveSession, k: number, window: { from: Date; to: Date; deadline: Date }): void
  /** Dismissal: conversations still going get the closing grace period for a last line. */
  startClosing(classId: number): void
  /** The end of the session: whatever conversation is left ends now. */
  endAll(classId: number): void
  /** A student's connection closed. */
  onDisconnect(studentId: number): void
  /**
   * After class, before the session is marked dismissed: the penalties, then the take-home summaries. `live` is false
   * for a session finished quietly, whose students are no longer connected to it: nothing is pushed to anyone then.
   */
  afterClass(session: ActiveSession, opts: { live: boolean }): Promise<void>
}

/** Hooks that do nothing: a lesson with only the template teacher. */
export const noopHooks: LessonHooks = {
  callouts: async () => [],
  callOn: async () => {},
  callOnClose: async () => {},
  startAnswering: () => {},
  startClosing: () => {},
  endAll: () => {},
  onDisconnect: () => {},
  afterClass: async () => {},
}

/** What the real hooks are built from. Later parts of the class service add what they need here. */
export interface LessonHooksDeps {
  db: Kysely<Database>
  config: SchoolConfig
  clock: Clock
  /** The chat engine the class app relays conversations through; without one, the chat hooks do nothing. */
  chat?: Pick<ChatEngine, 'startClosing' | 'endAll' | 'onDisconnect'>
  /**
   * What the call-ons are built from, as the class app's question handlers are (the teacher's comments on the answers
   * included); without it, nobody is called on.
   */
  questions?: QuestionsDeps
  /** The hub the take-home summaries are pushed through (to whoever is online, when the session ends live). */
  hub: Hub
  /** The teacher's work with the model; without it, the teacher answers no question. */
  teacherAi?: Pick<TeacherAi, 'startAnswering'>
  /** A program log line: numbers and categories only, never what anyone said. */
  log?: (obj: object, msg: string) => void
}

/**
 * The hooks of the running class service: `noopHooks` with each part's real hook put in its place as it is built.
 * So far: the teacher's discipline callouts, the call-ons and their closes, the answers to the students' questions,
 * the conversations' closing grace and end, and the penalties and the take-home summaries after class.
 */
export function createLessonHooks(deps: LessonHooksDeps): LessonHooks {
  const { db, config, clock, chat, questions, hub, teacherAi, log } = deps
  return {
    ...noopHooks,
    callouts: (session, from, to) => calloutsForWindow(db, session, from, to),
    // Each writes its step's events itself (see questions.ts), at most once per session.
    ...(questions === undefined
      ? {}
      : {
          callOn: (session: ActiveSession, n: number, question: { kind: 'review' | 'extension'; text: string }) =>
            callOnStep(questions, session, n, question),
          callOnClose: (session: ActiveSession, n: number) => callOnCloseStep(questions, session, n),
        }),
    // Returns at once: the answer is worked on in the background and writes its own event (see teacher-ai.ts).
    ...(teacherAi === undefined ? {} : { startAnswering: teacherAi.startAnswering }),
    // All three are synchronous, as the runtime and the connection layer call them.
    ...(chat === undefined
      ? {}
      : {
          startClosing: (classId: number) => chat.startClosing(classId),
          endAll: (classId: number) => chat.endAll(classId),
          onDisconnect: (studentId: number) => chat.onDisconnect(studentId),
        }),
    // Penalties and summaries only touch the database, so a session finished quietly gets them too; of the two, only
    // the push of the summaries waits for `live`. Run again after a crash, neither writes a thing twice: penalties are
    // keyed by the session, summaries by session and student (so a student who has none yet, say one who attended
    // late, gets theirs). A live rerun sends the stored summaries again.
    afterClass: async (session, { live }) => {
      await applyPenalties(db, config, clock, session)
      await writeSummaries({ db, config, clock, hub, log }, session, { live })
    },
  }
}
