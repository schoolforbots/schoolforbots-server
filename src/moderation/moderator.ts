import { AhoCorasick } from './aho-corasick.js'
import { normalizeForMatch, normalizeForPrivacy } from './normalize.js'
import { findPrivacyLeak } from './privacy.js'

export type ModerationCategory = 'sensitive' | 'injection' | 'privacy'

/** One rule that hit. */
export interface ModerationHit {
  category: ModerationCategory
  /** What matched, in the normalized text: only for masking it, and never for a log. */
  matched: string
  /** The rule that hit: the word-list entry, or the phrase rule as its line reads; null for a privacy hit. */
  rule: string | null
}

export type ModerationResult = { verdict: 'pass' } | ({ verdict: 'blocked' } & ModerationHit)

/** A phrase rule: its line in the data file, and the pattern compiled from it. */
export interface InjectionPattern {
  source: string
  re: RegExp
}

export interface ModerationData {
  blockedWords: string[]
  injectionPatterns: InjectionPattern[]
}

/** The rules an operator has dropped, by their exact text: word-list entries and phrase-rule lines. */
export interface ExcludedRules {
  words: Set<string>
  patterns: Set<string>
}

export interface Moderator {
  check(text: string): ModerationResult
  /**
   * Every rule that hits, each once: the words in the order they end in the text, then the phrase rules in the order
   * of the file, then a privacy leak (one at most: privacy hits name no rule). Empty when the text passes. For a
   * reviewer who needs every hit, not only the first.
   */
  checkAll(text: string): ModerationHit[]
}

/**
 * Checks sensitive words, then injection phrases, then privacy leaks; the first hit wins. The rules in `excluded` are
 * left out, as if the data files did not have them.
 */
export function createModerator(data: ModerationData, excluded?: ExcludedRules): Moderator {
  const words = data.blockedWords.filter((w) => !excluded?.words.has(w))
  const patterns = data.injectionPatterns.filter((p) => !excluded?.patterns.has(p.source))
  const blockedWords = new AhoCorasick(words)
  // The search finds a word in its normalized form; the rule is the entry as the list has it. Of two entries that
  // normalize alike, the first names the hit.
  const entryOf = new Map<string, string>()
  for (const word of words) {
    const normalized = normalizeForMatch(word)
    if (!entryOf.has(normalized)) entryOf.set(normalized, word)
  }

  return {
    check(text) {
      // Sensitive words and injection phrases are matched with whitespace and
      // Unicode format characters removed, so spacing tricks do not hide them.
      const squashed = normalizeForMatch(text)

      const word = blockedWords.findFirst(squashed)
      if (word !== null) {
        return { verdict: 'blocked', category: 'sensitive', matched: word, rule: entryOf.get(word) ?? word }
      }

      for (const pattern of patterns) {
        pattern.re.lastIndex = 0 // a /g or /y pattern would otherwise carry state between calls
        const hit = pattern.re.exec(squashed)
        if (hit !== null) return { verdict: 'blocked', category: 'injection', matched: hit[0], rule: pattern.source }
      }

      // Privacy rules also lose the format characters but keep whitespace and
      // newlines: a pasted chat log is judged line by line.
      const leak = findPrivacyLeak(normalizeForPrivacy(text))
      if (leak !== null) return { verdict: 'blocked', category: 'privacy', matched: leak, rule: null }

      return { verdict: 'pass' }
    },

    checkAll(text) {
      const squashed = normalizeForMatch(text)
      const hits: ModerationHit[] = []
      // Two entries that normalize alike are one hit, under the first one's name, as in `check`.
      for (const word of blockedWords.findAll(squashed)) {
        hits.push({ category: 'sensitive', matched: word, rule: entryOf.get(word) ?? word })
      }
      for (const pattern of patterns) {
        pattern.re.lastIndex = 0
        const hit = pattern.re.exec(squashed)
        if (hit !== null) hits.push({ category: 'injection', matched: hit[0], rule: pattern.source })
      }
      const leak = findPrivacyLeak(normalizeForPrivacy(text))
      if (leak !== null) hits.push({ category: 'privacy', matched: leak, rule: null })
      return hits
    },
  }
}
