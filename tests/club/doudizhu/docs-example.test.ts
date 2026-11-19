import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { rankValue, type RankName } from '../../../src/club/doudizhu/cards.js'
import { classify, type MoveType } from '../../../src/club/doudizhu/classify.js'
import { legalMoves, toMove } from '../../../src/club/doudizhu/moves.js'
import { DEFAULT_DOUDIZHU_RULES } from '../../../src/club/doudizhu/rules.js'
import { checkPlay, type PlayContext } from '../../../src/club/doudizhu/validate.js'
import { hand } from './helpers.js'

// The example game of the API documents shows a `your_turn`, a play that does not beat, and the `illegal_move` it gets.
// The engine must give exactly what the documents show for that position.

const fromRoot = (relative: string) => fileURLToPath(new URL(`../../../${relative}`, import.meta.url))

interface Frame {
  type?: string
  [key: string]: unknown
}

interface YourTurn {
  me: { seat: number; hand: RankName[] }
  table: { trick: { last: { seat: number; move: { type: MoveType; cards: RankName[] } } | null } | null }
  moves: { id: number; type: MoveType; name: string; cards: RankName[] }[] | null
}

function framesOf(file: string): Frame[] {
  const text = readFileSync(fromRoot(file), 'utf8')
  return [...text.matchAll(/^```json\n([\s\S]*?)^```$/gm)].map((match) => JSON.parse(match[1]!) as Frame)
}

const rules = DEFAULT_DOUDIZHU_RULES

describe('the illegal_move of the example game', () => {
  for (const file of ['docs/api.md', 'docs/api.en.md']) {
    test(`is what the engine says, in ${file}`, () => {
      const frames = framesOf(file)
      const turn = frames.find((f) => f.type === 'your_turn' && f['phase'] === 'play') as unknown as YourTurn
      expect(turn, `${file} has no your_turn to play`).toBeDefined()
      const playIndex = frames.findIndex((f) => f.type === 'play' && 'cards' in f)
      const play = frames[playIndex] as unknown as { cards: RankName[] }
      const ack = frames.slice(playIndex).find((f) => f.type === 'ack' && f['ok'] === false) as unknown as {
        error: { problem: string; reason: string; toBeat: unknown }
      }
      expect(ack, `${file} has no refused ack after the play`).toBeDefined()

      const last = turn.table.trick!.last!
      const toBeatMove = classify(last.move.cards.map(rankValue), rules).find((r) => r.type === last.move.type)!
      const h = hand(turn.me.hand.join(' '))
      const listed = legalMoves(h, toBeatMove, rules)
      const context: PlayContext = {
        seat: turn.me.seat,
        hand: h,
        moves: listed.moves,
        toBeat: { seat: last.seat, move: toBeatMove },
        rules,
      }
      // The list the document shows is the engine's list.
      expect(turn.moves).toEqual(listed.moves.map((move, i) => ({ id: i + 1, ...toMove(move) })))

      const result = checkPlay(context, { cards: play.cards })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(ack.error.problem).toBe(result.error.problem)
      expect(ack.error.reason).toBe(result.error.reason)
      expect(ack.error.toBeat).toEqual(result.error.toBeat)
    })
  }
})
