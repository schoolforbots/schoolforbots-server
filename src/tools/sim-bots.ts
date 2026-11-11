import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import type { Static } from 'typebox'
import { Value } from 'typebox/value'
import WebSocket from 'ws'
import { ServerMessage } from '../protocol/ws.js'
import { systemClock, type Clock } from '../shared/clock.js'
import { SIM_PLUGIN, type SeededStudent } from './dev-seed.js'
import { isEntryPoint } from './entry-point.js'
import { summarize, verdict, type Report, type Samples } from './sim-report.js'

// `npm run sim -- --keys .sim/keys.json --url ws://localhost:8081/v1/class [--chat-every 60] [--drop-rate 0.05]
// [--max-rounds 3] [--ask 0.3] [--ramp 30] [--report report.json] [--expect-segment-ms 5000] [--expect-chat-ms 1000]`: for local development only. One simulated bot per key in the file `npm run dev:seed` wrote
// comes to class: it says hello, keeps the last class event it has, starts a conversation with an online classmate now
// and then, replies to whoever talks to it, answers when it is called on, may ask the teacher a question after a segment (with `--ask`), and drops its connection at random to come
// back a few seconds later with the `sessionId` of its welcome and `lastSeq`. Every event is one line on the console
// (the bot, the type, the number; never what was said), and once every bot is sent home after the lesson (or on
// Ctrl-C) it prints what each received. A bot turned away at the door before its lesson tries again every few seconds,
// so it can be started early. For a load test: `--ramp` spreads the bots' first connections over that many seconds, and
// the run ends with a report (`--report` writes it as JSON): the delay of every live lesson segment, the delay of every
// conversation line from sent to received (the bots are all in this process; each line carries a tag of letters to be
// matched by), the connections closed that nobody meant to close, and the refusals by error code. With `--expect-*` a
// run that misses the pass line exits with 1.

/** A simulation that cannot start. The message says why, in Chinese, for the person running the command. */
export class SimError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SimError'
  }
}

export interface SimOptions {
  /** The class service's WebSocket address, e.g. ws://localhost:8081/v1/class. */
  url: string
  /** About how often (seconds) a bot thinks of starting a conversation; it does so half of the time. */
  chatEvery: number
  /** The chance that a bot drops its connection after a class event it receives live. */
  dropRate: number
  /** The rounds each bot's hello says its plugin holds a conversation for. */
  maxRounds: number
  /** The chance that a bot asks the teacher a question after a segment it receives live; 0 never asks. */
  ask: number
}

/** What one bot received and did, for the totals. */
export interface BotTally {
  /** Segments of the lesson received, replayed ones included (each class event counts once). */
  segments: number
  /** Class events received again after a reconnect. */
  replayed: number
  /** Class events whose number the bot already had: there should be none. */
  duplicates: number
  /** Messages the school took and passed on: conversation lines and answers. */
  delivered: number
  /** Questions to the teacher the bot sent. */
  questionsSent: number
  /** Answers of the teacher to the class (`qa` events) the bot received, replayed ones included. */
  answersSeen: number
  /** Refused messages, by error code. */
  refusals: Map<string, number>
  drops: number
  /** Whether the bot was ever welcomed to class. */
  welcomed: boolean
  summary: boolean
  /** Messages that do not follow the protocol: there should be none. */
  invalid: number
  /** Why the bot stopped (`下课` once the lesson is over); null while it is still going. */
  ended: string | null
}

/**
 * What the bots of one process measure together: the samples of the report, and the conversation lines sent whose
 * receipt has not been seen yet (by tag, with the time they went out).
 */
export interface Sampler {
  samples: Samples
  sent: Map<string, number>
  /** A new tag for a line: letters only, unique in this sampler. */
  nextTag(): string
}

// The letters of a tag: no vowels, so that a tag never spells a word a word filter could stop; and no digits, whose
// runs the privacy filter may take for a phone or QQ number (which would lose the sample).
const TAG_LETTERS = 'bcdfghjklmnpqrstvwxz'
const TAG_PATTERN = new RegExp(`（([${TAG_LETTERS}]{3,})）`)

