import { afterEach, describe, expect, test } from 'vitest'
import { STUCK_TICK_FLOOR_MS } from '../../src/class/service.js'
import { buildTestClassApp } from '../helpers/class-app.js'

let t: Awaited<ReturnType<typeof buildTestClassApp>>

afterEach(async () => {
  await t.destroy()
})

const get = () => t.app.inject({ method: 'GET', url: '/healthz' })
const finishedAgo = (ms: number | null) => ({ lastFinishedAt: () => (ms === null ? null : Date.now() - ms) })

describe('GET /healthz on the class service', () => {
  test('is unhealthy before a ticker is handed over, and before its first run has finished', async () => {
    t = await buildTestClassApp()
    expect((await get()).statusCode).toBe(503)
    t.watchTicker(finishedAgo(null), 1000)
    const res = await get()
    expect(res.statusCode).toBe(503)
    expect(res.body).toBe('{"ok":false}')
  })

  test('is healthy while the clock ticks and the database answers, with nothing else in the reply', async () => {
    t = await buildTestClassApp()
    t.watchTicker(finishedAgo(500), 1000)
    const res = await get()
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('{"ok":true}')
  })

  test('is unhealthy once the last tick ended more than 30 seconds ago', async () => {
    t = await buildTestClassApp()
    t.watchTicker(finishedAgo(STUCK_TICK_FLOOR_MS + 1000), 1000)
    expect((await get()).statusCode).toBe(503)
  })

  test('waits for 3 intervals when they are longer than 30 seconds', async () => {
    t = await buildTestClassApp()
    t.watchTicker(finishedAgo(50_000), 20_000)
    expect((await get()).statusCode).toBe(200)
    t.watchTicker(finishedAgo(70_000), 20_000)
    expect((await get()).statusCode).toBe(503)
  })

  test('is unhealthy when the database is gone', async () => {
    t = await buildTestClassApp()
    t.watchTicker(finishedAgo(0), 1000)
    await t.db.destroy()
    expect((await get()).statusCode).toBe(503)
  })

  test('is not rate limited', async () => {
    t = await buildTestClassApp()
    t.watchTicker(finishedAgo(0), 1000)
    for (let i = 0; i < 200; i++) expect((await get()).statusCode).toBe(200)
  })
})
