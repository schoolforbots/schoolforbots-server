import type { TSchema } from 'typebox'
import Value from 'typebox/value'
import { describe, expect, test } from 'vitest'
import {
  Cards,
  ClubClientMessage,
  ClubPerson,
  ClubPersonWithClass,
  ClubServerMessage,
  DoudizhuEvent,
  DoudizhuResult,
  DoudizhuTable,
  MOVE_TYPE_NAMES,
  Move,
  MoveType,
  Rank,
  RoomEvent,
  RoomId,
  RoomState,
  Seat,
  TableAction,
} from '../../src/protocol/club.js'

const ok = (schema: TSchema, value: unknown): boolean => Value.Check(schema, value)
type Case = [name: string, value: unknown]

const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', '小王', '大王']
const MOVE_TYPES = [
  'single', 'pair', 'trio', 'trio_solo', 'trio_pair', 'straight', 'pair_straight', 'trio_straight',
  'plane_solo', 'plane_pair', 'four_two_solo', 'four_two_pair', 'bomb', 'rocket',
]

const student = { studentId: 37, displayName: '阿杰家的小鱼 #0037', bot: false }
const bot = { studentId: null, displayName: '陪练小一', bot: true }

describe('shared types', () => {
  test.each(RANKS)('Rank accepts %s', (rank) => {
    expect(ok(Rank, rank)).toBe(true)
  })

  test.each(['1', 'T', 'joker', '♠3', '', 3])('Rank rejects %s', (rank) => {
    expect(ok(Rank, rank)).toBe(false)
  })

  test('Cards accepts 1 to 20 cards', () => {
    expect(ok(Cards, ['3'])).toBe(true)
    expect(ok(Cards, Array<string>(20).fill('3'))).toBe(true)
  })

  test.each<Case>([
    ['an empty array', []],
    ['21 cards', Array<string>(21).fill('3')],
    ['a card with a suit', ['♠3']],
  ])('Cards rejects %s', (_name, cards) => {
    expect(ok(Cards, cards)).toBe(false)
  })

  test.each<Case>([
    ['a student', student],
    ['a bot', bot],
  ])('ClubPerson accepts %s', (_name, person) => {
    expect(ok(ClubPerson, person)).toBe(true)
  })

  test.each<Case>([
    ['studentId 0', { ...student, studentId: 0 }],
    ['a fractional studentId', { ...student, studentId: 1.5 }],
    ['no bot', { studentId: 37, displayName: '阿杰家的小鱼 #0037' }],
    ['no displayName', { studentId: 37, bot: false }],
  ])('ClubPerson rejects %s', (_name, person) => {
    expect(ok(ClubPerson, person)).toBe(false)
  })

  test('ClubPersonWithClass takes a class name, or null for a bot', () => {
    expect(ok(ClubPersonWithClass, { ...student, className: '初中部·晚班·3 班' })).toBe(true)
    expect(ok(ClubPersonWithClass, { ...bot, className: null })).toBe(true)
    expect(ok(ClubPersonWithClass, student)).toBe(false)
  })

  test('RoomId is a short lowercase string starting with r', () => {
    expect(ok(RoomId, 'r7k2q')).toBe(true)
    expect(ok(RoomId, 'r' + 'a'.repeat(15))).toBe(true)
    expect(ok(RoomId, 'r7k2')).toBe(false)
    expect(ok(RoomId, 'R7K2Q')).toBe(false)
    expect(ok(RoomId, 'x7k2q')).toBe(false)
    expect(ok(RoomId, 'r' + 'a'.repeat(16))).toBe(false)
  })

  test('Seat is 0, 1 or 2', () => {
    expect([0, 1, 2].every((seat) => ok(Seat, seat))).toBe(true)
    expect(ok(Seat, 3)).toBe(false)
    expect(ok(Seat, -1)).toBe(false)
    expect(ok(Seat, 1.5)).toBe(false)
  })

  test('MoveType has exactly the 14 move types', () => {
    expect(MOVE_TYPES.every((type) => ok(MoveType, type))).toBe(true)
    expect(ok(MoveType, 'quad')).toBe(false)
  })

  test('MOVE_TYPE_NAMES has a Chinese name for exactly the values of MoveType', () => {
    const values = (MoveType as unknown as { anyOf: { const: string }[] }).anyOf.map((s) => s.const)
    expect(Object.keys(MOVE_TYPE_NAMES).sort()).toEqual([...values].sort())
    expect(Object.keys(MOVE_TYPE_NAMES).sort()).toEqual([...MOVE_TYPES].sort())
    for (const name of Object.values(MOVE_TYPE_NAMES)) expect(name).toMatch(/^[一-鿿]+$/)
  })

  test('Move takes a type, its Chinese name and the cards', () => {
    expect(ok(Move, { type: 'pair', name: '对牌', cards: ['9', '9'] })).toBe(true)
    expect(ok(Move, { type: 'pair', name: '对牌', cards: [] })).toBe(false)
    expect(ok(Move, { type: 'quad', name: '四张', cards: ['9', '9', '9', '9'] })).toBe(false)
  })
})

