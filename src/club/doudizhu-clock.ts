import type { Phase, Rules } from './doudizhu/index.js'

// The clock of one doudizhu step, as pure functions of milliseconds (see the top of doudizhu-game.ts for how a session
// uses them).
//
// A step has a limit of its own: `rules.bidSeconds` for a bid, `rules.playSeconds` for a play or a pass. Its
// `deadline` is that long after the step was asked. Past the deadline the seat spends its time bank, one for the whole
// game: a step made `late` milliseconds past its deadline costs `late` of the bank, and a step not made by `deadline +
// bank` times out (the trustee makes it) and empties the bank. A seat in trusteeship is asked too, but with a short
// deadline of its own (`trusteeDelayMs`), when the trustee makes the step; its bank is not spent meanwhile.
//
// A moment counts as past a time once it is at that time: a step is late from its deadline on, and times out at
// exactly `deadline + bank`.

/** How long a step of `phase` may take before the time bank is spent, in milliseconds. */
export function stepLimitMs(rules: Pick<Rules, 'bidSeconds' | 'playSeconds'>, phase: Exclude<Phase, 'over'>): number {
  return (phase === 'bidding' ? rules.bidSeconds : rules.playSeconds) * 1000
}

/** The deadline of a step asked at `askedAt` that may take `limitMs`. */
export function deadlineOf(askedAt: number, limitMs: number): number {
  return askedAt + limitMs
}

/**
 * The time bank left at `now` of a seat that had `bankMs` when the step with `deadline` was asked, and has not made
 * it: all of it up to the deadline, then less by the time past it, and never below 0. When the step is made at `now`,
 * this is the bank the seat keeps.
 */
export function bankLeftAt(bankMs: number, deadline: number, now: number): number {
  return Math.max(0, bankMs - Math.max(0, now - deadline))
}

/**
 * When the step with `deadline` is made for the seat if it has not made it: when its bank runs out, or at the deadline
 * itself for a seat in trusteeship.
 */
export function dueAt(deadline: number, bankMs: number, inTrusteeship: boolean): number {
  return inTrusteeship ? deadline : deadline + bankMs
}

/** The bank as a `your_turn` or a `retry` shows it: whole seconds, rounded down. */
export function shownSeconds(bankMs: number): number {
  return Math.floor(Math.max(0, bankMs) / 1000)
}
