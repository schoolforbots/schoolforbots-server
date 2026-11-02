import { expect, test } from 'vitest'
import { AhoCorasick } from '../../src/moderation/aho-corasick.js'

test('finds a word reached through failure links', () => {
  expect(new AhoCorasick(['he', 'she', 'his', 'hers']).findFirst('ushers')).toBe('she')
  expect(new AhoCorasick(['abcd', 'bce']).findFirst('abce')).toBe('bce')
})

test('returns null for an empty word list or no hit', () => {
  expect(new AhoCorasick([]).findFirst('anything')).toBeNull()
  expect(new AhoCorasick(['xyz']).findFirst('abc')).toBeNull()
  expect(new AhoCorasick(['xyz']).findFirst('')).toBeNull()
})

test('matches Chinese words', () => {
  expect(new AhoCorasick(['静夜思']).findFirst('今天学了静夜思')).toBe('静夜思')
})

test('the hit that ends first wins, even if another starts earlier', () => {
  expect(new AhoCorasick(['abcd', 'bc']).findFirst('abcd')).toBe('bc')
})

test('among hits ending at the same position the longest wins', () => {
  expect(new AhoCorasick(['c', 'bc', 'abc']).findFirst('xabc')).toBe('abc')
  expect(new AhoCorasick(['abc', 'bc', 'c']).findFirst('xabc')).toBe('abc')
})

test('words are normalized at construction', () => {
  expect(new AhoCorasick(['ＡＢＣ 违禁']).findFirst('abc违禁')).toBe('abc违禁')
})

test('empty words never match', () => {
  expect(new AhoCorasick(['', ' ', '​']).findFirst('anything')).toBeNull()
})
