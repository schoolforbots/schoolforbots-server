import type { SchoolConfig } from '../shared/config.js'
import type { GameModule } from './game.js'
import { Invites } from './invites.js'
import type { Outbox } from './outbox.js'
import { Reactions, type WordLists } from './reactions.js'
import { type RoomListeners, Rooms, type RoomsOptions } from './rooms.js'
import { Watchers } from './watchers.js'

// The rooms, invitations, reactions and watching made together. They need one another both ways (the rooms send to the
// spectators and tell the others when a game starts, a student sits down or a room closes; the others look at the
// rooms), so they are made here, each given the others by closures that are only called later.

export interface ClubPartsOptions {
  readonly config: SchoolConfig
  readonly game: GameModule
  readonly outbox: Outbox
  readonly wordLists: WordLists
  readonly randomInt?: RoomsOptions['randomInt']
  readonly onError?: RoomsOptions['onError']
  readonly nextClose?: RoomsOptions['nextClose']
  /** Hooks of the caller's own, called after the parts' own. */
  readonly listeners?: RoomListeners
}

export interface ClubParts {
  readonly rooms: Rooms
  readonly invites: Invites
  readonly reactions: Reactions
  readonly watchers: Watchers
}

export function clubParts(options: ClubPartsOptions): ClubParts {
  const { config, game, outbox } = options
  const extra = options.listeners ?? {}
  // Given to the others as closures; set right below, before any of them is called.
  let rooms!: Rooms
  const watchers = new Watchers({ config, rooms: () => rooms })
  const invites = new Invites({ config, outbox, rooms: () => rooms })
  const reactions = new Reactions({
    config,
    game,
    wordLists: options.wordLists,
    rooms: () => rooms,
    watching: (studentId) => watchers.watchedBy(studentId) !== null,
  })
  rooms = new Rooms({
    config,
    game,
    outbox,
    spectators: (roomId) => watchers.spectators(roomId),
    listeners: {
      seated(roomId, studentId, now) {
        watchers.stop(studentId)
        extra.seated?.(roomId, studentId, now)
      },
      gameStarted(roomId, now) {
        reactions.gameStarted(roomId, now)
        extra.gameStarted?.(roomId, now)
      },
      closed(roomId, reason, now) {
        watchers.roomClosed(roomId)
        reactions.roomClosed(roomId)
        invites.roomClosed(roomId)
        extra.closed?.(roomId, reason, now)
      },
    },
    ...(options.randomInt === undefined ? {} : { randomInt: options.randomInt }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.nextClose === undefined ? {} : { nextClose: options.nextClose }),
  })
  return { rooms, invites, reactions, watchers }
}
