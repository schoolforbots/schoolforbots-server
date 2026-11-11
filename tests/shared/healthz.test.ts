import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { Kysely } from 'kysely'
import { afterEach, describe, expect, test } from 'vitest'
import { databaseAlive, registerHealthz } from '../../src/shared/healthz.js'
import type { Database } from '../../src/shared/db.js'
import { createTestDb } from '../helpers/db.js'

describe('databaseAlive', () => {
  let destroy: (() => Promise<void>) | undefined
  afterEach(async () => {
    await destroy?.()
    destroy = undefined
  })

  test('is true for a database that answers', async () => {
    const test_ = await createTestDb()
    destroy = test_.destroy
    expect(await databaseAlive(test_.db)).toBe(true)
  })

  test('is false for a database already destroyed', async () => {
    const test_ = await createTestDb()
    await test_.db.destroy()
    destroy = test_.destroy
    expect(await databaseAlive(test_.db)).toBe(false)
  })

  test('is false at the time limit for a database that never answers', async () => {
    const never = { executeQuery: () => new Promise(() => {}) }
    const hanging = {
      getExecutor: () => ({ ...never, transformQuery: (n: unknown) => n, compileQuery: () => ({ sql: '', parameters: [] }) }),
      selectNoFrom: () => ({ execute: () => new Promise(() => {}) }),
    } as unknown as Kysely<Database>
    const started = Date.now()
    expect(await databaseAlive(hanging, 50)).toBe(false)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('is false, not a throw, when the database throws at once', async () => {
    const throwing = {
      selectNoFrom: () => {
        throw new Error('boom')
      },
    } as unknown as Kysely<Database>
    expect(await databaseAlive(throwing)).toBe(false)
  })
})

describe('registerHealthz', () => {
  async function appWith(check: () => Promise<boolean>) {
    const app = Fastify()
    await app.register(rateLimit, { max: 5, timeWindow: '1 minute' })
    registerHealthz(app, check)
    await app.ready()
    return app
  }

  test('answers 200 {"ok":true} when the check passes', async () => {
    const app = await appWith(async () => true)
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('{"ok":true}')
    await app.close()
  })

  test('answers 503 {"ok":false} when the check fails, or throws', async () => {
    const failing = await appWith(async () => false)
    const a = await failing.inject({ method: 'GET', url: '/healthz' })
    expect(a.statusCode).toBe(503)
    expect(a.body).toBe('{"ok":false}')
    await failing.close()

    const throwing = await appWith(async () => {
      throw new Error('boom')
    })
    const b = await throwing.inject({ method: 'GET', url: '/healthz' })
    expect(b.statusCode).toBe(503)
    expect(b.body).toBe('{"ok":false}')
    await throwing.close()
  })

  test('is not rate limited', async () => {
    const app = await appWith(async () => true)
    for (let i = 0; i < 50; i++) {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200)
    }
    await app.close()
  })
})