export function createSampler(): Sampler {
  let counter = 0
  return {
    samples: { segmentMs: [], chatMs: [], unexpectedDisconnects: 0, errors: {} },
    sent: new Map(),
    nextTag() {
      // The counter in base 20, at least three letters long.
      let n = counter++
      let tag = ''
      do {
        tag = TAG_LETTERS[n % TAG_LETTERS.length]! + tag
        n = Math.floor(n / TAG_LETTERS.length)
      } while (n > 0)
      return tag.padStart(3, TAG_LETTERS[0])
    },
  }
}

export interface BotDeps {
  clock: Clock
  /** Where the bot records what it measures; a bot of its own when there is none. */
  sampler?: Sampler
  random: () => number
  /** Writes one line of the console. */
  print: (line: string) => void
  /** Called once when the bot stops by itself: sent home after the lesson, or turned away for good. */
  onEnded: () => void
}

export interface Bot {
  readonly student: SeededStudent
  readonly tally: BotTally
  start(): void
  /** Stops the bot where it is (Ctrl-C). */
  stop(): void
  /** Handles a message of the school as if it came over the connection (for tests). */
  receive(message: object): void
}

type Message = Static<typeof ServerMessage>
type Of<T extends Message['type']> = Extract<Message, { type: T }>

const START_LINES = ['你好呀，这一段你听懂了吗？', '同学你好，我们来聊聊刚才讲的内容吧。', '嗨，你觉得老师讲得怎么样？']
const REPLY_LINES = [
  '我听懂了，你呢？',
  '我觉得这一段挺有意思的。',
  '对，我也是这么想的。',
  '老师讲得很清楚，我记下来了。',
]
const LAST_LINE = '下次再找你聊'
const ANSWER = '这一段讲的是……'
// Ordinary questions about what was just taught, which fit any lesson; the segment's number picks one.
const QUESTIONS = [
  '老师，刚才这一段的重点是什么？',
  '老师，能再举一个例子吗？',
  '老师，这个和上一段讲的有什么联系？',
  '老师，这个在生活里有什么用处吗？',
  '老师，刚才那个词我没听懂，能再解释一下吗？',
  '老师，这一段里最容易搞错的地方是哪里？',
]

/** The chance that a bot thinking of starting a conversation does. */
const CHAT_CHANCE = 0.5
/** How long a bot stays away after dropping its connection, at random within this range (ms). */
const AWAY_MS = [1000, 4000] as const
/**
 * How close to the dismissal a bot no longer drops (ms, beyond the longest time away): it must be back before the
 * lesson closes, or it would miss its summary, which is pushed only to the bots still online.
 */
const DROP_MARGIN_MS = 2000
/** How long a bot waits to try again after being turned away at the door or failing to connect (ms). */
const RETRY_MS = 3000
/** How long a bot takes over a reply or an answer (ms): well within the reply timeout of a lesson at 30x (4 s). */
const THINK_MS = [300, 1000] as const

