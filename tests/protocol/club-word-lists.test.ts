import { readFileSync } from 'node:fs'
import Value from 'typebox/value'
import { describe, expect, test } from 'vitest'
import { EmojiList, PhraseList, graphemeCount } from '../../src/club/word-lists.js'

const load = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'))

const phrases = load('config/club/doudizhu-phrases.example.json')
const emoji = load('config/club/emoji.example.json')

const phraseItems = (): { id: string; text: string }[] => (phrases as { phrases: { id: string; text: string }[] }).phrases
const emojiItems = (): string[] => (emoji as { emoji: string[] }).emoji

const duplicates = (values: string[]): string[] => values.filter((value, i) => values.indexOf(value) !== i)

// Rude gestures, weapons, the bomb (it would be mixed up with the 炸弹 hand), poo, money and gambling.
const BANNED_EMOJI = ['🖕', '🔫', '💣', '💩', '🎰', '💰', '💵', '💸', '💴', '💶', '💷', '🤑']
// Religious symbols and places of worship.
const RELIGIOUS_EMOJI = ['✝', '☦', '☪', '🕉', '✡', '🔯', '🕎', '☸', '☯', '🛐', '⛪', '🕌', '🕍', '🛕', '⛩', '📿', '🙏']
// Regional indicators make up country flags; the rest are the other flag emoji.
const isFlagCodePoint = (cp: number): boolean =>
  (cp >= 0x1f1e6 && cp <= 0x1f1ff) || [0x1f3f4, 0x1f3f3, 0x1f6a9, 0x1f38c, 0x1f3c1].includes(cp)
const BANNED_WORDS = ['钱', '下注', '赌', '欢乐斗地主']

describe('graphemeCount', () => {
  test('counts user-perceived characters', () => {
    expect(graphemeCount('👍🏽')).toBe(1)
    expect(graphemeCount('👨‍👩‍👧')).toBe(1)
    expect(graphemeCount('等得花都谢了')).toBe(6)
    expect(graphemeCount('😀😀')).toBe(2)
    expect(graphemeCount('')).toBe(0)
  })
})

describe('PhraseList and EmojiList', () => {
  test('reject malformed lists', () => {
    expect(Value.Check(PhraseList, { phrases: [{ id: 'Hurry', text: '快点' }] })).toBe(false)
    expect(Value.Check(PhraseList, { phrases: [{ id: 'hurry', text: '' }] })).toBe(false)
    expect(Value.Check(PhraseList, { phrases: [{ id: 'hurry', text: '快'.repeat(21) }] })).toBe(false)
    expect(Value.Check(PhraseList, { phrases: [{ id: 'hurry', text: '快点', extra: 1 }] })).toBe(false)
    expect(Value.Check(PhraseList, { phrases: [] })).toBe(false)
    expect(Value.Check(EmojiList, { emoji: [''] })).toBe(false)
    expect(Value.Check(EmojiList, { emoji: [] })).toBe(false)
  })
})

describe('example phrase list', () => {
  test('matches the schema', () => {
    expect(Value.Check(PhraseList, phrases)).toBe(true)
  })

  test('has about 30 phrases', () => {
    expect(phraseItems().length).toBeGreaterThanOrEqual(25)
    expect(phraseItems().length).toBeLessThanOrEqual(40)
  })

  test('ids and texts are unique', () => {
    expect(duplicates(phraseItems().map((p) => p.id))).toEqual([])
    expect(duplicates(phraseItems().map((p) => p.text))).toEqual([])
  })

  test('each text is 1 to 20 characters', () => {
    for (const { text } of phraseItems()) {
      expect(graphemeCount(text), text).toBeGreaterThanOrEqual(1)
      expect(graphemeCount(text), text).toBeLessThanOrEqual(20)
    }
  })

  test('has no banned words', () => {
    for (const { text } of phraseItems()) {
      for (const word of BANNED_WORDS) expect(text.includes(word), `${text} contains ${word}`).toBe(false)
    }
  })
})

describe('example emoji list', () => {
  test('matches the schema', () => {
    expect(Value.Check(EmojiList, emoji)).toBe(true)
  })

  test('has about 150 entries', () => {
    expect(emojiItems().length).toBeGreaterThanOrEqual(120)
    expect(emojiItems().length).toBeLessThanOrEqual(180)
  })

  test('entries are unique', () => {
    expect(duplicates(emojiItems())).toEqual([])
  })

  test('each entry is exactly one grapheme', () => {
    for (const e of emojiItems()) expect(graphemeCount(e), e).toBe(1)
  })

  test('has the doudizhu ones', () => {
    for (const e of ['🃏', '👑', '🌾', '🔥', '💥']) expect(emojiItems()).toContain(e)
  })

  test('has no banned or religious emoji', () => {
    for (const e of emojiItems()) {
      const base = e.replace(/️/g, '')
      expect([...BANNED_EMOJI, ...RELIGIOUS_EMOJI], e).not.toContain(base)
    }
  })

  test('has no flags', () => {
    for (const e of emojiItems()) {
      for (const ch of e) expect(isFlagCodePoint(ch.codePointAt(0) ?? 0), e).toBe(false)
    }
  })
})
