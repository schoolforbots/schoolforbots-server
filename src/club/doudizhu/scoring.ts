// Scoring (3.7): the multiplier starts at 1 and doubles for every bomb played, for the rocket, and for a spring or
// anti-spring when the rules say so. The score of the game is the base (the winning bid) times the multiplier, capped:
// the landlord wins or loses twice that, each farmer the other way once, so the three scores add up to 0.

/** One doubling and its cause: a bomb or rocket with the seat that played it, a spring or anti-spring with none. */
export interface Doubling {
  readonly kind: 'bomb' | 'rocket' | 'spring' | 'anti_spring'
  readonly seat: number | null
}

/** The multiplier the doublings make, before the cap. */
export function rawMultiplier(doublings: readonly unknown[]): number {
  return 2 ** doublings.length
}

/**
 * Whether the deal ended in a spring or an anti-spring. A spring: the landlord won and neither farmer played a card.
 * An anti-spring: the farmers won and the landlord played only once (the lead that opened the play). `movesBy` is the
 * number of moves each seat played, by seat.
 */
export function springOf(
  landlord: number,
  landlordWon: boolean,
  movesBy: readonly number[],
): 'spring' | 'anti_spring' | null {
  const farmers = [0, 1, 2].filter((seat) => seat !== landlord)
  if (landlordWon) return farmers.every((seat) => movesBy[seat] === 0) ? 'spring' : null
  return movesBy[landlord] === 1 ? 'anti_spring' : null
}

export interface Settlement {
  /** The multiplier after the cap. */
  readonly multiplier: number
  /** Whether the cap cut the multiplier. */
  readonly capped: boolean
  /** Each seat's score, by seat; they add up to 0. */
  readonly scores: [number, number, number]
}

/** The multiplier after the cap and the scores of a game the landlord won or lost. */
export function settle(
  landlord: number,
  base: number,
  landlordWon: boolean,
  rawMultiplier: number,
  cap: number,
): Settlement {
  const multiplier = Math.min(rawMultiplier, cap)
  const score = base * multiplier
  const sign = landlordWon ? 1 : -1
  const scores: [number, number, number] = [0, 0, 0]
  for (let seat = 0; seat < 3; seat++) scores[seat] = seat === landlord ? sign * 2 * score : -sign * score
  return { multiplier, capped: rawMultiplier > cap, scores }
}
