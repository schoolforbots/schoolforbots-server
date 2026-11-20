import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { examplePath, loadWordLists } from '../../src/club/word-lists.js'

let dir: string | undefined
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** A fresh directory with the files given, and the paths of the two lists in it. */
function lists(files: Record<string, unknown>) {
  dir = mkdtempSync(join(tmpdir(), 'club-words-'))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return { phrases: join(dir, 'doudizhu-phrases.json'), emoji: join(dir, 'emoji.json') }
}

const PHRASES = { phrases: [{ id: 'hello', text: '大家好' }, { id: 'thanks', text: '谢谢' }] }
const EMOJI = { emoji: ['😀', '👍🏽', '🃏'] }

describe('loadWordLists', () => {
  test('reads the lists the config names', () => {
    const warnings: string[] = []
    const paths = lists({ 'doudizhu-phrases.json': PHRASES, 'emoji.json': EMOJI })
    expect(loadWordLists(paths, (m) => void warnings.push(m))).toEqual({ ...PHRASES, ...EMOJI })
    expect(warnings).toEqual([])
  })

  test('falls back to the example next to a missing list, and says so', () => {
    const warnings: string[] = []
    const paths = lists({ 'doudizhu-phrases.example.json': PHRASES, 'emoji.json': EMOJI })
    expect(loadWordLists(paths, (m) => void warnings.push(m)).phrases).toEqual(PHRASES.phrases)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('doudizhu-phrases.example.json')
  })

  test('the default paths fall back to the examples of the repository', () => {
    const paths = { phrases: 'config/club/doudizhu-phrases.json', emoji: 'config/club/emoji.json' }
    // The real lists are not in the repository; on a machine that has them they are read instead.
    const got = loadWordLists(paths, () => {})
    expect(got.phrases.length).toBeGreaterThan(0)
    expect(got.emoji.length).toBeGreaterThan(0)
  })

  test('a list that is not there, nor its example, stops the start', () => {
    const paths = lists({ 'emoji.json': EMOJI })
    expect(() => loadWordLists(paths, () => {})).toThrow(/短语表缺失.*doudizhu-phrases\.json.*doudizhu-phrases\.example\.json/)
  })

  test.each([
    ['not JSON', { 'doudizhu-phrases.json': '{', 'emoji.json': EMOJI }, /短语表.*不是合法的 JSON/],
    ['a bad id', { 'doudizhu-phrases.json': { phrases: [{ id: 'Hello', text: '你好' }] }, 'emoji.json': EMOJI }, /短语表.*格式不对/],
    ['no emoji', { 'doudizhu-phrases.json': PHRASES, 'emoji.json': { emoji: [] } }, /emoji 表.*格式不对/],
    [
      'an id twice',
      { 'doudizhu-phrases.json': { phrases: [{ id: 'a', text: '一' }, { id: 'a', text: '二' }] }, 'emoji.json': EMOJI },
      /短语编号重复：a/,
    ],
    [
      'a text twice',
      { 'doudizhu-phrases.json': { phrases: [{ id: 'a', text: '一' }, { id: 'b', text: '一' }] }, 'emoji.json': EMOJI },
      /短语重复：一/,
    ],
    ['an emoji twice', { 'doudizhu-phrases.json': PHRASES, 'emoji.json': { emoji: ['😀', '😀'] } }, /emoji 重复/],
    ['two emoji in one', { 'doudizhu-phrases.json': PHRASES, 'emoji.json': { emoji: ['😀😀'] } }, /不是一个 emoji/],
  ])('%s stops the start, naming the file', (_name, files, error) => {
    expect(() => loadWordLists(lists(files), () => {})).toThrow(error)
  })

  test('the example path is next to the list', () => {
    expect(examplePath('config/club/emoji.json')).toBe('config/club/emoji.example.json')
    expect(examplePath('config/club/emoji')).toBeNull()
  })
})