describe('client messages', () => {
  const hello = { id: 'c1', type: 'hello', protocol: 'v1', plugin: { type: 'openclaw', version: '1.2.3' }, club: 'doudizhu' }
  const play = { id: 'c9', type: 'play', game: 'doudizhu', turn: 7 }
  const react = { id: 'c10', type: 'react' }

  test.each<Case>([
    ['hello', hello],
    ['hello with roomId', { ...hello, roomId: 'r7k2q' }],
    ['hello with roomId and lastSeq', { ...hello, roomId: 'r7k2q', lastSeq: 12 }],
    ['hello with lastSeq 0', { ...hello, roomId: 'r7k2q', lastSeq: 0 }],
    ['lobby.list', { id: 'c2', type: 'lobby.list' }],
    ['room.create', { id: 'c3', type: 'room.create', visibility: 'public', bots: false }],
    ['room.create with bots', { id: 'c3', type: 'room.create', visibility: 'invite', bots: true }],
    ['room.create inviting two', { id: 'c3', type: 'room.create', visibility: 'invite', bots: false, invite: [12, 37] }],
    ['room.join', { id: 'c4', type: 'room.join', roomId: 'r7k2q' }],
    ['room.quick', { id: 'c5', type: 'room.quick' }],
    ['room.invite', { id: 'c6', type: 'room.invite', to: 12 }],
    ['room.accept', { id: 'c7', type: 'room.accept', inviteId: 3 }],
    ['room.decline', { id: 'c7', type: 'room.decline', inviteId: 3 }],
    ['room.ready', { id: 'c8', type: 'room.ready' }],
    ['room.leave', { id: 'c8', type: 'room.leave' }],
    ['room.bots', { id: 'c8', type: 'room.bots' }],
    ['trustee.off', { id: 'c8', type: 'trustee.off' }],
    ['react with an emoji', { ...react, kind: 'emoji', content: '👍' }],
    ['react with an emoji to someone', { ...react, kind: 'emoji', content: '🙄', to: 12 }],
    ['react with a phrase', { ...react, kind: 'phrase', content: 'p01' }],
    ['react with a phrase to someone', { ...react, kind: 'phrase', content: 'p01', to: 12, visibility: 'room' }],
    ['react with private text to someone', { ...react, kind: 'text', content: '打得好', to: 12, visibility: 'private' }],
    ['react with content at the cap', { ...react, kind: 'text', content: 'x'.repeat(200) }],
    ['watch', { id: 'c11', type: 'watch', roomId: 'r7k2q' }],
    ['unwatch', { id: 'c11', type: 'unwatch' }],
    ['bid', { id: 'c12', type: 'bid', game: 'doudizhu', turn: 1, bid: 3 }],
    ['bid 0 (no bid)', { id: 'c12', type: 'bid', game: 'doudizhu', turn: 2, bid: 0 }],
    ['play by moveId', { ...play, moveId: 4 }],
    ['play by cards', { ...play, cards: ['3', '3', '3', '4'] }],
    ['play by cards as a move type', { ...play, cards: ['5', '5', '5', '6', '6', '6', '7', '7', '7', '8', '8', '8'], as: 'plane_solo' }],
    ['pass', { id: 'c13', type: 'pass', game: 'doudizhu', turn: 8 }],
  ])('accepts %s', (_name, message) => {
    expect(ok(ClubClientMessage, message)).toBe(true)
  })

  test.each<Case>([
    ['an unknown type', { id: 'c1', type: 'shout' }],
    ['no id', { type: 'room.ready' }],
    ['an id over 64 characters', { id: 'x'.repeat(65), type: 'room.ready' }],
    ['hello without club', { id: 'c1', type: 'hello', protocol: 'v1', plugin: { type: 'openclaw', version: '1.2.3' } }],
    ['hello to another club', { ...hello, club: 'chess' }],
    ['hello with lastSeq but no roomId', { ...hello, lastSeq: 12 }],
    ['hello with a negative lastSeq', { ...hello, roomId: 'r7k2q', lastSeq: -1 }],
    ['hello for another protocol', { ...hello, protocol: 'v2' }],
    ['hello with a malformed roomId', { ...hello, roomId: 'R7K2Q' }],
    ['room.create inviting three', { id: 'c3', type: 'room.create', visibility: 'invite', bots: false, invite: [12, 37, 40] }],
    ['room.create inviting someone twice', { id: 'c3', type: 'room.create', visibility: 'invite', bots: false, invite: [12, 12] }],
    ['room.create with another visibility', { id: 'c3', type: 'room.create', visibility: 'secret', bots: false }],
    ['room.create without bots', { id: 'c3', type: 'room.create', visibility: 'public' }],
    ['room.join with a malformed roomId', { id: 'c4', type: 'room.join', roomId: 'x7k2q' }],
    ['watch with a malformed roomId', { id: 'c11', type: 'watch', roomId: 'r7k' }],
    ['room.invite to studentId 0', { id: 'c6', type: 'room.invite', to: 0 }],
    ['bid 4', { id: 'c12', type: 'bid', game: 'doudizhu', turn: 1, bid: 4 }],
    ['bid 1.5', { id: 'c12', type: 'bid', game: 'doudizhu', turn: 1, bid: 1.5 }],
    ['bid without game', { id: 'c12', type: 'bid', turn: 1, bid: 3 }],
    ['bid without turn', { id: 'c12', type: 'bid', game: 'doudizhu', bid: 3 }],
    ['play with both moveId and cards', { ...play, moveId: 4, cards: ['3'] }],
    ['play with neither moveId nor cards', play],
    ['play by moveId with as', { ...play, moveId: 4, as: 'single' }],
    ['play with moveId 0', { ...play, moveId: 0 }],
    ['play with a suited card', { ...play, cards: ['♠3'] }],
    ['play as an unknown move type', { ...play, cards: ['3', '3', '3', '3'], as: 'quad' }],
    ['play with turn 0', { ...play, turn: 0, moveId: 4 }],
    ['play without game', { id: 'c9', type: 'play', turn: 7, moveId: 4 }],
    ['play in another game', { ...play, game: 'chess', moveId: 4 }],
    ['pass without game', { id: 'c13', type: 'pass', turn: 8 }],
    ['pass with turn 0', { id: 'c13', type: 'pass', game: 'doudizhu', turn: 0 }],
    ['react private without to', { ...react, kind: 'text', content: '打得好', visibility: 'private' }],
    ['react with content over 200 characters', { ...react, kind: 'text', content: 'x'.repeat(201) }],
    ['react of another kind', { ...react, kind: 'sticker', content: 'x' }],
    ['react with another visibility', { ...react, kind: 'emoji', content: '👍', visibility: 'all' }],
    ['not an object', 'hello'],
  ])('rejects %s', (_name, message) => {
    expect(ok(ClubClientMessage, message)).toBe(false)
  })
})

