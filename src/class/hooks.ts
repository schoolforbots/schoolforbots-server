import type { Kysely } from 'kysely'
import type { Clock } from '../shared/clock.js'
import type { SchoolConfig } from '../shared/config.js'
import type { Database } from '../shared/schema.js'
import { applyPenalties, calloutsForWindow } from './discipline.js'
import type { ActiveSession } from './runtime.js'

/**
 * What the lesson runtime leaves to the other parts of the class service. The runtime calls each hook at its step;
 * the parts that fill them in (discipline, chat, call-on, summaries) come in later and are assembled here.
 *
 * `callOn` and `callOnClose` may write class events of their own step: the first under the step's name (`call-on`,
 * `call-on-close`), any more as `<step>#2`, `<step>#3` ... (see events.ts), and push them after committing. When
 * the hook wrote none, the runtime records the step with a `noop` marker after it returns. A step that has run is not
 * run again after a restart.
 *
 * A session the service catches up after its close (it was down through it), or after its class has opened a newer
 * one, is finished quietly: `callOn`, `callOnClose`, `startClosing` and `endAll` are not called, `callouts` is (its
 * lines are recorded, not pushed), and `afterClass` is called with `live: false`.
 */
export interface LessonHooks {
  /** The teacher's discipline callouts for what was recorded in [from, to); empty when there is nothing to say. */
  callouts(session: ActiveSession, from: Date, to: Date): Promise<string[]>
  /** The teacher calls on a student (after the segment the config names). */
  callOn(session: ActiveSession): Promise<void>
  /** The time to answer the call-on is up. */
  callOnClose(session: ActiveSession): Promise<void>
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
}

/**
 * The hooks of the running class service: `noopHooks` with each part's real hook put in its place as it is built.
 * So far: the teacher's discipline callouts and the penalties after class.
 */
export function createLessonHooks(deps: LessonHooksDeps): LessonHooks {
  const { db, config, clock } = deps
  return {
    ...noopHooks,
    callouts: (session, from, to) => calloutsForWindow(db, session, from, to),
    // Penalties only touch the database, so a session finished quietly gets them too.
    afterClass: async (session) => {
      await applyPenalties(db, config, clock, session)
    },
  }
}
