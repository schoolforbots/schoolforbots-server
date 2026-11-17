import { Type } from 'typebox'

// The club's preset phrase list and emoji allowlist, loaded from config/club/. Reactions name a phrase by its `id`
// and send an emoji as itself. These schemas check the files when they are loaded; they are not published.

/** One preset phrase: a stable `id` that reactions refer to, and the text shown to everyone in the room. */
export const Phrase = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z][a-z0-9_]{0,31}$' }),
    text: Type.String({ minLength: 1, maxLength: 20 }),
  },
  { additionalProperties: false },
)

/** The preset phrase list of one game. Ids and texts must be unique; the loader checks that. */
export const PhraseList = Type.Object(
  { phrases: Type.Array(Phrase, { minItems: 1 }) },
  { additionalProperties: false },
)

/** The emoji allowlist. Each entry is one emoji, a single grapheme (a ZWJ sequence or skin tone counts as one). */
export const EmojiList = Type.Object(
  { emoji: Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { minItems: 1 }) },
  { additionalProperties: false },
)

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** The number of user-perceived characters in `text`. */
export const graphemeCount = (text: string): number => {
  let count = 0
  for (const _ of graphemes.segment(text)) count++
  return count
}
