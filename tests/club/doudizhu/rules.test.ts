import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Value from 'typebox/value'
import { describe, expect, test } from 'vitest'
import { DEFAULT_DOUDIZHU_RULES } from '../../../src/club/doudizhu/rules.js'
import { DoudizhuRules } from '../../../src/protocol/club.js'

const fromRoot = (relative: string) => fileURLToPath(new URL(`../../../${relative}`, import.meta.url))

/** The `rules` of the `welcome` frame in the example game of an API document. */
function welcomeRulesIn(file: string): unknown {
  const text = readFileSync(fromRoot(file), 'utf8')
  const blocks = [...text.matchAll(/^```json\n([\s\S]*?)^```$/gm)].map((match) => match[1]!)
  const welcome = blocks.map((block) => JSON.parse(block) as { type?: string; rules?: unknown }).find((frame) => {
    return frame.type === 'welcome'
  })
  expect(welcome, `${file} has no welcome frame`).toBeDefined()
  return welcome!.rules
}

describe('the default doudizhu rules', () => {
  test('are valid rules of the protocol', () => {
    expect(Value.Check(DoudizhuRules, DEFAULT_DOUDIZHU_RULES)).toBe(true)
  })

  test('are the school rules', () => {
    expect(DEFAULT_DOUDIZHU_RULES).toEqual({
      game: 'doudizhu',
      bidSeconds: 60,
      playSeconds: 60,
      bidRedealLimit: 3,
      bareTrio: true,
      minPairStraight: 3,
      soloKickersMayPair: true,
      soloKickersMayBeJokers: true,
      fourWithTwo: true,
      springDoubles: true,
      cap: 64,
    })
  })

  test('cannot be changed by accident', () => {
    expect(Object.isFrozen(DEFAULT_DOUDIZHU_RULES)).toBe(true)
  })

  test('are the rules the API documents show in their welcome example', () => {
    for (const file of ['docs/api.md', 'docs/api.en.md']) {
      expect(welcomeRulesIn(file), file).toEqual(DEFAULT_DOUDIZHU_RULES)
    }
  })
})
