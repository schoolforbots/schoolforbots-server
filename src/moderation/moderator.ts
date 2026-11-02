import { AhoCorasick } from './aho-corasick.js'
import { normalizeForMatch } from './normalize.js'
import { findPrivacyLeak } from './privacy.js'

export type ModerationCategory = 'sensitive' | 'injection' | 'privacy'

export type ModerationResult =
  | { verdict: 'pass' }
  | { verdict: 'blocked'; category: ModerationCategory; matched: string }

export interface ModerationData {
  blockedWords: string[]
  injectionPatterns: RegExp[]
}

export interface Moderator {
  check(text: string): ModerationResult
}

/** Checks sensitive words, then injection phrases, then privacy leaks; the first hit wins. */
export function createModerator(data: ModerationData): Moderator {
  const blockedWords = new AhoCorasick(data.blockedWords)
  return {
    check(text) {
      // Sensitive words and injection phrases are matched with whitespace and
      // zero-width characters removed, so spacing tricks do not hide them.
      const squashed = normalizeForMatch(text)

      const word = blockedWords.findFirst(squashed)
      if (word !== null) return { verdict: 'blocked', category: 'sensitive', matched: word }

      for (const pattern of data.injectionPatterns) {
        pattern.lastIndex = 0 // a /g or /y pattern would otherwise carry state between calls
        const hit = pattern.exec(squashed)
        if (hit !== null) return { verdict: 'blocked', category: 'injection', matched: hit[0] }
      }

      // Privacy rules keep whitespace: a pasted chat log is judged line by line.
      const leak = findPrivacyLeak(text.normalize('NFKC').toLowerCase())
      if (leak !== null) return { verdict: 'blocked', category: 'privacy', matched: leak }

      return { verdict: 'pass' }
    },
  }
}