/** A bot for one seeded student. Nothing happens until `start`. */
export function createBot(student: SeededStudent, opts: SimOptions, deps: BotDeps): Bot {
  const { clock, random } = deps
  const sampler = deps.sampler ?? createSampler()
  const tally: BotTally = {
    segments: 0,
    replayed: 0,
    duplicates: 0,
    delivered: 0,
    questionsSent: 0,
    answersSeen: 0,
    refusals: new Map(),
    drops: 0,
    welcomed: false,
    summary: false,
    invalid: 0,
    ended: null,
  }
  const say = (what: string) => deps.print(`${student.displayName} ${what}`)
  const between = ([lo, hi]: readonly [number, number]) => lo + random() * (hi - lo)
  const pick = <T>(list: readonly T[]): T => list[Math.min(Math.floor(random() * list.length), list.length - 1)]!

  // Kept across connections: what the bot has of the lesson, and which session that is.
  let sessionId: number | null = null
  let lastSeq = 0
  const seen = new Set<number>()
  /** The dismissal of the session the bot joined (ms). */
  let endsAt: number | null = null
  let socket: WebSocket | null = null
  /** Whether the connection was opened, the school said `closing` on it, and the bot itself is dropping it. */
  let opened = false
  let closingSeen = false
  let dropping = false
  let reconnectTimer: NodeJS.Timeout | undefined
  let chatTimer: NodeJS.Timeout | undefined
  let nextId = 0
  /** The most questions a lesson allows, and how many the bot has sent in this session (kept across connections). */
  let questionLimit = 0
  let questionsInSession = 0
  /** Questions waiting for their moment on this connection: a drop loses them, so they do not use up the allowance. */
  let questionsPending = 0

  // One connection's: reset whenever it closes.
  let welcomed = false
  let probation = true
  let initiationsLeft = 0
  /** The classmates online, by student number. */
  const online = new Set<number>()
  /** The type of each message sent and not yet acked, by id. */
  const requests = new Map<string, string>()
  /** The conversations the bot is in, with the reply it is about to send and whether that is the last line. */
  const talks = new Map<string, { timer: NodeJS.Timeout | null; last: boolean }>()
  let starting = false
  const answers = new Set<NodeJS.Timeout>()
  /** How long the close of this connection waits before the next one. */
  let retryIn = RETRY_MS

  function resetConnection(): void {
    welcomed = false
    online.clear()
    requests.clear()
    for (const talk of talks.values()) clearTimeout(talk.timer ?? undefined)
    talks.clear()
    starting = false
    for (const timer of answers) clearTimeout(timer)
    answers.clear()
    questionsPending = 0
  }

  /** Whether the frame went out: nothing is sent while the connection is not open. */
  function send(type: string, body: object): boolean {
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false
    const id = `${type}-${++nextId}`
    requests.set(id, type)
    socket.send(JSON.stringify({ id, type, ...body }))
    return true
  }

  /** Sends a conversation line with a tag of letters appended, noting when it went out. */
  function sendLine(type: 'chat.start' | 'chat.reply', body: object, line: string): void {
    const tag = sampler.nextTag()
    const sentAt = clock.now().getTime()
    if (send(type, { ...body, text: `${line}（${tag}）` })) sampler.sent.set(tag, sentAt)
  }

  function end(reason: string): void {
    if (tally.ended !== null) return
    tally.ended = reason
    clearTimeout(chatTimer)
    clearTimeout(reconnectTimer)
    say(`结束：${reason}`)
    deps.onEnded()
  }

  function connect(): void {
    reconnectTimer = undefined
    retryIn = RETRY_MS
    const ws = new WebSocket(opts.url, { headers: { authorization: `Bearer ${student.key}` } })
    socket = ws
    opened = false
    closingSeen = false
    dropping = false
    ws.on('open', () => {
      opened = true
      // `lastSeq` counts the events of the session the welcome named: the school replays after it only in that session.
      const resume = sessionId !== null && lastSeq > 0 ? { sessionId, lastSeq } : {}
      send('hello', { protocol: 'v1', plugin: SIM_PLUGIN, maxRounds: opts.maxRounds, ...resume })
      say('sessionId' in resume ? `hello 会话 ${sessionId} lastSeq ${lastSeq}` : 'hello')
    })
    ws.on('message', (data) => onMessage(String(data)))
    ws.on('unexpected-response', (_request, response) => {
      say(`连接被拒 HTTP ${response.statusCode}`)
      // A key the school does not know stays unknown: trying again changes nothing.
      if (response.statusCode === 401) end('钥匙不对')
      ws.terminate()
    })
    ws.on('error', (err: NodeJS.ErrnoException) => {
      if (tally.ended === null) say(`连接出错 ${err.code ?? err.message}`)
    })
    ws.on('close', () => {
      if (socket !== ws) return
      socket = null
      if (opened && !closingSeen && !dropping && tally.ended === null) {
        sampler.samples.unexpectedDisconnects++
        say('连接被意外断开')
      }
      resetConnection()
      if (tally.ended === null) reconnectTimer = setTimeout(connect, retryIn)
    })
  }

  /**
   * Whether the bot may drop now and still be back well before the dismissal. Not while a drop is under way: `ws`
   * still hands over the frames that had arrived before it.
   */
  function mayDrop(): boolean {
    if (socket?.readyState !== WebSocket.OPEN) return false
    return endsAt !== null && clock.now().getTime() + AWAY_MS[1] + DROP_MARGIN_MS < endsAt
  }

  function drop(): void {
    tally.drops++
    retryIn = between(AWAY_MS)
    dropping = true
    say(`断线，${(retryIn / 1000).toFixed(1)} 秒后重连`)
    socket?.terminate()
  }

  /** Sends the reply of a conversation after a moment, unless one is on its way already. */
  function replySoon(conversationId: string, talk: { timer: NodeJS.Timeout | null; last: boolean }): void {
    if (talk.timer !== null) return
    talk.timer = setTimeout(() => {
      talk.timer = null
      sendLine('chat.reply', { conversationId }, talk.last ? LAST_LINE : pick(REPLY_LINES))
    }, between(THINK_MS))
  }

  function thinkOfChatting(): void {
    chatTimer = setTimeout(
      () => {
        maybeStartChat()
        thinkOfChatting()
      },
      opts.chatEvery * 1000 * between([0.5, 1.5]),
    )
  }

  function maybeStartChat(): void {
    if (!welcomed || probation || initiationsLeft <= 0 || starting || talks.size > 0) return
    if (endsAt === null || clock.now().getTime() >= endsAt || random() >= CHAT_CHANCE) return
    if (online.size === 0) return
    starting = true
    sendLine('chat.start', { to: pick([...online]) }, pick(START_LINES))
  }

  /** Asks the teacher a question about the segment after a moment, within the lesson's allowance. */
  function askSoon(segment: number): void {
    if (questionsInSession + questionsPending >= questionLimit || endsAt === null || clock.now().getTime() >= endsAt)
      return
    // Pending ones count against the allowance so the bot cannot send more than it allows; only a sent one uses it up.
    questionsPending++
    const timer = setTimeout(() => {
      answers.delete(timer)
      questionsPending--
      if (!send('question', { text: QUESTIONS[(segment - 1 + QUESTIONS.length) % QUESTIONS.length] })) return
      questionsInSession++
      tally.questionsSent++
    }, between(THINK_MS))
    answers.add(timer)
  }

  function onAck(msg: Of<'ack'>): void {
    const type = requests.get(msg.id) ?? '?'
    requests.delete(msg.id)
    if (type === 'chat.start') starting = false
    if (msg.ok) {
      if (type !== 'hello') tally.delivered++
      // The ack of a start that opened a conversation carries its id.
      const conversationId = (msg.result as { conversationId?: unknown } | undefined)?.conversationId
      if (type === 'chat.start') {
        initiationsLeft = Math.max(0, initiationsLeft - 1)
        if (typeof conversationId === 'string' && !talks.has(conversationId)) {
          talks.set(conversationId, { timer: null, last: false })
        }
      }
      say(`ack ${type} ok`)
      return
    }
    const { code } = msg.error
    tally.refusals.set(code, (tally.refusals.get(code) ?? 0) + 1)
    sampler.samples.errors[code] = (sampler.samples.errors[code] ?? 0) + 1
    if (code === 'initiation_cap') initiationsLeft = 0
    if (code === 'question_cap') questionLimit = 0
    say(`ack ${type} 被拒 ${code}`)
  }

  function onClassEvent(msg: Of<'class.event'>): void {
    const { seq, replayed, event } = msg
    if (seen.has(seq)) {
      tally.duplicates++
      say(`class.event #${seq} ${event.kind} 重复`)
      return
    }
    seen.add(seq)
    lastSeq = Math.max(lastSeq, seq)
    if (replayed) tally.replayed++
    if (event.kind === 'segment') tally.segments++
    // Only what arrived live says how fast the school pushes: a replay is as late as the bot was away.
    if (event.kind === 'segment' && !replayed)
      sampler.samples.segmentMs.push(clock.now().getTime() - Date.parse(msg.at))
    if (event.kind === 'qa') tally.answersSeen++
    const detail = event.kind === 'segment' ? ` 第 ${event.index} 段` : ''
    say(`class.event #${seq} ${event.kind}${detail}${replayed ? '（补发）' : ''}`)
    if (!replayed && event.kind === 'segment' && welcomed && opts.ask > 0 && random() < opts.ask) askSoon(event.index)
    if (!replayed && random() < opts.dropRate && mayDrop()) drop()
  }

  function onClosing(msg: Of<'closing'>): void {
    closingSeen = true
    say(`closing ${msg.reason}：${msg.message}`)
    if (msg.reason === 'session_over') {
      // After the dismissal that is the lesson over. Before it (the doors not open yet, the service stopping), the close
      // of the connection is followed by another try.
      if (endsAt !== null && clock.now().getTime() >= endsAt) end('下课')
      return
    }
    end(
      {
        replaced: '学号在别处连上了',
        suspended: '停课',
        expelled: '开除',
        on_break: '学校放假',
        maintenance: '学校维护',
      }[msg.reason],
    )
  }

  function onMessage(text: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(text)
    } catch {
      msg = undefined
    }
    if (!Value.Check(ServerMessage, msg)) {
      tally.invalid++
      say('收到一条不合协议的消息')
      return
    }

    switch (msg.type) {
      case 'ack':
        return onAck(msg)
      case 'welcome':
        welcomed = true
        tally.welcomed = true
        // Another session (the service moved on to the next one): its events count from 1 again.
        if (msg.session.sessionId !== sessionId) {
          sessionId = msg.session.sessionId
          lastSeq = 0
          seen.clear()
          questionsInSession = 0
        }
        endsAt = Date.parse(msg.session.endsAt)
        probation = msg.probation
        initiationsLeft = msg.limits.initiationsLeft
        questionLimit = msg.limits.maxQuestionsPerLesson
        online.clear()
        for (const c of msg.online) online.add(c.studentId)
        return say(`welcome 会话 ${msg.session.sessionId}（${msg.session.kind}），在线同学 ${online.size} 位`)
      case 'class.event':
        return onClassEvent(msg)
      case 'presence':
        if (msg.joined !== undefined) {
          online.add(msg.joined.studentId)
          say(`presence 上线 学号 ${msg.joined.studentId}`)
        }
        if (msg.left !== undefined) {
          online.delete(msg.left.studentId)
          say(`presence 下线 学号 ${msg.left.studentId}`)
        }
        return
      case 'chat.incoming': {
        const talk = talks.get(msg.conversationId) ?? { timer: null, last: false }
        talks.set(msg.conversationId, talk)
        talk.last ||= msg.lastLine
        const tag = TAG_PATTERN.exec(msg.text)?.[1]
        const sentAt = tag === undefined ? undefined : sampler.sent.get(tag)
        if (tag !== undefined && sentAt !== undefined) {
          sampler.sent.delete(tag)
          sampler.samples.chatMs.push(clock.now().getTime() - sentAt)
        }
        say(`chat.incoming 第 ${msg.round} 轮${msg.lastLine ? '（该说最后一句）' : ''}，来自学号 ${msg.from.studentId}`)
        return replySoon(msg.conversationId, talk)
      }
      case 'chat.closing': {
        // Class is over: the reply the bot owes is its last line.
        const talk = talks.get(msg.conversationId) ?? { timer: null, last: false }
        talks.set(msg.conversationId, talk)
        talk.last = true
        say('chat.closing')
        return replySoon(msg.conversationId, talk)
      }
      case 'chat.ended': {
        clearTimeout(talks.get(msg.conversationId)?.timer ?? undefined)
        talks.delete(msg.conversationId)
        return say(`chat.ended ${msg.reason}`)
      }
      case 'called_on': {
        say(`called_on 点名 ${msg.callId}`)
        const timer = setTimeout(() => {
          answers.delete(timer)
          send('answer', { callId: msg.callId, text: ANSWER })
        }, between(THINK_MS))
        answers.add(timer)
        return
      }
      case 'summary':
        tally.summary = true
        return say('summary 放学小结')
      case 'closing':
        return onClosing(msg)
    }
  }

  return {
    student,
    tally,
    start() {
      connect()
      thinkOfChatting()
    },
    receive(message) {
      onMessage(JSON.stringify(message))
    },
    stop() {
      tally.ended ??= '中途停止'
      clearTimeout(chatTimer)
      clearTimeout(reconnectTimer)
      socket?.terminate()
    },
  }
}

