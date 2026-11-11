import type { AddressInfo } from 'node:net'
import { Value } from 'typebox/value'
import { afterEach, expect, test } from 'vitest'
import { WebSocketServer } from 'ws'
import { ClientMessage, ServerMessage } from '../../src/protocol/ws.js'
import { systemClock } from '../../src/shared/clock.js'
import { seedClass } from '../../src/tools/dev-seed.js'
import { buildReport, createBot, createSampler, parseSimArgs, totalsText, type Bot } from '../../src/tools/sim-bots.js'
import { summarize } from '../../src/tools/sim-report.js'
import { buildTestClassApp } from '../helpers/class-app.js'
import { insertClass, insertLesson, insertStudent } from '../helpers/factories.js'

/** A wall-clock time in Beijing (the example config's timezone) on Monday 2 November 2026. */
const at = (time: string) => new Date(`2026-11-02T${time}:00+08:00`)

let service: Awaited<ReturnType<typeof buildTestClassApp>> | undefined
let bot: Bot | undefined
const extraBots: Bot[] = []

afterEach(async () => {
  bot?.stop()
  bot = undefined
  for (const b of extraBots.splice(0)) b.stop()
  await service?.destroy()
  service = undefined
})

async function waitUntil(check: () => boolean, what: string): Promise<void> {
  for (let waited = 0; !check(); waited += 10) {
    // Generous so a loaded machine does not fail it; a passing wait still ends as soon as the condition holds.
    if (waited > 15_000) throw new Error(`Timed out waiting for ${what}`)
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
async function lessonWithQuestions(
  ask: number,
  limit: number,
  segments: number,
  expected: { questions: number; answers?: number },
  dropFirst = false,
) {
  const sent: unknown[] = []
  const frames = (msg: object) => {
    expect(Value.Check(ServerMessage, msg)).toBe(true)
    return JSON.stringify(msg)
  }
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  let seq = 0
  let connections = 0
  const opts = { url: '', chatEvery: 3600, dropRate: dropFirst ? 1 : 0, maxRounds: 3, ask }
  server.on('connection', (ws) => {
    // Only the first connection is dropped (right after its first live segment).
    if (++connections > 1) opts.dropRate = 0
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
              event: {
                kind: 'qa',
                segment: 1,
                studentId: 1,
                displayName: '小鱼',
                question: msg.text,
                answer: '好问题',
              },
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
    Object.assign(opts, { url: `ws://127.0.0.1:${port}/v1/class` }),
    { clock: systemClock, random: () => 0, print: (line) => void lines.push(line), onEnded: () => {} },
  )
  bot.start()
  // At least: after a drop the school sends the segments again, and a poll can step past the exact count.
  await waitUntil(() => bot!.tally.segments >= segments, 'the segments')
  // Every question the bot means to ask has gone out, and the answers a test counts on have arrived.
  await waitUntil(() => bot!.tally.questionsSent === expected.questions, 'the questions')
  // And the school has them: a frame the bot sent may still be on its way when it counts.
  const received = () => sent.filter((m) => (m as { type: string }).type === 'question').length
  await waitUntil(() => received() === expected.questions, 'the questions to arrive')
  if (expected.answers !== undefined) await waitUntil(() => bot!.tally.answersSeen === expected.answers, 'the answers')
  const closed = new Promise((resolve) => server.close(resolve))
  bot.stop()
  server.clients.forEach((c) => c.terminate())
  await closed
  return { sent, tally: bot.tally, totals: totalsText([bot]) }
}

test('with --ask on, a bot asks ordinary questions within the lesson allowance and counts the answers it hears', async () => {
  const { sent, tally, totals } = await lessonWithQuestions(1, 2, 4, { questions: 2, answers: 1 })
  const questions = sent.filter((m) => (m as { type: string }).type === 'question') as { text: string }[]
  expect(questions).toHaveLength(2)
  for (const q of sent) expect(Value.Check(ClientMessage, q)).toBe(true)
  expect(new Set(questions.map((q) => q.text)).size).toBe(2)
  expect(tally).toMatchObject({ questionsSent: 2, answersSeen: 1, invalid: 0 })
  expect(totals).toContain('提问 2 个，听到老师答疑 1 次')
}, 30_000)

test('without --ask a bot never asks a question', async () => {
  const { sent, tally } = await lessonWithQuestions(0, 2, 3, { questions: 0 })
  expect(sent.filter((m) => (m as { type: string }).type === 'question')).toEqual([])
  expect(tally.questionsSent).toBe(0)
}, 30_000)

test('--ask is off by default and a probability', () => {
  const base = ['--keys', 'k.json', '--url', 'ws://localhost:8081/v1/class']
  expect(parseSimArgs(base)?.ask).toBe(0)
  expect(parseSimArgs([...base, '--ask', '0.3'])?.ask).toBe(0.3)
  expect(parseSimArgs([...base, '--ask', '1.5'])).toBeNull()
  expect(parseSimArgs([...base, '--ask', 'often'])).toBeNull()
})

test('a question lost to a drop while it waited does not use up the allowance', async () => {
  const { sent, tally } = await lessonWithQuestions(1, 2, 4, { questions: 2 }, true)
  expect(tally.drops).toBe(1)
  expect(sent.filter((m) => (m as { type: string }).type === 'question')).toHaveLength(2)
  expect(tally.questionsSent).toBe(2)
}, 30_000)

const BASE_ARGS = ['--keys', 'k.json', '--url', 'ws://localhost:8081/v1/class']

test('--ramp, --report and --expect-* are optional and checked', () => {
  expect(parseSimArgs(BASE_ARGS)).toMatchObject({
    ramp: 0,
    report: undefined,
    expectSegmentMs: undefined,
    expectChatMs: undefined,
  })
  expect(
    parseSimArgs([
      ...BASE_ARGS,
      '--ramp',
      '30',
      '--report',
      'r.json',
      '--expect-segment-ms',
      '5000',
      '--expect-chat-ms',
      '1000',
    ]),
  ).toMatchObject({ ramp: 30, report: 'r.json', expectSegmentMs: 5000, expectChatMs: 1000 })
  for (const bad of [
    ['--ramp', '-1'],
    ['--ramp', 'soon'],
    ['--expect-segment-ms', '0'],
    ['--expect-chat-ms', 'fast'],
    ['--report', ''],
  ]) {
    expect(parseSimArgs([...BASE_ARGS, ...bad])).toBeNull()
  }
})

test('a small class on the real service gives segment and chat delay samples and no unexpected disconnect', async () => {
  service = await buildTestClassApp()
  const s = service
  await insertLesson(s.db, { date: '2026-11-02' })
  const seeded = await seedClass(s.db, s.config, { division: 'junior', slot: 'evening', students: 3, clock: s.clock })
  s.clock.set(at('19:50'))
  await s.runtime.tick()
  await s.app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = s.app.server.address() as AddressInfo

  const sampler = createSampler()
  const lines: string[] = []
  const bots = seeded.students.map((student) =>
    createBot(
      student,
      { url: `ws://127.0.0.1:${port}/v1/class`, chatEvery: 0.05, dropRate: 0, maxRounds: 3, ask: 0 },
      { clock: s.clock, random: () => 0, print: (line) => void lines.push(line), onEnded: () => {}, sampler },
    ),
  )
  extraBots.push(...bots)
  for (const b of bots) b.start()
  await waitUntil(() => bots.every((b) => b.tally.welcomed), 'the welcomes')

  // The lesson goes on live, 20 seconds of lesson time at a time, until a chat line has been seen and some segments.
  let minute = 0
  await waitUntil(() => {
    if (sampler.samples.segmentMs.length >= 3 && sampler.samples.chatMs.length >= 1) return true
    s.clock.set(new Date(at('20:00').getTime() + ++minute * 20_000))
    void s.runtime.tick()
    return false
  }, 'the samples')

  expect(sampler.samples.unexpectedDisconnects).toBe(0)
  for (const ms of [...sampler.samples.segmentMs, ...sampler.samples.chatMs]) expect(Number.isFinite(ms)).toBe(true)
  const report = summarize(sampler.samples)
  expect(report.segment.count).toBeGreaterThanOrEqual(3)
  expect(report.chat.count).toBeGreaterThanOrEqual(1)
  // Nothing the bots said is in the console lines.
  expect(lines.some((l) => l.includes('你好呀'))).toBe(false)
}, 60_000)

/** A school that welcomes whoever comes, sends one live segment (sent `lagMs` ago), and hands each connection to `onConnection`. */
async function fakeSchool(
  onConnection: (ws: import('ws').WebSocket, n: number) => void,
  { lagMs = 0, endsInMs = 3_600_000, segmentOn = (_n: number): boolean => true } = {},
) {
  const received: { type: string; text?: string; id: string }[] = []
  const frame = (msg: object) => {
    expect(Value.Check(ServerMessage, msg)).toBe(true)
    return JSON.stringify(msg)
  }
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  let connections = 0
  let seq = 0
  server.on('connection', (ws) => {
    const n = ++connections
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { id: string; type: string; text?: string }
      received.push(msg)
      if (msg.type !== 'hello') return
      ws.send(
        frame({
          type: 'welcome',
          student: { studentId: 1, displayName: '小鱼' },
          class: { classId: 1, className: '一班', teacher: { name: '老师' } },
          session: {
            sessionId: 7,
            kind: 'lesson',
            startsAt: new Date().toISOString(),
            endsAt: new Date(Date.now() + endsInMs).toISOString(),
            subject: null,
            title: null,
          },
          online: [{ studentId: 2, displayName: '小虾' }],
          limits: {
            maxInitiationsPerLesson: 2,
            initiationsLeft: 2,
            maxRoundsPerConversation: 3,
            maxMessageChars: 500,
            maxQuestionsPerLesson: 2,
            framesPerMinute: 60,
            closingGraceSeconds: 60,
          },
          probation: false,
        }),
      )
      ws.send(JSON.stringify({ type: 'ack', id: msg.id, ok: true }))
      if (segmentOn(n)) {
        ws.send(
          frame({
            type: 'class.event',
            seq: ++seq,
            replayed: false,
            at: new Date(Date.now() - lagMs).toISOString(),
            event: { kind: 'segment', index: n, text: '正文' },
          }),
        )
      }
      onConnection(ws, n)
    })
  })
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `ws://127.0.0.1:${port}/v1/class`,
    received,
    frame,
    async close() {
      const closed = new Promise((resolve) => server.close(resolve))
      server.clients.forEach((c) => c.terminate())
      await closed
    },
  }
}

