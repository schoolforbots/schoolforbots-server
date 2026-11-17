import type { TSchema } from 'typebox'
import Value from 'typebox/value'
import { describe, expect, test } from 'vitest'
import { ClubStatsSummary } from '../../src/protocol/club.js'
import {
  ClubGameList,
  ClubHours,
  ClubLeaderboard,
  ClubMembership,
  DoudizhuGameRecord,
  DoudizhuStats,
  LeaderboardEntry,
} from '../../src/protocol/club-http.js'

const ok = (schema: TSchema, value: unknown): boolean => Value.Check(schema, value)
type Case = [name: string, value: unknown]

const at = '2026-11-17T12:00:00.000Z'
const later = '2026-11-17T12:20:00.000Z'
const student = { studentId: 37, displayName: '阿杰家的小鱼 #0037', bot: false }
const other = { studentId: 102, displayName: '小林家的阿花 #0102', bot: false }
const bot = { studentId: null, displayName: '陪练小一', bot: true }

describe('membership and hours', () => {
  test.each<Case>([
    ['a member', { club: 'doudizhu', member: true, joinedAt: at }],
    ['not a member', { club: 'doudizhu', member: false, joinedAt: null }],
  ])('ClubMembership accepts %s', (_name, value) => {
    expect(ok(ClubMembership, value)).toBe(true)
  })

  test.each<Case>([
    ['another club', { club: 'chess', member: true, joinedAt: at }],
    ['no joinedAt', { club: 'doudizhu', member: false }],
    ['a joinedAt that is no time', { club: 'doudizhu', member: true, joinedAt: 'yesterday' }],
  ])('ClubMembership rejects %s', (_name, value) => {
    expect(ok(ClubMembership, value)).toBe(false)
  })

  test('ClubHours lists the closures of the next 24 hours', () => {
    expect(ok(ClubHours, { enabled: true, closures: [{ startsAt: at, endsAt: later }] })).toBe(true)
    expect(ok(ClubHours, { enabled: false, closures: [] })).toBe(true)
    expect(ok(ClubHours, { enabled: true, closures: [{ startsAt: at }] })).toBe(false)
    expect(ok(ClubHours, { closures: [] })).toBe(false)
  })
})

describe('stats', () => {
  const stats = {
    games: 40, wins: 22, landlordGames: 12, landlordWins: 7,
    points: { total: -36, week: 12 }, rankedGames: 30,
    springs: 2, antiSprings: 1, bombs: 9, rockets: 3, maxMultiplier: 16,
    timeouts: 4, trusteeMoves: 11, illegalMoves: 6,
  }

  test('DoudizhuStats accepts a full record, and one with no games', () => {
    expect(ok(DoudizhuStats, stats)).toBe(true)
    const none = Object.fromEntries(Object.keys(stats).map((key) => [key, 0]))
    expect(ok(DoudizhuStats, { ...none, points: { total: 0, week: 0 } })).toBe(true)
  })

  test.each<Case>([
    ['a negative count', { ...stats, bombs: -1 }],
    ['a fractional count', { ...stats, games: 1.5 }],
    ['fractional points', { ...stats, points: { total: 0.5, week: 0 } }],
    ['no illegalMoves', { ...stats, illegalMoves: undefined }],
  ])('DoudizhuStats rejects %s', (_name, value) => {
    expect(ok(DoudizhuStats, value)).toBe(false)
  })

  test('DoudizhuStats sends no win rate', () => {
    const properties = (DoudizhuStats as unknown as { properties: Record<string, unknown> }).properties
    expect(Object.keys(properties).some((key) => /rate/i.test(key))).toBe(false)
  })

  test('DoudizhuStats has the summary the club welcome carries', () => {
    const properties = (DoudizhuStats as unknown as { properties: Record<string, unknown> }).properties
    const summary = (ClubStatsSummary as unknown as { properties: Record<string, unknown> }).properties
    for (const [key, schema] of Object.entries(summary)) expect(properties[key]).toEqual(schema)
  })
})

