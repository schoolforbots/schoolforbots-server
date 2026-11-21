import { sql } from 'kysely'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createTestDb } from '../helpers/db.js'
import { insertStudent } from '../helpers/factories.js'

let t: Awaited<ReturnType<typeof createTestDb>>
beforeEach(async () => {
  t = await createTestDb()
})
afterEach(async () => {
  await t.destroy()
})

const STARTED = new Date('2026-11-21T12:00:00Z')
const ENDED = new Date('2026-11-21T12:05:00Z')

const game = (gameId: number) => ({
  gameId,
  roomId: '123456',
  startedAt: STARTED,
  endedAt: ENDED,
  ranked: true,
  record: JSON.stringify({ seats: [], someKey: { nestedKey: 1 } }),
})

const player = (gameId: number, seat: number, studentId: number) => ({
  gameId,
  seat,
  studentId,
  role: seat === 0 ? ('landlord' as const) : ('farmer' as const),
  won: seat === 0,
  score: seat === 0 ? 4 : -2,
  multiplier: 2,
  ranked: true,
  endedAt: ENDED,
  bombs: 1,
  rockets: 0,
  spring: false,
  antiSpring: false,
  timeouts: 0,
  trusteeMoves: 0,
  illegalMoves: 0,
  ip: '203.0.113.7',
})

test('0014 creates doudizhu_games and doudizhu_game_players', async () => {
  const tables = await t.db.introspection.getTables()
  const games = tables.find((x) => x.name === 'doudizhu_games')
  expect(games?.columns.map((c) => c.name)).toEqual(['game_id', 'room_id', 'started_at', 'ended_at', 'ranked', 'record'])
  expect(games?.columns.every((c) => !c.isNullable && !c.isAutoIncrementing && !c.hasDefaultValue)).toBe(true)
  const players = tables.find((x) => x.name === 'doudizhu_game_players')
  expect(players?.columns.map((c) => c.name)).toEqual([
    'game_id',
    'seat',
    'student_id',
    'role',
    'won',
    'score',
    'multiplier',
    'ranked',
    'ended_at',
    'bombs',
    'rockets',
    'spring',
    'anti_spring',
    'timeouts',
    'trustee_moves',
    'illegal_moves',
    'ip',
  ])
  expect(players?.columns.filter((c) => c.isNullable).map((c) => c.name)).toEqual(['role', 'ip'])

  const indexes = await sql<{ indexname: string; indexdef: string }>`
    select indexname, indexdef from pg_indexes where tablename = 'doudizhu_game_players' order by indexname`.execute(t.db)
  expect(indexes.rows.map((r) => r.indexname)).toEqual([
    'doudizhu_game_players_pkey',
    'doudizhu_game_players_ranked_ended_at',
    'doudizhu_game_players_student_id_ended_at',
    'doudizhu_game_players_student_id_game_id',
  ])
  expect(indexes.rows[2]?.indexdef).toMatch(/\(student_id, ended_at DESC\)/)
  expect(indexes.rows[3]?.indexdef).toMatch(/\(student_id, game_id DESC\)/)
})

test('a game and its players round-trip, the record kept as it was given', async () => {
  const a = await insertStudent(t.db, { status: 'active' })
  const b = await insertStudent(t.db, { status: 'active' })
  await t.db.insertInto('doudizhuGames').values(game(7)).execute()
  await t.db.insertInto('doudizhuGamePlayers').values([player(7, 0, a.id), player(7, 2, b.id)]).execute()

  const stored = await t.db.selectFrom('doudizhuGames').selectAll().executeTakeFirstOrThrow()
  expect(stored).toEqual({ ...game(7), record: { seats: [], someKey: { nestedKey: 1 } } })
  const rows = await t.db.selectFrom('doudizhuGamePlayers').selectAll().orderBy('seat').execute()
  expect(rows).toEqual([player(7, 0, a.id), player(7, 2, b.id)])
})

test('a game number is taken once, a seat once per game', async () => {
  const a = await insertStudent(t.db, { status: 'active' })
  await t.db.insertInto('doudizhuGames').values(game(1)).execute()
  await expect(t.db.insertInto('doudizhuGames').values(game(1)).execute()).rejects.toThrow(/doudizhu_games_pkey/)
  await t.db.insertInto('doudizhuGamePlayers').values(player(1, 0, a.id)).execute()
  await expect(t.db.insertInto('doudizhuGamePlayers').values(player(1, 0, a.id)).execute()).rejects.toThrow(
    /doudizhu_game_players_pkey/,
  )
})

test('a player row needs its game and its student; role and seat are checked', async () => {
  const a = await insertStudent(t.db, { status: 'active' })
  await expect(t.db.insertInto('doudizhuGamePlayers').values(player(99, 0, a.id)).execute()).rejects.toThrow(
    /foreign key/,
  )
  await t.db.insertInto('doudizhuGames').values(game(1)).execute()
  await expect(t.db.insertInto('doudizhuGamePlayers').values(player(1, 0, 999_999)).execute()).rejects.toThrow(
    /foreign key/,
  )
  await expect(
    t.db
      .insertInto('doudizhuGamePlayers')
      .values({ ...player(1, 0, a.id), role: 'king' as never })
      .execute(),
  ).rejects.toThrow(/doudizhu_game_players_role_check/)
  await expect(t.db.insertInto('doudizhuGamePlayers').values(player(1, 3, a.id)).execute()).rejects.toThrow(
    /doudizhu_game_players_seat_check/,
  )
  // No landlord, no address: both may be null.
  await t.db
    .insertInto('doudizhuGamePlayers')
    .values({ ...player(1, 1, a.id), role: null, ip: null })
    .execute()
  const fk = await sql<{ conname: string }>`
    select conname from pg_constraint where conrelid = 'doudizhu_game_players'::regclass and contype = 'f'`.execute(t.db)
  expect(fk.rows).toHaveLength(2)
})