function startBot(
  url: string,
  sampler: ReturnType<typeof createSampler>,
  opts: { dropRate?: number; chatEvery?: number; ask?: number } = {},
) {
  bot = createBot(
    { studentId: 1, key: 'k', displayName: '小鱼' },
    { url, chatEvery: opts.chatEvery ?? 3600, dropRate: opts.dropRate ?? 0, maxRounds: 3, ask: opts.ask ?? 0 },
    { clock: systemClock, random: () => 0, print: () => {}, onEnded: () => {}, sampler },
  )
  bot.start()
  return bot
}

test('the segment delay is the receipt time minus the event time, live events only', async () => {
  const school = await fakeSchool(() => {}, { lagMs: 700 })
  const sampler = createSampler()
  startBot(school.url, sampler)
  await waitUntil(() => sampler.samples.segmentMs.length === 1, 'the segment')
  expect(sampler.samples.segmentMs[0]).toBeGreaterThanOrEqual(690)
  expect(sampler.samples.segmentMs[0]).toBeLessThan(5000)
  await school.close()
})

test('a connection the school cuts without a closing message is one unexpected disconnect', async () => {
  const school = await fakeSchool((ws, n) => {
    if (n === 1) setTimeout(() => ws.terminate(), 50)
  })
  const sampler = createSampler()
  const b = startBot(school.url, sampler)
  await waitUntil(() => sampler.samples.unexpectedDisconnects === 1, 'the disconnect')
  expect(b.tally.drops).toBe(0)
  expect(summarize(sampler.samples).unexpectedDisconnects).toBe(1)
  await school.close()
})