describe('leaderboard', () => {
  const entry = (rank: number, studentId: number) => ({
    rank, studentId, displayName: `某家的学生 #${String(studentId).padStart(4, '0')}`, className: '初中部·晚班·3 班',
    points: 100 - rank, games: 20,
  })
  const entries = Array.from({ length: 20 }, (_, i) => entry(i + 1, i + 1))
  const week = { board: 'week', weekStartsOn: '2026-11-16', entries, me: null, moreTied: null }

  test.each<Case>([
    ['a week board', week],
    ['a week board with me below it', { ...week, me: entry(31, 37) }],
    ['an empty board', { ...week, entries: [] }],
    ['a board with many tied', { ...week, entries: entries.slice(0, 10), moreTied: { rank: 10, count: 14 } }],
    ['the all-time board', { ...week, board: 'all', weekStartsOn: null }],
  ])('ClubLeaderboard accepts %s', (_name, value) => {
    expect(ok(ClubLeaderboard, value)).toBe(true)
  })

  test.each<Case>([
    ['21 entries', { ...week, entries: [...entries, entry(21, 21)] }],
    ['another board', { ...week, board: 'month' }],
    ['a week board with no week', { ...week, weekStartsOn: null }],
    ['the all-time board with a week', { ...week, board: 'all' }],
    ['a week that is no date', { ...week, weekStartsOn: '16/11/2026' }],
    ['rank 0', { ...week, entries: [entry(0, 1)] }],
  ])('ClubLeaderboard rejects %s', (_name, value) => {
    expect(ok(ClubLeaderboard, value)).toBe(false)
  })

  test('a leaderboard entry is a student, with negative points allowed', () => {
    expect(ok(LeaderboardEntry, { ...entry(3, 37), points: -12 })).toBe(true)
    expect(ok(LeaderboardEntry, { ...entry(3, 37), studentId: null })).toBe(false)
    expect(ok(LeaderboardEntry, { ...entry(3, 37), className: null })).toBe(false)
  })
})

describe('games', () => {
  const game = { gameId: 5, endedAt: at, outcome: 'landlord_won', role: 'landlord', score: 24, multiplier: 4, ranked: true }

  test.each<Case>([
    ['a page with more to come', { games: [game, { ...game, gameId: 4, role: 'farmer', score: -12 }], nextBefore: 4 }],
    ['a game with no landlord', { games: [{ ...game, outcome: 'no_landlord', role: null, score: 0, multiplier: 1 }], nextBefore: null }],
    ['an empty page', { games: [], nextBefore: null }],
  ])('ClubGameList accepts %s', (_name, value) => {
    expect(ok(ClubGameList, value)).toBe(true)
  })

  test.each<Case>([
    ['another outcome', { games: [{ ...game, outcome: 'draw' }], nextBefore: null }],
    ['another role', { games: [{ ...game, role: 'spectator' }], nextBefore: null }],
    ['a fractional score', { games: [{ ...game, score: 1.5 }], nextBefore: null }],
    ['nextBefore 0', { games: [game], nextBefore: 0 }],
  ])('ClubGameList rejects %s', (_name, value) => {
    expect(ok(ClubGameList, value)).toBe(false)
  })

  const hand = (rank: string) => Array<string>(17).fill(rank)
  const record = {
    gameId: 5, startedAt: at, endedAt: later,
    seats: [student, other, bot],
    dealt: [hand('3'), hand('4'), hand('5')], bottom: ['3', 'K', '大王'],
    actions: [
      { turn: 1, seat: 1, action: 'bid', bid: 3, auto: null },
      { turn: 2, seat: 1, action: 'play', move: { type: 'single', name: '单牌', cards: ['4'] }, auto: null },
      { turn: 3, seat: 2, action: 'pass', auto: 'bot' },
    ],
    reacts: [
      { at, from: 0, to: 1, kind: 'phrase', content: 'p01', text: '快点吧' },
      { at, from: 1, to: null, kind: 'emoji', content: '👍', text: '👍' },
    ],
    result: {
      gameId: 5, outcome: 'landlord_won', landlord: 1, base: 3, doublings: [], multiplier: 1, capped: false,
      scores: [-3, 6, -3], hands: [hand('3'), [], hand('5')], bottom: ['3', 'K', '大王'], ranked: false,
    },
  }

  test('DoudizhuGameRecord accepts a whole game', () => {
    expect(ok(DoudizhuGameRecord, record)).toBe(true)
  })

  test.each<Case>([
    ['two seats', { ...record, seats: [student, other] }],
    ['two hands dealt', { ...record, dealt: [hand('3'), hand('4')] }],
    ['a suited card dealt', { ...record, dealt: [['♠3'], hand('4'), hand('5')] }],
    ['an action at seat 3', { ...record, actions: [{ turn: 1, seat: 3, action: 'pass', auto: null }] }],
    ['a reaction from seat 3', { ...record, reacts: [{ ...record.reacts[0], from: 3 }] }],
    ['a reaction of another kind', { ...record, reacts: [{ ...record.reacts[0], kind: 'sticker' }] }],
    ['no result', { ...record, result: undefined }],
  ])('DoudizhuGameRecord rejects %s', (_name, value) => {
    expect(ok(DoudizhuGameRecord, value)).toBe(false)
  })
})
