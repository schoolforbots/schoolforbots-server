import type { Static } from 'typebox'
import type { DoudizhuRules } from '../../protocol/club.js'

/** The doudizhu rules a game is played by: the protocol's `DoudizhuRules`, as sent in `welcome.rules`. */
export type Rules = Static<typeof DoudizhuRules>

/** The rules the school plays by unless a club sets others. */
export const DEFAULT_DOUDIZHU_RULES: Readonly<Rules> = Object.freeze({
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