test('a drop the bot makes itself, and a closing the school announces, are not unexpected', async () => {
  const school = await fakeSchool(
    (ws, n) => {
      // The second connection is told the school is under maintenance, then cut.
      if (n === 2) {
        ws.send(school.frame({ type: 'closing', reason: 'maintenance', message: '学校维护' }))
        ws.close()
      }
    },
    { segmentOn: (n) => n === 1 },
  )
  const sampler = createSampler()
  // dropRate 1: the bot drops after the first live segment of its first connection and comes back a second later.
  const b = startBot(school.url, sampler, { dropRate: 1 })
  await waitUntil(() => b.tally.ended !== null, 'the end')
  expect(b.tally.drops).toBe(1)
  expect(sampler.samples.unexpectedDisconnects).toBe(0)
  await school.close()
}, 30_000)

test('refusals are counted by error code', async () => {
  const school = await fakeSchool((ws) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { id: string; type: string }
      if (msg.type === 'question') {
        ws.send(
          school.frame({ type: 'ack', id: msg.id, ok: false, error: { code: 'rate_limited', message: '太快了' } }),
        )
      }
    })
  })
  const sampler = createSampler()
  startBot(school.url, sampler, { ask: 1 })
  await waitUntil(() => (sampler.samples.errors.rate_limited ?? 0) === 1, 'the refusal')
  await school.close()
})

