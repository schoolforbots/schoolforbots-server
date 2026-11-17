import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import * as club from '../../src/protocol/club.js'
import { exportClubProtocol } from '../../src/protocol/export.js'

const PUBLISHED = [
  // shared types
  'ClubPerson', 'ClubPersonWithClass', 'Rank', 'Cards', 'MoveType', 'Move',
  // what the client sends
  'ClubHelloMessage', 'LobbyListMessage', 'RoomCreateMessage', 'RoomJoinMessage', 'RoomQuickMessage',
  'RoomInviteMessage', 'RoomAcceptMessage', 'RoomDeclineMessage', 'RoomReadyMessage', 'RoomLeaveMessage',
  'RoomBotsMessage', 'TrusteeOffMessage', 'ReactMessage', 'WatchMessage', 'UnwatchMessage', 'DoudizhuBidMessage',
  'DoudizhuPlayMessage', 'DoudizhuPassMessage', 'ClubClientMessage',
  // what the server sends
  'RoomState', 'RoomEvent', 'DoudizhuTable', 'TableAction', 'DoudizhuEvent', 'DoudizhuResult', 'IllegalMoveError',
  'DoudizhuRules', 'ClubStatsSummary', 'RoomResult', 'QuickJoinResult', 'TurnResult',
  'ClubAckMessage', 'ClubWelcomeMessage', 'LobbyMessage', 'InviteMessage', 'InviteEndedMessage', 'RoomEventMessage',
  'RoomLeftMessage', 'HandMessage', 'YourTurnMessage', 'ClubClosingMessage', 'ClubServerMessage',
]

// Plain scalars that the published schemas carry inline; a plugin needs no definition of its own for them.
const NOT_PUBLISHED = ['ClubId', 'RoomId', 'GameId', 'Turn', 'Seq', 'ClubSeat', 'Seat']

test('club protocol export contains every club message and the types they are made of', () => {
  const p = exportClubProtocol()
  expect(p.version).toBe('v1')
  expect(Object.keys(p.$defs).sort()).toEqual([...PUBLISHED].sort())
})

test('every schema club.ts exports is published or left out on purpose', () => {
  const schemas = Object.entries(club)
    .filter(([name]) => name !== 'MOVE_TYPE_NAMES')
    .map(([name]) => name)
  expect(schemas.sort()).toEqual([...PUBLISHED, ...NOT_PUBLISHED].sort())
})

test('committed club protocol file is up to date', () => {
  expect(JSON.parse(readFileSync('protocol/club.schema.json', 'utf8'))).toEqual(exportClubProtocol())
})