function refusalsText(refusals: Map<string, number>): string {
  const total = [...refusals.values()].reduce((a, b) => a + b, 0)
  if (total === 0) return '被拒 0 次'
  return `被拒 ${total} 次（${[...refusals].map(([code, n]) => `${code} ${n}`).join('、')}）`
}

type Counts = Omit<BotTally, 'welcomed' | 'summary' | 'ended'>

function countsText(t: Counts): string {
  const invalid = t.invalid > 0 ? `，不合协议的消息 ${t.invalid} 条` : ''
  return (
    `正文 ${t.segments} 段，补发 ${t.replayed} 条，重复 ${t.duplicates} 条，送达 ${t.delivered} 条消息，` +
    `提问 ${t.questionsSent} 个，听到老师答疑 ${t.answersSeen} 次，` +
    `${refusalsText(t.refusals)}，断线 ${t.drops} 次${invalid}`
  )
}

/** The totals printed at the end: one line per bot, then the sum. */
export function totalsText(bots: readonly Bot[]): string {
  const lines = ['—— 汇总 ——']
  const sum: Counts = {
    segments: 0,
    replayed: 0,
    duplicates: 0,
    delivered: 0,
    questionsSent: 0,
    answersSeen: 0,
    refusals: new Map(),
    drops: 0,
    invalid: 0,
  }
  let summaries = 0
  for (const { student, tally } of bots) {
    const ended = tally.ended === '下课' ? '' : `；${tally.ended ?? '还没下课'}`
    lines.push(
      `${student.displayName}（学号 ${student.studentId}）：${countsText(tally)}，${tally.summary ? '收到了' : '没收到'}放学小结${ended}`,
    )
    sum.segments += tally.segments
    sum.replayed += tally.replayed
    sum.duplicates += tally.duplicates
    sum.delivered += tally.delivered
    sum.questionsSent += tally.questionsSent
    sum.answersSeen += tally.answersSeen
    sum.drops += tally.drops
    sum.invalid += tally.invalid
    for (const [code, n] of tally.refusals) sum.refusals.set(code, (sum.refusals.get(code) ?? 0) + n)
    if (tally.summary) summaries++
  }
  lines.push(`合计 ${bots.length} 个机器人：${countsText(sum)}，${summaries} 个收到了放学小结`)
  return lines.join('\n')
}

