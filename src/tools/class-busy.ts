import { isSchoolDay } from '../shared/calendar.js'
import { systemClock, type Clock } from '../shared/clock.js'
import { loadSchoolConfig, type SchoolConfig } from '../shared/config.js'
import { addDaysToDate, atLocalTime, localDate, localMoment } from '../shared/local-time.js'
import { isEntryPoint } from './entry-point.js'

/** A class service restarted this long before a class opens would be down when students arrive. */
const MIN_LEAD_MINUTES = 15
/** Exit code for "busy", so a script can tell it from a failure (1). */
export const EXIT_BUSY = 3

export type Busy = { busy: false } | { busy: true; freeAt: Date }

/**
 * The windows of every session on the days around `now`: from the doors to the end of the closing grace, and of the
 * window the classes' closes are spread over after it (`lesson.staggerMillis`).
 */
function windows(config: SchoolConfig, now: Date): { from: Date; until: Date }[] {
  const today = localDate(now, config.timezone)
  const lead = Math.max(MIN_LEAD_MINUTES, config.lesson.doorsOpenMinutesBefore) * 60_000
  const tail =
    config.lesson.dismissalMinute * 60_000 + config.lesson.closingGraceSeconds * 1000 + config.lesson.staggerMillis
  const out: { from: Date; until: Date }[] = []
  for (const day of [addDaysToDate(today, -1), today, addDaysToDate(today, 1)]) {
    if (!isSchoolDay(day, config)) continue
    for (const slot of Object.values(config.slots)) {
      const start = atLocalTime(day, slot.start, config.timezone).getTime()
      out.push({ from: new Date(start - lead), until: new Date(start + tail) })
    }
  }
  return out
}

/**
 * Whether a class is on, or opens within 15 minutes (or when its doors open, if that is earlier), at `now`; and if so
 * when the school is next free: the end of the window, or of the chain of windows that run into each other.
 */
export function classBusy(config: SchoolConfig, now: Date): Busy {
  const all = windows(config, now)
  let freeAt = now.getTime()
  let busy = false
  // Each pass that finds a window around `freeAt` moves it later, and the windows are finitely many.
  for (let moved = true; moved; ) {
    moved = false
    for (const w of all) {
      if (w.from.getTime() <= freeAt && freeAt < w.until.getTime()) {
        freeAt = w.until.getTime()
        busy = moved = true
      }
    }
  }
  return busy ? { busy: true, freeAt: new Date(freeAt) } : { busy: false }
}

interface Out {
  log(message: string): void
  error(message: string): void
}

/** 0 when the school is free, 3 (and when it is next free) when it is busy, 1 when the config cannot be read. */
export function runClassBusy(env: NodeJS.ProcessEnv, clock: Clock, out: Out): number {
  let config: SchoolConfig
  try {
    config = loadSchoolConfig(env.SCHOOL_CONFIG || 'config/school.json')
  } catch (err) {
    out.error(`读不了学校配置：${err instanceof Error ? err.message : '未知错误'}`)
    return 1
  }
  const result = classBusy(config, clock.now())
  if (!result.busy) {
    out.log('现在没有课，可以重启上课服务')
    return 0
  }
  out.log(`正在上课或马上开课，最早 ${localMoment(result.freeAt, config.timezone)} 空下来`)
  return EXIT_BUSY
}

if (isEntryPoint(import.meta.url)) {
  process.exit(runClassBusy(process.env, systemClock, console))
}
