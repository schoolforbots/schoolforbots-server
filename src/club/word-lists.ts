import { existsSync, readFileSync } from 'node:fs'
import { type Static, type TSchema, Type } from 'typebox'
import { Value } from 'typebox/value'

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

// ---- Loading ----

/** The club's word lists as loaded: the emoji allowlist and the phrase list (the same shape as `WordLists`). */
export interface LoadedWordLists {
  readonly emoji: readonly string[]
  readonly phrases: readonly Static<typeof Phrase>[]
}

/** `<name>.example.json` next to `<name>.json`; null for a path that does not end in `.json`. */
export function examplePath(path: string): string | null {
  return path.endsWith('.json') ? `${path.slice(0, -'.json'.length)}.example.json` : null
}

/** `what` after a Chinese word: with a space before it when it starts with a Latin letter (`emoji 表`). */
const spaced = (what: string): string => (/^[A-Za-z]/.test(what) ? ` ${what}` : what)

/**
 * Whether an entry of the emoji list is an emoji: it has a pictographic character in it, or it is a flag (two
 * regional indicators) or a keycap (`#`, `*` or a digit, then the keycap mark). A bare joiner or variation selector,
 * a Han character or a letter is not.
 */
export function isEmoji(entry: string): boolean {
  return (
    /\p{Extended_Pictographic}/u.test(entry) ||
    /^\p{Regional_Indicator}{2}$/u.test(entry) ||
    /^[0-9#*]️?⃣$/u.test(entry)
  )
}

/**
 * Reads the file at `path`, or the example next to it (`<name>.example.json`, with a stderr warning) when it is
 * missing, as the prompts and the moderation lists are read. Throws when neither is there.
 */
function readListFile(path: string, what: string, warn: (message: string) => void): { file: string; text: string } {
  if (existsSync(path)) return { file: path, text: readFileSync(path, 'utf8') }
  const example = examplePath(path)
  if (example === null || !existsSync(example)) {
    throw new Error(`社团的${spaced(what)}缺失：没有 ${path}${example === null ? '' : `，也没有 ${example}`}`)
  }
  warn(`[club] 未找到 ${path}，改用示例文件 ${example}（只是示例内容，部署前请放入真实的${spaced(what)}）`)
  return { file: example, text: readFileSync(example, 'utf8') }
}

function parseList<T extends TSchema>(schema: T, file: string, text: string, what: string): Static<T> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new Error(`社团的${spaced(what)}（${file}）不是合法的 JSON：${err instanceof Error ? err.message : String(err)}`)
  }
  if (!Value.Check(schema, value)) {
    const errors = [...Value.Errors(schema, value)].slice(0, 5).map((e) => `${e.instancePath || '/'} ${e.message}`)
    throw new Error(`社团的${spaced(what)}（${file}）格式不对：${errors.join('；')}`)
  }
  return value
}

const repeated = (values: readonly string[]): string[] => [...new Set(values.filter((v, i) => values.indexOf(v) !== i))]

/**
 * The club's word lists from the files `club.wordLists` names (each falling back to its example, see `readListFile`),
 * checked: the schemas above, phrase ids and texts unique, each phrase text at most 20 characters, each emoji one
 * character as a person sees it and an emoji (`isEmoji`), no emoji twice. Throws, naming the file and what is wrong,
 * so a bad list stops the start.
 */
export function loadWordLists(
  paths: { readonly phrases: string; readonly emoji: string },
  warn: (message: string) => void = (message) => void process.stderr.write(`${message}\n`),
): LoadedWordLists {
  const phraseFile = readListFile(paths.phrases, '短语表', warn)
  const { phrases } = parseList(PhraseList, phraseFile.file, phraseFile.text, '短语表')
  const emojiFile = readListFile(paths.emoji, 'emoji 表', warn)
  const { emoji } = parseList(EmojiList, emojiFile.file, emojiFile.text, 'emoji 表')

  const problems: string[] = []
  const ids = repeated(phrases.map((p) => p.id))
  if (ids.length > 0) problems.push(`${phraseFile.file}：短语编号重复：${ids.join('、')}`)
  const texts = repeated(phrases.map((p) => p.text))
  if (texts.length > 0) problems.push(`${phraseFile.file}：短语重复：${texts.join('、')}`)
  for (const p of phrases) {
    if (graphemeCount(p.text) > 20) problems.push(`${phraseFile.file}：短语 ${p.id} 超过 20 个字`)
  }
  const twice = repeated(emoji)
  if (twice.length > 0) problems.push(`${emojiFile.file}：emoji 重复：${twice.join(' ')}`)
  for (const e of emoji) {
    if (graphemeCount(e) !== 1 || !isEmoji(e)) problems.push(`${emojiFile.file}：${JSON.stringify(e)} 不是一个 emoji`)
  }
  if (problems.length > 0) throw new Error(`社团的词表有问题：\n${problems.join('\n')}`)
  return { emoji, phrases }
}
