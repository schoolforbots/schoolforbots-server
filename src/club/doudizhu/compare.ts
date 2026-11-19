import type { Interpretation } from './classify.js'

// Which move beats which (3.6): the rocket beats everything; a bomb beats everything but the rocket, and a higher
// bomb; any other move beats only a move of the same type and the same number of cards with a lower main rank.

type Comparable = Pick<Interpretation, 'type' | 'main' | 'length'>

/** Whether move `a` may be played on move `b`. A move never beats one of the same main rank. */
export function beats(a: Comparable, b: Comparable): boolean {
  if (b.type === 'rocket') return false
  if (a.type === 'rocket') return true
  if (a.type === 'bomb') return b.type !== 'bomb' || a.main > b.main
  if (b.type === 'bomb') return false
  return a.type === b.type && a.length === b.length && a.main > b.main
}
