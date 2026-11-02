import type { Moderator } from '../moderation/moderator.js'
import { removeInvisible } from '../moderation/normalize.js'
import type { Division, SchoolConfig, Slot } from './config.js'

// Control characters have no business in a name either.
const CONTROL = /\p{Cc}/gu

/**
 * NFKC, drop invisible and control characters, NFKC again, trim, then squeeze inner whitespace runs into one ASCII
 * space. Two names that look the same therefore compare equal, which the duplicate-name rule relies on. The second
 * NFKC composes what the dropped characters kept apart: e + combining grapheme joiner + acute accent has to end up
 * as the same é as the single character.
 */
export function normalizeNamePart(raw: string): string {
  return removeInvisible(raw.normalize('NFKC'))
    .replace(CONTROL, '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
}

// Scripts with letters that look like Latin ones (Cyrillic а о е, Greek Α Ο, Armenian Օ, Cherokee Ꭺ ...).
const CONFUSABLE_SCRIPTS = [
  /\p{Script=Latin}/u,
  /\p{Script=Cyrillic}/u,
  /\p{Script=Greek}/u,
  /\p{Script=Armenian}/u,
  /\p{Script=Cherokee}/u,
]
// A run is a stretch of letters of those scripts; any other character (CJK, digit, space, punctuation, emoji) ends it.
const CONFUSABLE_RUN = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}]+/gu

/**
 * True when one run of letters mixes two or more of the look-alike scripts, as in a Cyrillic Т and о next to a
 * Latin m: it reads as Tom, yet it is not the name Tom, so it would slip past the duplicate-name rule and the
 * word list. Different words may use different scripts (Tom Иван, Tom和Иван); one word may not.
 */
function mixesScripts(name: string): boolean {
  for (const [run] of name.matchAll(CONFUSABLE_RUN)) {
    if (CONFUSABLE_SCRIPTS.filter((script) => script.test(run)).length >= 2) return true
  }
  return false
}

export function displayName(ownerName: string, aiName: string): string {
  return `${ownerName}家的${aiName}`
}

export type NameCheck =
  | { ok: true; ownerName: string; aiName: string }
  | { ok: false; part: 'owner' | 'ai'; reason: 'empty' | 'too_long' | 'mixed_script' | 'moderation' }
  // Each part passed alone, but the display name they make together did not.
  | { ok: false; part: 'both'; reason: 'moderation' }

type PartFailure = Extract<NameCheck, { ok: false }>['reason']

function checkPart(name: string, maxChars: number, moderator: Moderator): PartFailure | null {
  if (name === '') return 'empty'
  if ([...name].length > maxChars) return 'too_long' // code points, so an emoji counts as one
  if (mixesScripts(name)) return 'mixed_script'
  if (moderator.check(name).verdict === 'blocked') return 'moderation'
  return null
}

/**
 * Normalizes both name parts and checks them, owner first (empty, too long, mixed scripts, then moderation), then
 * moderates the display name they make together:
 * everyone sees and hears the joined name, and two harmless parts can join into a QQ number or an injection
 * phrase (QQ + 12345678 is QQ家的12345678). The returned names are the normalized ones.
 */
export function checkNames(
  owner: string,
  ai: string,
  opts: { maxChars: number; moderator: Moderator },
): NameCheck {
  const ownerName = normalizeNamePart(owner)
  const ownerFailure = checkPart(ownerName, opts.maxChars, opts.moderator)
  if (ownerFailure !== null) return { ok: false, part: 'owner', reason: ownerFailure }

  const aiName = normalizeNamePart(ai)
  const aiFailure = checkPart(aiName, opts.maxChars, opts.moderator)
  if (aiFailure !== null) return { ok: false, part: 'ai', reason: aiFailure }

  if (opts.moderator.check(displayName(ownerName, aiName)).verdict === 'blocked') {
    return { ok: false, part: 'both', reason: 'moderation' }
  }

  return { ok: true, ownerName, aiName }
}

export function className(division: Division, slot: Slot, classNo: number, config: SchoolConfig): string {
  return `${config.divisions[division].label}·${config.slots[slot].label}·${classNo} 班`
}
