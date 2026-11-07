import type { ModelPrice } from '../shared/config.js'
import { isoWeekday, localDate, localTimeOfDay } from '../shared/local-time.js'

/**
 * What a call cost in yuan. The prices are those of the first window that holds the moment `at` (its weekday and time
 * of day in `timeZone`), else the base ones. Input the vendor served from its cache is charged at the cached price, or
 * at the input price when none is set; at most all of the input counts as cached.
 */
export function costYuan(
  price: ModelPrice,
  tokens: { input: number; cachedInput: number; output: number },
  at: Date,
  timeZone: string,
): number {
  const weekday = isoWeekday(localDate(at, timeZone))
  const timeOfDay = localTimeOfDay(at, timeZone)
  const rates = price.windows?.find((w) => w.weekdays.includes(weekday) && w.from <= timeOfDay && timeOfDay < w.to) ?? price
  const cached = Math.min(tokens.cachedInput, tokens.input)
  const cachedRate = rates.cachedInputYuanPerMillion ?? rates.inputYuanPerMillion
  return ((tokens.input - cached) * rates.inputYuanPerMillion + cached * cachedRate + tokens.output * rates.outputYuanPerMillion) / 1_000_000
}