test('the tag of a chat line is made of letters only, and a line is matched with its receipt once', async () => {
  const school = await fakeSchool(() => {})
  const sampler = createSampler()
  startBot(school.url, sampler, { chatEvery: 0.02 })
  await waitUntil(() => school.received.some((m) => m.type === 'chat.start'), 'the first line')
  const line = school.received.find((m) => m.type === 'chat.start')!.text!
  // No run of digits: the privacy filter could stop it (and lose the sample).
  expect(line).not.toMatch(/[0-9]/)
  expect(line).toMatch(/[a-z]{2,}/)
  expect(sampler.sent.size).toBeGreaterThanOrEqual(1)

  // The classmate receiving it: handed to a second bot, as the school would (here by hand).
  const receiver = createBot(
    { studentId: 2, key: 'k2', displayName: '小虾' },
    { url: 'ws://127.0.0.1:1/', chatEvery: 3600, dropRate: 0, maxRounds: 3, ask: 0 },
    { clock: systemClock, random: () => 0, print: () => {}, onEnded: () => {}, sampler },
  )
  extraBots.push(receiver)
  expect(sampler.samples.chatMs).toEqual([])
  receiver.receive({
    type: 'chat.incoming',
    conversationId: 'c',
    from: { studentId: 1, displayName: '小鱼' },
    text: line,
    round: 1,
    lastLine: false,
  })
  receiver.receive({
    type: 'chat.incoming',
    conversationId: 'c',
    from: { studentId: 1, displayName: '小鱼' },
    text: line,
    round: 1,
    lastLine: false,
  })
  expect(sampler.samples.chatMs).toHaveLength(1)
  await school.close()
})

test('buildReport writes the numbers, the pass line and whether the run passed', () => {
  const sampler = createSampler()
  sampler.samples.segmentMs.push(100, 200)
  sampler.samples.chatMs.push(50)
  const ok = buildReport(sampler.samples, { segmentMs: 5000, chatMs: 1000 })
  expect(ok.pass).toBe(true)
  expect(ok.json).toMatchObject({
    segment: { count: 2, p50: 100, p99: 200, max: 200 },
    chat: { count: 1 },
    unexpectedDisconnects: 0,
    expect: { segmentMs: 5000, chatMs: 1000 },
    pass: true,
    failures: [],
  })
  sampler.samples.segmentMs.push(6000)
  const bad = buildReport(sampler.samples, { segmentMs: 5000 })
  expect(bad.pass).toBe(false)
  expect(bad.lines.join('\n')).toContain('课文延迟')
})
