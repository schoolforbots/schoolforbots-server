import { MOVE_TYPE_NAMES } from '../../protocol/club.js'
import { BLACK_JOKER, toRank, TWO } from './cards.js'
import type { ClassifyRules, Interpretation, MoveType } from './classify.js'

// The Chinese reasons of `illegal_move`, written for a model to read as is: what was wrong, and what to do instead.
// Cards are written as protocol ranks, low to high, separated by spaces.

/** Some cards as text: `3 3 10 小王`. */
export function cardsText(ranks: readonly number[]): string {
  return [...ranks]
    .sort((a, b) => a - b)
    .map(toRank)
    .join(' ')
}

const COUNT_WORDS = ['', '一', '两', '三', '四']

/** A count of cards: `一张` to `四张`, then `5 张`, `6 张` and so on. */
const countText = (n: number): string => {
  const word = COUNT_WORDS[n]
  return word === undefined || word === '' ? `${n} 张` : `${word}张`
}

/** Cards counted by rank: `一张 7、两张 9`, `5 张 7`. */
function countedText(ranks: readonly number[]): string {
  const counts = new Map<number, number>()
  for (const rank of [...ranks].sort((a, b) => a - b)) counts.set(rank, (counts.get(rank) ?? 0) + 1)
  return [...counts].map(([rank, n]) => `${countText(n)} ${toRank(rank)}`).join('、')
}

const typeName = (type: MoveType): string => MOVE_TYPE_NAMES[type]

/** The types a chain may be, and so whether some cards are a chain spoiled by a 2 or a joker. */
const CHAIN_HINTS: readonly { per: number; hint: string }[] = [
  { per: 1, hint: '（2 和王不能进顺子）' },
  { per: 2, hint: '（2 不能进双顺）' },
  { per: 3, hint: '（2 不能进三顺和飞机）' },
]

/**
 * The hint for cards that would look like a chain but for a 2 or a joker: every rank the same number of times (one,
 * two or three), enough ranks for a chain, a 2 or a joker among them, and the other ranks running on with no gap.
 * `3 4 5 6 2` gets it; `3 5 6 7 2` does not, since it would be no chain even without the 2.
 */
function chainHint(ranks: readonly number[], rules: Pick<ClassifyRules, 'minPairStraight'>): string {
  const counts = new Map<number, number>()
  for (const rank of ranks) counts.set(rank, (counts.get(rank) ?? 0) + 1)
  const per = counts.values().next().value
  if (per === undefined || ![...counts.values()].every((n) => n === per)) return ''
  const fewest = per === 1 ? 5 : per === 2 ? rules.minPairStraight : 2
  if (counts.size < fewest) return ''
  const spoilers = (rank: number): boolean => rank === TWO || rank >= BLACK_JOKER
  if (![...counts.keys()].some(spoilers)) return ''
  const rest = [...counts.keys()].filter((rank) => !spoilers(rank)).sort((a, b) => a - b)
  if (rest.length === 0 || rest[rest.length - 1]! - rest[0]! + 1 !== rest.length) return ''
  return CHAIN_HINTS.find((entry) => entry.per === per)?.hint ?? ''
}

export function unknownMoveReason(moveId: number): string {
  return `清单里没有编号 ${moveId} 的出法，请从这次给你的清单里选，或者直接报牌。`
}

/** `missing` is the cards short, one entry per card. */
export function notInHandReason(missing: readonly number[]): string {
  return `你手里没有这些牌：还缺 ${countedText(missing)}。`
}

export function notATypeReason(ranks: readonly number[], rules: Pick<ClassifyRules, 'minPairStraight'>): string {
  return `${cardsText(ranks)} 凑不成任何牌型${chainHint(ranks, rules)}。`
}

/** `readings` are the readings the cards do have, in `classify` order. */
export function typeMismatchReason(ranks: readonly number[], as: MoveType, readings: readonly Interpretation[]): string {
  const types = [...new Set(readings.map((reading) => typeName(reading.type)))]
  return `${cardsText(ranks)} 不能当 ${typeName(as)} 出。这手牌可以当：${types.join('、')}。`
}

/** How a move to beat is named in a reason: `一对 5`, or its cards. */
function moveText(move: Interpretation): string {
  const rank = toRank(move.main)
  if (move.type === 'single') return `一张 ${rank}`
  if (move.type === 'pair') return `一对 ${rank}`
  return cardsText(move.cards)
}

/** The types whose moves come in more than one length: they beat only a move of the same number of cards. */
const VARIABLE_LENGTH: ReadonlySet<MoveType> = new Set([
  'straight',
  'pair_straight',
  'trio_straight',
  'plane_solo',
  'plane_pair',
])

/**
 * The reason a move does not beat the move to beat. `seat` is the seat to act and `toBeatSeat` the seat that played
 * the move to beat: the seat before it (上家) or after it (下家). `hint` is another type the cards could be played as
 * that would beat, to suggest `as`.
 */
export function cannotBeatReason(seat: number, toBeatSeat: number, toBeat: Interpretation, hint?: MoveType): string {
  const who = toBeatSeat === (seat + 2) % 3 ? '上家' : '下家'
  const what = `${who}出的是${typeName(toBeat.type)}（${moveText(toBeat)}），`
  let need: string
  if (toBeat.type === 'rocket') need = '没有牌能压住，只能不要。'
  else if (toBeat.type === 'bomb') need = '你要出更大的炸弹，或者王炸；也可以不要。'
  else if (VARIABLE_LENGTH.has(toBeat.type)) {
    need = `你要出同样 ${toBeat.length} 张、更大的${typeName(toBeat.type)}，或者炸弹、王炸；也可以不要。`
  } else need = `你要出更大的${typeName(toBeat.type)}，或者炸弹、王炸；也可以不要。`
  const asHint = hint === undefined ? '' : `这手牌也能当${typeName(hint)}出，要这样出请加 "as": "${hint}"。`
  return what + need + asHint
}

export function mustPlayReason(): string {
  return '这一轮由你先出，不能不要，请出任意一手合法的牌。'
}

/** `highest` is the highest bid so far, 1 or more. */
export function bidTooLowReason(highest: number): string {
  const higher: string[] = []
  for (let bid = highest + 1; bid <= 3; bid++) higher.push(`${bid} 分`)
  const choices = higher.length === 0 ? '你只能叫 0 分（不叫）' : `你只能叫 ${higher.join('、')}，或者叫 0 分（不叫）`
  return `前面已经有人叫了 ${highest} 分，${choices}。`
}
