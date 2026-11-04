import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi, type MockInstance } from 'vitest'
import { loadModerationData, parseInjectionPatterns, parseWordList } from '../../src/moderation/load.js'

let dir: string
let stderr: MockInstance<typeof process.stderr.write>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'schoolforbots-moderation-'))
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  stderr.mockRestore()
  rmSync(dir, { recursive: true, force: true })
})

test('parseWordList skips blank and comment lines and trims', () => {
  expect(parseWordList('# 注释\n\n词一\n 词二 \n')).toEqual(['词一', '词二'])
  expect(parseWordList('词一\r\n\r\n# 注释\r\n词二\r\n')).toEqual(['词一', '词二'])
  expect(parseWordList('\ufeff# 带 BOM 的注释\n词一')).toEqual(['词一'])
  expect(parseWordList('')).toEqual([])
})

test('parseInjectionPatterns compiles with the iu flags, and keeps each line as the rule reads', () => {
  const [pattern] = parseInjectionPatterns('# 注释\n\n  ignore(all)?previous \n')
  expect(pattern?.source).toBe('ignore(all)?previous')
  expect(pattern?.re.flags).toBe('iu')
  expect(pattern?.re.test('IGNOREALLPREVIOUS')).toBe(true)
})

test('parseInjectionPatterns reports the file line number of a bad pattern', () => {
  expect(() => parseInjectionPatterns('ok\n(未闭合')).toThrow(/第 2 行|line 2/)
  expect(() => parseInjectionPatterns('# 注释\n\nok\n[bad')).toThrow(/第 4 行|line 4/)
})

test('parseInjectionPatterns refuses a pattern that matches the empty string, which would block every text', () => {
  // A stray trailing | adds an empty alternative.
  expect(() => parseInjectionPatterns('ok\n# 注释\n忽略(之前|以上)的设定|')).toThrow(/第 3 行.*空/)
  expect(() => parseInjectionPatterns('.*')).toThrow(/第 1 行/)
  expect(() => parseInjectionPatterns('ok\n(主人)?')).toThrow(/第 2 行/)
})

test('loadModerationData falls back to the example files and warns on stderr', () => {
  writeFileSync(join(dir, 'blocked-words.example.txt'), '# 注释\n示例词\n')
  writeFileSync(join(dir, 'injection-patterns.example.txt'), '# 注释\n示例(话术)\n')
  const data = loadModerationData(dir)
  expect(data.blockedWords).toEqual(['示例词'])
  expect(data.injectionPatterns.map((r) => r.source)).toEqual(['示例(话术)'])
  expect(stderr).toHaveBeenCalledTimes(2)
  const warnings = stderr.mock.calls.map((c) => String(c[0])).join('')
  expect(warnings).toContain('blocked-words.txt')
  expect(warnings).toContain('injection-patterns.txt')
})

test('loadModerationData prefers the real files and stays quiet', () => {
  writeFileSync(join(dir, 'blocked-words.txt'), '真词\n')
  writeFileSync(join(dir, 'injection-patterns.txt'), '真话术\n')
  writeFileSync(join(dir, 'blocked-words.example.txt'), '示例词\n')
  writeFileSync(join(dir, 'injection-patterns.example.txt'), '示例话术\n')
  const data = loadModerationData(dir)
  expect(data.blockedWords).toEqual(['真词'])
  expect(data.injectionPatterns.map((r) => r.source)).toEqual(['真话术'])
  expect(stderr).not.toHaveBeenCalled()
})

test('loadModerationData falls back per file', () => {
  writeFileSync(join(dir, 'blocked-words.txt'), '真词\n')
  writeFileSync(join(dir, 'injection-patterns.example.txt'), '示例话术\n')
  const data = loadModerationData(dir)
  expect(data.blockedWords).toEqual(['真词'])
  expect(data.injectionPatterns.map((r) => r.source)).toEqual(['示例话术'])
  expect(stderr).toHaveBeenCalledTimes(1)
  expect(String(stderr.mock.calls[0]?.[0])).toContain('injection-patterns.txt')
})

test('loadModerationData throws when neither the real nor the example file exists', () => {
  expect(() => loadModerationData(dir)).toThrow(/blocked-words/)
})
