import { describe, expect, test } from 'vitest'
import { chunkIntros, INTROS_EVENT_BYTES, type Intro } from '../../src/class/intros.js'

const intro = (studentId: number): Intro => ({
  studentId,
  ownerName: '阿杰阿杰阿杰阿杰',
  aiName: '小鱼小鱼小鱼小鱼',
  displayName: '阿杰阿杰阿杰阿杰家的小鱼小鱼小鱼小鱼',
  intro: '鱼'.repeat(200),
})

describe('chunkIntros', () => {
  test('a hundred of the longest intros go in as few events as fit, each within the limit, in order', () => {
    const all = Array.from({ length: 100 }, (_, i) => intro(i + 1))
    const chunks = chunkIntros(all)
    for (const chunk of chunks) {
      expect(Buffer.byteLength(JSON.stringify({ kind: 'intros', intros: chunk }))).toBeLessThanOrEqual(INTROS_EVENT_BYTES)
    }
    expect(chunks.flat()).toEqual(all)
    // About 700 bytes each: 17 to an event, so 6 events, not 100.
    expect(chunks.length).toBe(Math.ceil(100 / chunks[0]!.length))
    expect(chunks.length).toBeLessThan(10)
  })

  test('none makes no event; a few make one', () => {
    expect(chunkIntros([])).toEqual([])
    expect(chunkIntros([intro(1), intro(2)])).toHaveLength(1)
  })
})
