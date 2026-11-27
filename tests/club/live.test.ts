import { Value } from 'typebox/value'
import { afterEach, describe, expect, test } from 'vitest'
import { ClubLiveResult } from '../../src/protocol/http.js'
import { buildTestClubApp, type Client, type TestClub } from './helpers/club-app.js'

// T0 is Friday 20 November 2026, 11:00 in Beijing: the club is open.

let s: TestClub | undefined

afterEach(async () => {
  await s?.destroy()
  s = undefined
})

async function live(service: TestClub) {
  const res = await service.app.inject({ method: 'GET', url: '/v1/club/live' })
  expect(res.statusCode).toBe(200)
  const body = res.json()
  expect(Value.Check(ClubLiveResult, body), JSON.stringify([...Value.Errors(ClubLiveResult, body)].slice(0, 3))).toBe(true)
  return { body, headers: res.headers, raw: res.body }
}

async function exchange(client: Client, message: Record<string, unknown>) {
  client.send({ id: 'x', ...message })
  const all = await client.sync()
  const ack = all.find((m) => m.type === 'ack' && m.id === 'x')
  if (ack === undefined) throw new Error('no ack')
  return ack
}

describe('GET /v1/club/live', () => {
  test('an empty club is open with nobody in it, and any site may read it', async () => {
    s = await buildTestClubApp()
    const { body, headers } = await live(s)
    expect(body).toEqual({ generatedAt: '2026-11-20T03:00:00.000Z', open: true, lobby: [], tables: [] })
    expect(headers['access-control-allow-origin']).toBe('*')
    expect(headers['cache-control']).toBe('public, max-age=5')
  })

  test('shows the tables, the bots by name, those watching and those in the lobby; no room ids, the anonymous unnamed', async () => {
    s = await buildTestClubApp()
    const host = await s.member()
    const watcher = await s.member()
    const idle = await s.member()
    await s.db.updateTable('students').set({ liveAnonymous: true }).where('id', '=', watcher.id).execute()
    const created = await exchange(host.client, { type: 'room.create', visibility: 'public', bots: true })
    const roomId = created.result.room.roomId as string
    expect((await exchange(watcher.client, { type: 'watch', roomId })).ok).toBe(true)
    const names = await s.db.selectFrom('students').select(['id', 'aiName']).execute()
    const aiName = (id: number) => names.find((n) => n.id === id)!.aiName

    const { body, raw } = await live(s)
    expect(body.open).toBe(true)
    expect(body.lobby).toEqual([{ anonymous: false, studentId: idle.id, aiName: aiName(idle.id), anonId: null, aiType: 'deepseek', avatar: { background: null, border: null } }])
    expect(body.tables).toHaveLength(1)
    const table = body.tables[0]
    expect(table).toMatchObject({ table: 1, playing: true, gamesPlayed: 0, waiting: [] })
    expect(table.tableId).toMatch(/^[A-Za-z0-9_-]{12}$/)
    expect(table.seats[0]).toEqual({
      seat: 0,
      player: { bot: false, person: { anonymous: false, studentId: host.id, aiName: aiName(host.id), anonId: null, aiType: 'deepseek', avatar: { background: null, border: null } } },
      online: true,
    })
    expect(table.seats[1]).toMatchObject({ seat: 1, player: { bot: true, name: expect.any(String) }, online: true })
    expect(table.spectators).toEqual([{ anonymous: true, studentId: null, aiName: null, anonId: expect.stringMatching(/^[A-Za-z0-9_-]{12}$/), aiType: null, avatar: null }])
    expect(raw).not.toContain(roomId)
    expect(raw).not.toContain(aiName(watcher.id))
    expect(raw).not.toContain(`"studentId":${watcher.id}`)

    // The next snapshot keeps the table's id and the anonymous student's.
    s.advance(5)
    const next = await live(s)
    expect(next.body.tables[0].tableId).toBe(table.tableId)
    expect(next.body.tables[0].spectators[0].anonId).toBe(table.spectators[0].anonId)
  })

  test('a closed club says so', async () => {
    s = await buildTestClubApp()
    s.setEnabled(false)
    expect((await live(s)).body.open).toBe(false)
  })
})
