import { normalizeForPrivacy } from './normalize.js'
import { findChatLog, PRIVACY_RULES, type PrivacyKind } from './privacy.js'

const CHAT_LOG_MARKER = '[聊天记录已隐藏]'

/** A change to the normalized text: the characters from `from` up to (not including) `to` become `text`. */
interface Edit {
  from: number
  to: number
  text: string
}

const stars = (n: number) => '*'.repeat(n)
const digitsOf = (fragment: string) => fragment.replace(/\D/g, '')

/**
 * What to hide in one hit of each kind, as edits relative to the whole normalized text (`at` is where the hit starts).
 * The QQ number and the WeChat id are cut out of the hit, so the context word in front of them stays as written.
 */
const MASKERS: Record<PrivacyKind, (hit: RegExpExecArray, at: number) => Edit[]> = {
  // 138-1234-5678 -> 138****5678: the separators are gone
  phone: (hit, at) => {
    const digits = digitsOf(hit[0])
    return [{ from: at, to: at + hit[0].length, text: `${digits.slice(0, 3)}****${digits.slice(-4)}` }]
  },
  // someone@example.com -> s***@example.com: only the local part after its first character
  email: (hit, at) => [{ from: at + 1, to: at + hit[0].indexOf('@'), text: '***' }],
  // 110105 19491231 002X -> 110*************2X
  idCard: (hit, at) => {
    const chars = hit[0].replace(/[^\dx]/g, '')
    const text = `${chars.slice(0, 3)}${stars(chars.length - 5)}${chars.slice(-2).toUpperCase()}`
    return [{ from: at, to: at + hit[0].length, text }]
  },
  // QQ 123-456-789 -> QQ *********: one star for each digit
  qq: (hit, at) => secretEdit(hit, at, digitsOf(secretOf(hit)).length),
  // 微信 abc_12345 -> 微信 *********: one star for each character of the id
  wechat: (hit, at) => secretEdit(hit, at, secretOf(hit).length),
}

function secretOf(hit: RegExpExecArray): string {
  return hit.groups?.['secret'] ?? hit[0]
}

function secretEdit(hit: RegExpExecArray, at: number, starCount: number): Edit[] {
  const from = at + hit[0].length - secretOf(hit).length
  return [{ from, to: at + hit[0].length, text: stars(starCount) }]
}

/** The matches of the privacy rules, in a form that `matchAll` accepts (it needs the `g` flag). */
const GLOBAL_RULES = PRIVACY_RULES.map(({ kind, pattern }) => ({ kind, pattern: new RegExp(pattern, 'g') }))

function findEdits(text: string): Edit[] {
  const edits: Edit[] = []
  for (const { kind, pattern } of GLOBAL_RULES) {
    for (const hit of text.matchAll(pattern)) edits.push(...MASKERS[kind](hit, hit.index))
  }
  const log = findChatLog(text)
  if (log !== null) edits.push({ from: log.start, to: log.end, text: CHAT_LOG_MARKER })
  return edits
}

/**
 * Orders the edits and settles those that touch. One inside another is covered by it (a chat log hides the numbers in
 * it, a QQ number that is also a phone number is hidden once). Two that only overlap are hidden together, as stars.
 */
function settle(edits: Edit[]): Edit[] {
  const sorted = [...edits].sort((a, b) => a.from - b.from || b.to - a.to)
  const settled: Edit[] = []
  for (const edit of sorted) {
    const last = settled.at(-1)
    if (last === undefined || edit.from >= last.to) {
      settled.push(edit)
    } else if (edit.to > last.to) {
      settled[settled.length - 1] = { from: last.from, to: edit.to, text: stars(edit.to - last.from) }
    }
  }
  return settled
}

/** Characters that stay with the letter before them: invisible ones and combining marks (see `normalizeForPrivacy`). */
const CLUSTER = /[\s\S][\p{M}\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]*/gu

/**
 * Normalizes like `normalizeForPrivacy`, one cluster at a time, and remembers which part of the original each
 * normalized character came from. A cluster is a character with the invisible characters and combining marks that
 * follow it, so what NFKC composes (a letter and its accent, even with a joiner between them) is composed inside one
 * cluster. The result differs from the whole-text normalization only in letters that depend on their neighbours
 * (the final sigma, Hangul jamo), which no privacy rule reads.
 */
function normalizeWithOrigin(text: string): { normalized: string; start: number[]; end: number[] } {
  let normalized = ''
  const start: number[] = []
  const end: number[] = []
  for (const cluster of text.matchAll(CLUSTER)) {
    const piece = normalizeForPrivacy(cluster[0])
    normalized += piece
    for (let i = 0; i < piece.length; i++) {
      start.push(cluster.index)
      end.push(cluster.index + cluster[0].length)
    }
  }
  return { normalized, start, end }
}

/**
 * Hides everything the privacy rules would block, and leaves the rest of the text as it was written.
 *
 * - mobile number: first 3 and last 4 digits stay, separators go (`138****5678`)
 * - e-mail: first character and the domain stay (`s***@example.com`)
 * - ID number: first 3 and last 2 characters stay
 * - QQ number, WeChat id: the context word stays, the number or id becomes as many `*`
 * - pasted chat log: replaced as a whole by `[聊天记录已隐藏]`
 *
 * The rules look at the normalized text (full-width digits, invisible characters), so the hits are found there and
 * then cut out of the original text at the matching places.
 */
export function maskPrivacy(text: string): string {
  const { normalized, start, end } = normalizeWithOrigin(text)
  const edits = settle(findEdits(normalized))
  if (edits.length === 0) return text

  let out = ''
  let cursor = 0
  for (const edit of edits) {
    // An edit that covers no character (an e-mail address with a one-character local part has nothing to hide
    // after its first character) still has a place in the text: just before the character that follows it.
    const from = start[edit.from] ?? text.length
    const to = edit.to > edit.from ? (end[edit.to - 1] ?? text.length) : from
    out += text.slice(cursor, Math.max(cursor, from)) + edit.text
    cursor = Math.max(cursor, to)
  }
  return out + text.slice(cursor)
}
