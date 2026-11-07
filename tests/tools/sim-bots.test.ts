import type { AddressInfo } from 'node:net'
import { Value } from 'typebox/value'
import { afterEach, expect, test } from 'vitest'
import { WebSocketServer } from 'ws'
import { ClientMessage, ServerMessage } from '../../src/protocol/ws.js'
import { systemClock } from '../../src/shared/clock.js'
import { createBot, parseSimArgs, totalsText, type Bot } from '../../src/tools/sim-bots.js'
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
    { url: `ws://127.0.0.1:${port}/v1/class`, chatEvery: 3600, dropRate: 1, maxRounds: 3, ask: 0 },
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

/**
 * A school that welcomes one bot into a lesson allowing `limit` questions, sends it `segments` segments, answers
 * every question and turns one of them into a `qa` event. Returns what the bot sent.
 */
async function lessonWithQuestions(ask: number, limit: number, segments: number) {
  const sent: unknown[] = []
  const frames = (msg: object) => {
    expect(Value.Check(ServerMessage, msg)).toBe(true)
    return JSON.stringify(msg)
  }
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  let seq = 0
  server.on('connection', (ws) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { id: string; type: string; text?: string }
      sent.push(msg)
      if (msg.type === 'hello') {
        ws.send(
          frames({
            type: 'welcome',
            student: { studentId: 1, displayName: '小鱼' },
            class: { classId: 1, className: '一班', teacher: { name: '老师' } },
            session: {
              sessionId: 7,
              kind: 'lesson',
              startsAt: new Date().toISOString(),
              endsAt: new Date(Date.now() + 3_600_000).toISOString(),
              subject: null,
              title: null,
            },
            online: [],
            limits: {
              maxInitiationsPerLesson: 2,
              initiationsLeft: 2,
              maxRoundsPerConversation: 3,
              maxMessageChars: 500,
              maxQuestionsPerLesson: limit,
              framesPerMinute: 60,
              closingGraceSeconds: 60,
            },
            probation: false,
          }),
        )
        ws.send(JSON.stringify({ type: 'ack', id: msg.id, ok: true }))
        for (let index = 1; index <= segments; index++) {
          ws.send(
            frames({
              type: 'class.event',
              seq: ++seq,
              replayed: false,
              at: new Date().toISOString(),
              event: { kind: 'segment', index, text: `第${index}段` },
            }),
          )
        }
      } else if (msg.type === 'question') {
        ws.send(JSON.stringify({ type: 'ack', id: msg.id, ok: true, result: { reply: '收到' } }))
        if (sent.filter((m) => (m as { type: string }).type === 'question').length === 1) {
          ws.send(
            frames({
              type: 'class.event',
              seq: ++seq,
              replayed: false,
              at: new Date().toISOString(),
              event: { kind: 'qa', segment: 1, studentId: 1, displayName: '小鱼', question: msg.text, answer: '好问题' },
            }),
          )
        }
      }
    })
  })
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  const lines: string[] = []
  bot = createBot(
    { studentId: 1, key: 'k', displayName: '小鱼' },
    { url: `ws://127.0.0.1:${port}/v1/class`, chatEvery: 3600, dropRate: 0, maxRounds: 3, ask },
    { clock: systemClock, random: () => 0, print: (line) => void lines.push(line), onEnded: () => {} },
  )
  bot.start()
  await waitUntil(() => bot!.tally.segments === segments, 'the segments')
  // Past the longest time a bot takes over a question, so every one it means to ask has gone out.
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const closed = new Promise((resolve) => server.close(resolve))
  bot.stop()
  server.clients.forEach((c) => c.terminate())
  await closed
  return { sent, tally: bot.tally, totals: totalsText([bot]) }
}

test('with --ask on, a bot asks ordinary questions within the lesson allowance and counts the answers it hears', async () => {
  const { sent, tally, totals } = await lessonWithQuestions(1, 2, 4)
  const questions = sent.filter((m) => (m as { type: string }).type === 'question') as { text: string }[]
  expect(questions).toHaveLength(2)
  for (const q of sent) expect(Value.Check(ClientMessage, q)).toBe(true)
  expect(new Set(questions.map((q) => q.text)).size).toBe(2)
  expect(tally).toMatchObject({ questionsSent: 2, answersSeen: 1, invalid: 0 })
  expect(totals).toContain('提问 2 个，听到老师答疑 1 次')
}, 15_000)

test('without --ask a bot never asks a question', async () => {
  const { sent, tally } = await lessonWithQuestions(0, 2, 3)
  expect(sent.filter((m) => (m as { type: string }).type === 'question')).toEqual([])
  expect(tally.questionsSent).toBe(0)
}, 15_000)

test('--ask is off by default and a probability', () => {
  const base = ['--keys', 'k.json', '--url', 'ws://localhost:8081/v1/class']
  expect(parseSimArgs(base)?.ask).toBe(0)
  expect(parseSimArgs([...base, '--ask', '0.3'])?.ask).toBe(0.3)
  expect(parseSimArgs([...base, '--ask', '1.5'])).toBeNull()
  expect(parseSimArgs([...base, '--ask', 'often'])).toBeNull()
})
