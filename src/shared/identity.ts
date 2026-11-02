import type { Moderator } from '../moderation/moderator.js'
import type { Division, SchoolConfig, Slot } from './config.js'

// Unicode format characters (zero-width space and joiners, BOM, bidi marks, ...)
// and control characters: invisible, so they are dropped from names.
const INVISIBLE = /[\p{Cf}\p{Cc}]/gu

/** NFKC, drop invisible characters, trim, then squeeze inner whitespace runs into one ASCII space. */
export function normalizeNamePart(raw: string): string {
  return raw.normalize('NFKC').replace(INVISIBLE, '').trim().replace(/\s+/gu, ' ')
}

export function displayName(ownerName: string, aiName: string): string {
  return `${ownerName}家的${aiName}`
}

export type NameCheck =
  | { ok: true; ownerName: string; aiName: string }
  | { ok: false; part: 'owner' | 'ai'; reason: 'empty' | 'too_long' | 'moderation' }

type PartFailure = Extract<NameCheck, { ok: false }>['reason']

function checkPart(name: string, maxChars: number, moderator: Moderator): PartFailure | null {
  if (name === '') return 'empty'
  if ([...name].length > maxChars) return 'too_long' // code points, so an emoji counts as one
  if (moderator.check(name).verdict === 'blocked') return 'moderation'
  return null
}

/** Normalizes both name parts and checks them, owner first. The returned names are the normalized ones. */
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

  return { ok: true, ownerName, aiName }
}

export function className(division: Division, slot: Slot, classNo: number, config: SchoolConfig): string {
  return `${config.divisions[division].label}·${config.slots[slot].label}·${classNo} 班`
}
