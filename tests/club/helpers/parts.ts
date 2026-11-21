import { readFileSync } from 'node:fs'
import type { InviteTarget } from '../../../src/club/invites.js'
import { type ClubParts, clubParts, type ClubPartsOptions } from '../../../src/club/parts.js'
import type { WordLists } from '../../../src/club/reactions.js'
import type { ClubStudent } from '../../../src/club/rooms.js'
import type { SchoolConfig } from '../../../src/shared/config.js'
import { fakeGame, type FakeGame, QUICK_DECK } from './fake-game.js'
import { RecordingOutbox } from './outbox.js'
import { exampleConfig, T0 } from './rooms.js'

// The rooms with invitations, reactions and watching plugged in (`clubParts`), the fake game, a recording outbox,
// the example word lists, and a clock that moves only when a test moves it.

export const exampleWordLists: WordLists = {
  emoji: (JSON.parse(readFileSync('config/club/emoji.example.json', 'utf8')) as { emoji: string[] }).emoji,
  phrases: (JSON.parse(readFileSync('config/club/doudizhu-phrases.example.json', 'utf8')) as WordLists).phrases,
}

export interface PartsHarness extends ClubParts {
  readonly outbox: RecordingOutbox
  readonly game: FakeGame
  readonly config: SchoolConfig
  now: Date
  /** Moves the clock on by `seconds` and ticks the rooms and the invitations. */
  advance(seconds: number): void
}

export function partsHarness(
  club: Partial<SchoolConfig['club']> = {},
  now: Date = T0,
  reactions?: FakeGame['reactions'],
  onError?: ClubPartsOptions['onError'],
): PartsHarness {
  const config: SchoolConfig = { ...exampleConfig, club: { ...exampleConfig.club, ...club } }
  const outbox = new RecordingOutbox()
  const fake = fakeGame({ decks: [QUICK_DECK], firstBidder: 0 })
  // A game that allows other reactions than the fake game's, for the tests of what the club layer does with them.
  const game: FakeGame = reactions === undefined ? fake : { ...fake, reactions }
  const parts = clubParts({
    config,
    game,
    outbox,
    wordLists: exampleWordLists,
    ...(onError === undefined ? {} : { onError }),
  })
  const h: PartsHarness = {
    ...parts,
    outbox,
    game,
    config,
    now,
    advance(seconds) {
      h.now = new Date(h.now.getTime() + seconds * 1000)
      parts.rooms.tick(h.now)
      parts.invites.tick(h.now)
    },
  }
  return h
}

/** Every student given is a member; anyone else is not. */
export function members(...students: ClubStudent[]): (studentId: number) => InviteTarget | null {
  const byId = new Map(students.map((s) => [s.person.studentId, { studentId: s.person.studentId, email: s.email }]))
  return (studentId) => byId.get(studentId) ?? null
}