/** Reads the file `npm run dev:seed` wrote: a list of `{ studentId, key, displayName }`. */
export function readKeysFile(path: string): SeededStudent[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new SimError(`读不了 ${path}，请先用 npm run dev:seed 生成它`)
  }
  const valid = (s: unknown): s is SeededStudent =>
    typeof s === 'object' &&
    s !== null &&
    Number.isInteger((s as SeededStudent).studentId) &&
    typeof (s as SeededStudent).key === 'string' &&
    typeof (s as SeededStudent).displayName === 'string'
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(valid)) {
    throw new SimError(`${path} 应该是 npm run dev:seed 写的列表：[{ studentId, key, displayName }, ...]`)
  }
  return parsed
}

function statText(what: string, stat: Report['segment']): string {
  if (stat.count === 0) return `${what}：没有样本`
  return `${what}：${stat.count} 个样本，p50 ${stat.p50} 毫秒，p90 ${stat.p90} 毫秒，p99 ${stat.p99} 毫秒，最大 ${stat.max} 毫秒`
}

/** The report of a run: as JSON (the numbers, the pass line, and whether it passed), as console lines, and the verdict. */
export function buildReport(samples: Samples, expect: { segmentMs?: number; chatMs?: number }) {
  const report = summarize(samples)
  const { pass, failures } = verdict(report, expect)
  const errors = Object.entries(report.errors)
  const lines = [
    '—— 压测报告 ——',
    statText('课文延迟', report.segment),
    statText('搭话延迟', report.chat),
    `意外断开：${report.unexpectedDisconnects} 次`,
    `被拒：${errors.length === 0 ? '0 次' : errors.map(([code, n]) => `${code} ${n}`).join('、')}`,
    ...failures.map((f) => `没过：${f}`),
    `结论：${pass ? '及格' : '不及格'}`,
  ]
  return { json: { ...report, expect, pass, failures }, lines, pass }
}