describe('server messages', () => {
  const at = '2026-11-17T12:00:00.000Z'
  const later = '2026-11-17T12:01:00.000Z'
  const withClass = { ...student, className: '初中部·晚班·3 班' }
  const other = { studentId: 102, displayName: '小林家的阿花 #0102', bot: false }
  const pair9 = { type: 'pair', name: '对牌', cards: ['9', '9'] }
  const single3 = { type: 'single', name: '单牌', cards: ['3'] }
  const table = {
    game: 'doudizhu', gameId: 5, phase: 'playing', firstBidder: 1,
    bids: [{ seat: 1, bid: 1 }, { seat: 2, bid: 3 }],
    landlord: 2, base: 3, bottom: ['3', 'K', '大王'],
    cardsLeft: [15, 17, 19], multiplier: 2,
    trick: { leader: 2, last: { seat: 0, move: pair9 } },
    history: [
      { turn: 1, seat: 1, action: 'bid', bid: 1, auto: null },
      { turn: 2, seat: 2, action: 'bid', bid: 3, auto: 'timeout' },
      { turn: 3, seat: 2, action: 'play', move: single3, auto: null },
      { turn: 4, seat: 0, action: 'pass', auto: 'trustee' },
      { turn: 5, seat: 1, action: 'pass', auto: 'bot' },
      { turn: 6, seat: 2, action: 'play', move: single3, auto: 'closing' },
      { turn: 7, seat: 0, action: 'play', move: pair9, auto: null },
    ],
    trustee: [false, false, true], toAct: 1, deadline: later,
  }
  const biddingTable = {
    ...table, phase: 'bidding', bids: [{ seat: 1, bid: 0 }], landlord: null, base: null, bottom: null,
    cardsLeft: [17, 17, 17], multiplier: 1, trick: null, history: [{ turn: 1, seat: 1, action: 'bid', bid: 0, auto: null }],
    trustee: [false, false, false], toAct: 2,
  }
  const room = {
    roomId: 'r7k2q', club: 'doudizhu', visibility: 'public', host: 37,
    seats: [
      { seat: 0, player: student, ready: true, online: true, trustee: false },
      { seat: 1, player: bot, ready: true, online: true, trustee: false },
      { seat: 2, player: null, ready: false, online: false, trustee: false },
    ],
    spectators: 0, gamesPlayed: 2, closesAt: later, lastSeq: 40, game: null,
  }
  const result = {
    gameId: 5, outcome: 'landlord_won', landlord: 2, base: 3,
    doublings: [{ kind: 'bomb', seat: 0 }, { kind: 'spring', seat: null }],
    multiplier: 4, capped: false, scores: [-12, -12, 24],
    hands: [['3', '4'], ['5', '5', '小王'], []], bottom: ['3', 'K', '大王'], ranked: true,
  }
  const noLandlord = {
    gameId: 6, outcome: 'no_landlord', landlord: null, base: null, doublings: [], multiplier: 1, capped: false,
    scores: [0, 0, 0], hands: [['3'], ['4'], ['5']], bottom: null, ranked: false,
  }
  const welcome = {
    type: 'welcome',
    student: withClass,
    club: { id: 'doudizhu', name: '斗地主社团' },
    closesAt: later,
    limits: {
      framesPerMinute: 60, bidSeconds: 60, playSeconds: 60, timeBankSeconds: 120, inviteSeconds: 180,
      idleMinutes: 10, idleDecideSeconds: 180, maxSpectators: 20, reactMinIntervalSeconds: 5, reactsPerGame: 20,
    },
    reactions: {
      kinds: ['emoji', 'phrase'], visibility: ['room'], emoji: ['👍', '🙄'], phrases: [{ id: 'p01', text: '快点吧，我等得花儿都谢了' }],
    },
    rules: {
      game: 'doudizhu', bidRedealLimit: 3, bareTrio: true, minPairStraight: 3, soloKickersMayPair: true,
      soloKickersMayBeJokers: true, fourWithTwo: true, springDoubles: true, cap: 64,
    },
    room: null,
  }
  const bidTurn = {
    type: 'your_turn', roomId: 'r7k2q', game: 'doudizhu', gameId: 5, turn: 2, phase: 'bid',
    deadline: later, timeBankSeconds: 120, closesAt: later,
    me: { seat: 2, role: null, hand: ['3', '4', '5'] },
    left: { seat: 1, player: other, role: null, cardsLeft: 17 },
    right: { seat: 0, player: student, role: null, cardsLeft: 17 },
    table: biddingTable, unseen: ['6', '7'], bids: [0, 2, 3], moves: null, canPass: false, movesTrimmed: false,
  }
  const playTurn = {
    ...bidTurn, turn: 8, phase: 'play', me: { seat: 1, role: 'farmer', hand: ['10', '10', 'J'] },
    left: { seat: 0, player: student, role: 'farmer', cardsLeft: 15 },
    right: { seat: 2, player: other, role: 'landlord', cardsLeft: 19 },
    table, unseen: [], bids: null,
    moves: [{ id: 1, type: 'pair', name: '对牌', cards: ['10', '10'] }], canPass: true, movesTrimmed: true,
  }
  const roomEvent = (event: unknown) => ({ type: 'room.event', roomId: 'r7k2q', seq: 3, replayed: false, at, event })
  const gameEvent = (event: unknown) => roomEvent({ kind: 'game', game: 'doudizhu', event })

  test.each<Case>([
    ['ack ok', { type: 'ack', id: 'c1', ok: true }],
    ['ack ok with a turn', { type: 'ack', id: 'c1', ok: true, result: { turn: 8 } }],
    ['ack failed', { type: 'ack', id: 'c1', ok: false, error: { code: 'room_full', message: '这个房间已经坐满了。' } }],
    ['welcome', welcome],
    ['welcome back in a room', { ...welcome, room: { ...room, game: table } }],
    ['lobby', {
      type: 'lobby',
      rooms: [{ roomId: 'r7k2q', host: withClass, seatsFree: 2, bots: false, gamesPlayed: 0 }],
    }],
    ['an empty lobby', { type: 'lobby', rooms: [] }],
    ['invite', { type: 'invite', inviteId: 3, from: withClass, roomId: 'r7k2q', expiresAt: later }],
    ['invite.ended', { type: 'invite.ended', inviteId: 3, reason: 'expired' }],
    ['room.left', { type: 'room.left', roomId: 'r7k2q', reason: 'not_ready' }],
    ['hand', { type: 'hand', roomId: 'r7k2q', game: 'doudizhu', gameId: 5, cards: ['3', '3', '大王'] }],
    ['your_turn to bid', bidTurn],
    ['your_turn to play', playTurn],
    ['room.event joined', roomEvent({ kind: 'joined', seat: 1, player: other })],
    ['room.event left', roomEvent({ kind: 'left', seat: 1, player: other, reason: 'disconnected_idle' })],
    ['room.event host', roomEvent({ kind: 'host', studentId: 102 })],
    ['room.event ready', roomEvent({ kind: 'ready', seat: 0 })],
    ['room.event bots', roomEvent({ kind: 'bots', seats: [1, 2], players: [bot, { ...bot, displayName: '陪练小二' }] })],
    ['room.event idle', roomEvent({ kind: 'idle', decideBy: later })],
    ['room.event react', roomEvent({ kind: 'react', from: student, to: other, reaction: 'phrase', content: 'p01', text: '快点吧' })],
    ['room.event trustee', roomEvent({ kind: 'trustee', seat: 2, on: true, reason: 'timeouts' })],
    ['room.event closed', roomEvent({ kind: 'closed', reason: 'club_closed' })],
    ['a replayed room.event', { ...roomEvent({ kind: 'ready', seat: 0 }), replayed: true }],
    ['game event dealt', gameEvent({ kind: 'dealt', gameId: 5, seats: [student, other, bot], firstBidder: 1 })],
    ['game event bid', gameEvent({ kind: 'bid', turn: 1, seat: 1, bid: 0, auto: null })],
    ['game event redeal', gameEvent({ kind: 'redeal', count: 1 })],
    ['game event landlord', gameEvent({ kind: 'landlord', seat: 2, base: 3, bottom: ['3', 'K', '大王'] })],
    ['game event play', gameEvent({ kind: 'play', turn: 7, seat: 0, move: pair9, cardsLeft: 15, multiplier: 2, auto: null })],
    ['game event pass', gameEvent({ kind: 'pass', turn: 8, seat: 1, auto: 'trustee' })],
    ['game event over', gameEvent({ kind: 'over', result })],
    ['game event over with no landlord', gameEvent({ kind: 'over', result: noLandlord })],
  ])('accepts %s', (_name, message) => {
    expect(ok(ClubServerMessage, message)).toBe(true)
  })

  test('a room event of a reaction says what kind it is', () => {
    const react = { kind: 'react', from: student, to: null, reaction: 'emoji', content: '👍', text: '👍' }
    expect(ok(RoomEvent, react)).toBe(true)
    expect(ok(RoomEvent, { ...react, reaction: 'sticker' })).toBe(false)
  })

  test.each<Case>([
    ['an unknown type', { type: 'shout' }],
    ['ack ok false without error', { type: 'ack', id: 'c1', ok: false }],
    ['your_turn with seat 3', { ...playTurn, me: { ...playTurn.me, seat: 3 } }],
    ['your_turn with turn 0', { ...playTurn, turn: 0 }],
    ['your_turn in another phase', { ...playTurn, phase: 'double' }],
    ['your_turn with a bid of 4', { ...bidTurn, bids: [0, 4] }],
    ['your_turn with move id 0', { ...playTurn, moves: [{ id: 0, type: 'pair', name: '对牌', cards: ['10', '10'] }] }],
    ['a table with only two cardsLeft', { ...playTurn, table: { ...table, cardsLeft: [15, 17] } }],
    ['a table to act at seat 3', { ...playTurn, table: { ...table, toAct: 3 } }],
    ['a table with multiplier 0', { ...playTurn, table: { ...table, multiplier: 0 } }],
    ['hand with no game', { type: 'hand', roomId: 'r7k2q', gameId: 5, cards: ['3'] }],
    ['room.event with seq 0', { ...roomEvent({ kind: 'ready', seat: 0 }), seq: 0 }],
    ['room.event of an unknown kind', roomEvent({ kind: 'dance' })],
    ['room.event closed for another reason', roomEvent({ kind: 'closed', reason: 'bored' })],
    ['a game event in another game', roomEvent({ kind: 'game', game: 'chess', event: { kind: 'redeal', count: 1 } })],
    ['game event over with fractional scores', gameEvent({ kind: 'over', result: { ...result, scores: [-1.5, -1.5, 3] } })],
    ['game event over with two hands', gameEvent({ kind: 'over', result: { ...result, hands: [[], []] } })],
    ['game event play at seat 3', gameEvent({ kind: 'play', turn: 7, seat: 3, move: pair9, cardsLeft: 15, multiplier: 2, auto: null })],
    ['game event dealt to two seats', gameEvent({ kind: 'dealt', gameId: 5, seats: [student, other], firstBidder: 1 })],
    ['lobby with no free seat', { type: 'lobby', rooms: [{ roomId: 'r7k2q', host: withClass, seatsFree: 0, bots: false, gamesPlayed: 0 }] }],
    ['invite.ended for another reason', { type: 'invite.ended', inviteId: 3, reason: 'lost' }],
    ['room.left for another reason', { type: 'room.left', roomId: 'r7k2q', reason: 'kicked' }],
  ])('rejects %s', (_name, message) => {
    expect(ok(ClubServerMessage, message)).toBe(false)
  })

  test('a table action carries a bid only when it bids and a move only when it plays', () => {
    expect(ok(TableAction, { turn: 3, seat: 2, action: 'play', move: single3, auto: null })).toBe(true)
    expect(ok(TableAction, { turn: 3, seat: 2, action: 'play', bid: 2, auto: null })).toBe(false)
    expect(ok(TableAction, { turn: 3, seat: 2, action: 'pass', move: single3, auto: null })).toBe(false)
    expect(ok(TableAction, { turn: 3, seat: 2, action: 'pass', auto: 'idle' })).toBe(false)
  })

  test('the doudizhu schemas take the examples on their own', () => {
    expect(ok(DoudizhuTable, table)).toBe(true)
    expect(ok(DoudizhuTable, biddingTable)).toBe(true)
    expect(ok(RoomState, room)).toBe(true)
    expect(ok(DoudizhuResult, result)).toBe(true)
    expect(ok(DoudizhuEvent, { kind: 'redeal', count: 3 })).toBe(true)
  })

  // Walks a schema and returns the path of every array of cards and of every property named `hand`.
  const cardPaths = (schema: unknown, path = ''): string[] => {
    if (typeof schema !== 'object' || schema === null) return []
    const s = schema as Record<string, unknown>
    const found: string[] = []
    const items = s.items as Record<string, unknown> | undefined
    const isRank = (x: unknown) => JSON.stringify(x).includes('"大王"')
    if (s.type === 'array' && items !== undefined && isRank(items) && !('properties' in items)) found.push(path)
    for (const branch of (s.anyOf as unknown[] | undefined) ?? []) found.push(...cardPaths(branch, path))
    if (items !== undefined) found.push(...cardPaths(items, `${path}[]`))
    for (const [key, value] of Object.entries((s.properties as Record<string, unknown> | undefined) ?? {})) {
      if (key === 'hand' || key === 'hands') found.push(`${path}.${key}`)
      found.push(...cardPaths(value, `${path}.${key}`))
    }
    return found
  }

  test('the public table has no cards but the bottom and the moves played, and no hand', () => {
    expect([...new Set(cardPaths(DoudizhuTable))].sort()).toEqual(
      ['.bottom', '.history[].move.cards', '.trick.last.move.cards'].sort(),
    )
  })

  test('the club layer of a room and its events says nothing of doudizhu', () => {
    const roomState = RoomState as unknown as { properties: Record<string, unknown> }
    const { game: _game, ...clubProperties } = roomState.properties
    const events = (RoomEvent as unknown as { anyOf: { properties: { kind: { const: string } } }[] }).anyOf
    const clubEvents = events.filter((branch) => branch.properties.kind.const !== 'game')
    expect(clubEvents.length).toBe(events.length - 1)
    const text = JSON.stringify([clubProperties, clubEvents])
    for (const word of ['landlord', 'bid', 'cards', 'hand']) expect(text).not.toContain(word)
    for (const rank of RANKS) expect(text).not.toContain(`"${rank}"`)
  })
})
