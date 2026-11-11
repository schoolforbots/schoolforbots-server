// The pure part of the simulator's report (see sim-bots.ts): the percentiles of the delays it measured, and whether
// they are within the pass line of a load test.

/** What a run measured. Delays are in milliseconds. */
export interface Samples {
  /** Segment delays: the time a bot received a live `class.event` of a segment minus the event's `at`. */
  segmentMs: number[]
  /** Conversation line delays: from a bot sending a line to the classmate it is meant for receiving it. */
  chatMs: number[]
  /** Connections that were closed that neither the bot nor the school meant to close (no `closing`, no drop). */
  unexpectedDisconnects: number
  /** Messages the school refused, by error code. */
  errors: Record<string, number>
}

/** The figures of one list of delays. The percentiles and the maximum are null when there are no samples. */
export interface Stat {
  count: number
  p50: number | null
  p90: number | null
  p99: number | null
  max: number | null
}

export interface Report {
  segment: Stat
  chat: Stat
  unexpectedDisconnects: number
  errors: Record<string, number>
}

/**
 * The nearest-rank percentile: the smallest value that at least `p` percent of the values are less than or equal to,
 * i.e. the value at rank `ceil(p / 100 * n)` of the sorted list (never interpolated, so it is always a value that was
 * measured). With 150 values p99 is the 149th; with 2 values p99 is the larger one. Null when there are no values.
 * `p` is from 0 to 100; 0 gives the smallest value.
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  if (!(p >= 0 && p <= 100)) throw new RangeError(`p must be from 0 to 100, got ${p}`)
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1]!
}

function statOf(values: number[]): Stat {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p90: percentile(values, 90),
    p99: percentile(values, 99),
    max: percentile(values, 100),
  }
}

export function summarize(samples: Samples): Report {
  return {
    segment: statOf(samples.segmentMs),
    chat: statOf(samples.chatMs),
    unexpectedDisconnects: samples.unexpectedDisconnects,
    errors: { ...samples.errors },
  }
}

/**
 * Whether the run is within the pass line: the p99 of the segment delays within `segmentMs` and of the conversation
 * line delays within `chatMs` (each only when given; exactly on the line passes), and no unexpected disconnect.
 * A limit that is given with no samples to measure fails: a run that measured nothing proves nothing.
 */
export function verdict(
  report: Report,
  expect: { segmentMs?: number; chatMs?: number },
): { pass: boolean; failures: string[] } {
  const failures: string[] = []
  const check = (what: string, stat: Stat, limit: number | undefined) => {
    if (limit === undefined) return
    if (stat.p99 === null) failures.push(`${what}没有样本，没法判断是否在 ${limit} 毫秒内`)
    else if (stat.p99 > limit) failures.push(`${what}的 p99 是 ${stat.p99} 毫秒，超过了 ${limit} 毫秒`)
  }
  check('课文延迟', report.segment, expect.segmentMs)
  check('搭话延迟', report.chat, expect.chatMs)
  if (report.unexpectedDisconnects > 0) failures.push(`有 ${report.unexpectedDisconnects} 次意外断开`)
  return { pass: failures.length === 0, failures }
}
