import type { AddressInfo } from 'node:net'
import { afterEach, expect, test } from 'vitest'
import { createBot, type Bot } from '../../src/tools/sim-bots.js'
import { buildTestClassApp } from '../helpers/class-app.js'
import { insertClass, insertStudent } from '../helpers/factories.js'

/** A wall-clock time in Beijing (the example config's timezone) on Monday 2 November 2026. */
const at = (time: string) => new Date(`2026-11-02T${time}:00+08:00`)

let service: Awaited<ReturnType<typeof buildTestClassApp>> | undefined
let bot: Bot | undefined

afterEach(async () => {
  bot?.stop()
  bot = undefined
  await service?.destroy()
  service = undefined
})

async function waitUntil(check: () => boolean, what: string): Promise<void> {
  for (let waited = 0; !check(); waited += 10) {
    if (waited > 5000) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('a bot that drops comes back with the sessionId of its welcome and its lastSeq, and gets nothing twice', async () => {
  service = await buildTestClassApp()
  const s = service
  const classId = await insertClass(s.db, { classNo: 1 })
  const { id, key } = await insertStudent(s.db, { classId, status: 'active' })
  s.clock.set(at('19:50'))
  await s.runtime.tick()
  const sessionId = s.runtime.currentSession(classId)!.sessionId
  await s.app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = s.app.server.address() as AddressInfo

  const lines: string[] = []
  const welcomes = () => lines.filter((l) => l.startsWith('小鱼 welcome')).length
  // Drops after every live class event; `random` 0 brings it back a second later and keeps it from chatting.
  bot = createBot(
    { studentId: id, key, displayName: '小鱼' },
    { url: `ws://127.0.0.1:${port}/v1/class`, chatEvery: 3600, dropRate: 1, maxRounds: 3 },
    { clock: s.clock, random: () => 0, print: (line) => void lines.push(line), onEnded: () => {} },
  )
  bot.start()
  await waitUntil(() => welcomes() === 1, 'the welcome')

  // The opening goes out live, the bot drops on it and says hello again.
  s.clock.set(at('20:00'))
  await s.runtime.tick()
  await waitUntil(() => welcomes() === 2, 'the welcome after the reconnect')

  expect(lines.filter((l) => l.startsWith('小鱼 hello'))).toEqual([
    '小鱼 hello',
    expect.stringMatching(new RegExp(`^小鱼 hello 会话 ${sessionId} lastSeq [1-9]\\d*$`)),
  ])
  expect(bot.tally).toMatchObject({ drops: 1, duplicates: 0, invalid: 0 })
})