const USAGE =
  '用法：npm run sim -- --keys .sim/keys.json --url ws://localhost:8081/v1/class [--chat-every 60] [--drop-rate 0.05] [--max-rounds 3] [--ask 0.3] [--ramp <秒>] [--report <文件.json>] [--expect-segment-ms 5000] [--expect-chat-ms 1000]'

/** The command line, or null when it is not as `USAGE` says. */
export interface SimArgs extends SimOptions {
  keys: string
  /** The seconds over which the bots' first connections are spread at random; 0 connects them all at once. */
  ramp: number
  /** Where to write the report as JSON. */
  report?: string
  /** The pass line (milliseconds, for the p99 of each). */
  expectSegmentMs?: number
  expectChatMs?: number
}

export function parseSimArgs(argv: string[]): SimArgs | null {
  let values: Record<string, string | undefined>
  try {
    values = parseArgs({
      args: argv,
      options: {
        keys: { type: 'string' },
        url: { type: 'string' },
        'chat-every': { type: 'string', default: '60' },
        'drop-rate': { type: 'string', default: '0.05' },
        'max-rounds': { type: 'string', default: '3' },
        ask: { type: 'string', default: '0' },
        ramp: { type: 'string', default: '0' },
        report: { type: 'string' },
        'expect-segment-ms': { type: 'string' },
        'expect-chat-ms': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }).values
  } catch {
    return null
  }
  const { keys, url } = values
  const chatEvery = Number(values['chat-every'])
  const dropRate = Number(values['drop-rate'])
  const maxRounds = Number(values['max-rounds'])
  const ask = Number(values.ask)
  const ramp = Number(values.ramp)
  const report = values.report
  const limit = (text: string | undefined): number | undefined | null => {
    if (text === undefined) return undefined
    const n = Number(text)
    return text.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null
  }
  const expectSegmentMs = limit(values['expect-segment-ms'])
  const expectChatMs = limit(values['expect-chat-ms'])
  if (!(ramp >= 0) || !Number.isFinite(ramp) || report === '') return null
  if (expectSegmentMs === null || expectChatMs === null) return null
  if (keys === undefined || keys === '' || url === undefined || !/^wss?:\/\//.test(url)) return null
  if (!(chatEvery > 0) || !(dropRate >= 0 && dropRate <= 1) || !(ask >= 0 && ask <= 1)) return null
  // The protocol's bounds for hello's maxRounds.
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 50) return null
  return { keys, url, chatEvery, dropRate, maxRounds, ask, ramp, report, expectSegmentMs, expectChatMs }
}

/**
 * Runs the bots until every one is sent home (exit code 0) or Ctrl-C (130). 1 when it cannot start, or when every bot
 * stopped without ever getting into class (the keys are all wrong, say).
 */
async function main(argv: string[]): Promise<number> {
  const args = parseSimArgs(argv)
  if (args === null) {
    console.error(USAGE)
    return 1
  }
  let students: SeededStudent[]
  try {
    students = readKeysFile(args.keys)
  } catch (err) {
    console.error(`模拟失败：${err instanceof SimError ? err.message : String(err)}`)
    return 1
  }

  const clock = systemClock
  const print = (line: string) => console.log(`${clock.now().toTimeString().slice(0, 8)} ${line}`)
  return new Promise((resolve) => {
    let done = false
    const sampler = createSampler()
    const startTimers: NodeJS.Timeout[] = []
    const finish = (code: number) => {
      if (done) return
      done = true
      for (const timer of startTimers) clearTimeout(timer)
      for (const bot of bots) bot.stop()
      console.log(totalsText(bots))
      const expect = { segmentMs: args.expectSegmentMs, chatMs: args.expectChatMs }
      const result = buildReport(sampler.samples, expect)
      console.log(result.lines.join('\n'))
      if (args.report !== undefined) {
        try {
          writeFileSync(args.report, `${JSON.stringify(result.json, null, 2)}\n`)
          console.log(`报告写在 ${args.report}`)
        } catch (err) {
          console.error(`写不了报告 ${args.report}：${String(err)}`)
          code ||= 1
        }
      }
      if (code === 0 && !bots.some((b) => b.tally.welcomed)) {
        console.error('模拟失败：没有一个机器人进得了教室')
        resolve(1)
        return
      }
      // With a pass line given, missing it is a failed run.
      if (code === 0 && !result.pass && (expect.segmentMs !== undefined || expect.chatMs !== undefined)) {
        console.error('压测不及格')
        resolve(1)
        return
      }
      resolve(code)
    }
    const bots: Bot[] = students.map((student) =>
      createBot(student, args, {
        clock,
        random: Math.random,
        print,
        sampler,
        onEnded: () => {
          if (bots.every((b) => b.tally.ended !== null)) finish(0)
        },
      }),
    )
    process.once('SIGINT', () => finish(130))
    console.log(`${bots.length} 个模拟机器人连向 ${args.url}，等到下课`)
    // Spread over the ramp at random, so the school sees them arrive as they would, not all in the same moment.
    for (const bot of bots) {
      if (args.ramp > 0) startTimers.push(setTimeout(() => bot.start(), Math.random() * args.ramp * 1000))
      else bot.start()
    }
  })
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error('模拟失败', err)
      process.exit(1)
    },
  )
}
