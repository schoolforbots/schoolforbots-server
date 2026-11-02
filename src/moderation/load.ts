import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModerationData } from './moderator.js'

/** Non-blank, non-comment lines (trimmed) with their 1-based line numbers. */
function dataLines(text: string): { line: number; value: string }[] {
  const out: { line: number; value: string }[] = []
  text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const value = raw.trim()
      if (value !== '' && !value.startsWith('#')) out.push({ line: i + 1, value })
    })
  return out
}

export function parseWordList(text: string): string[] {
  return dataLines(text).map((l) => l.value)
}

export function parseInjectionPatterns(text: string): RegExp[] {
  return dataLines(text).map(({ line, value }) => {
    try {
      return new RegExp(value, 'iu')
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(`injection-patterns 第 ${line} 行的正则无效：${reason}`)
    }
  })
}

/** Reads `<name>.txt`, or `<name>.example.txt` (with a stderr warning) when it is missing. */
function readDataFile(dir: string, name: string): string {
  const real = join(dir, `${name}.txt`)
  if (existsSync(real)) return readFileSync(real, 'utf8')
  const example = join(dir, `${name}.example.txt`)
  process.stderr.write(`[moderation] 未找到 ${real}，改用示例文件 ${example}（只有占位内容，部署前请放入真实数据）\n`)
  return readFileSync(example, 'utf8')
}

export function loadModerationData(dir: string): ModerationData {
  return {
    blockedWords: parseWordList(readDataFile(dir, 'blocked-words')),
    injectionPatterns: parseInjectionPatterns(readDataFile(dir, 'injection-patterns')),
  }
}
