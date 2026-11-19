// The doudizhu rules engine, as the club layer uses it: start a game, take a bid, play or pass, let the trustee act,
// show the table and each seat's turn and hand, and replay a game from its record.

export type { Card, RankName, Suit } from './cards.js'
export type { RandomInt } from './deal.js'
export type { MoveType } from './classify.js'
export { DEFAULT_DOUDIZHU_RULES, type Rules } from './rules.js'
export type { IllegalMove, PlayInput } from './validate.js'
export type { Doubling } from './scoring.js'
export {
  type Auto,
  bid,
  type GameEvent,
  type GameOutcome,
  type GameState,
  type HistoryStep,
  newGame,
  type NewGameOptions,
  pass,
  type Phase,
  play,
  type StepResult,
  type Trick,
} from './game.js'
export { actFor } from './trustee.js'
export { handOf, publicTable, type TableView, turnView, type TurnView } from './view.js'
export { type RecordedStep, replay } from './replay.js'
