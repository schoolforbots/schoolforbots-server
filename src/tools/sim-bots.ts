import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import type { Static } from 'typebox'
import { Value } from 'typebox/value'
import WebSocket from 'ws'
import { ServerMessage } from '../protocol/ws.js'
import { systemClock, type Clock } from '../shared/clock.js'
import { SIM_PLUGIN, type SeededStudent } from './dev-seed.js'
import { isEntryPoint } from './entry-point.js'

// `npm run sim -- --keys .sim/keys.json --url ws://localhost:8081/v1/class [--chat-every 60] [--drop-rate 0.05]
// [--max-rounds 3]`: for local development only. One simulated bot per key in the file `npm run dev:seed` wrote
// comes to class: it says hello, keeps the last class event it has, starts a conversation with an online classmate now
// and then, replies to whoever talks to it, answers when it is called on, and drops its connection at random to come
// back a few seconds later with the `sessionId` of its welcome and `lastSeq`. Every event is one line on the console
// (the bot, the type, the number; never what was said), and once every bot is sent home after the lesson (or on
// Ctrl-C) it prints what each received. A bot turned away at the door before its lesson tries again every few seconds,
// so it can be started early.

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

export interface BotDeps {
  clock: Clock
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
}

type Message = Static<typeof ServerMessage>
type Of<T extends Message['type']> = Extract<Message, { type: T }>

const START_LINES = ['你好呀，这一段你听懂了吗？', '同学你好，我们来聊聊刚才讲的内容吧。', '嗨，你觉得老师讲得怎么样？']
const REPLY_LINES = ['我听懂了，你呢？', '我觉得这一段挺有意思的。', '对，我也是这么想的。', '老师讲得很清楚，我记下来了。']
const LAST_LINE = '下次再找你聊'
const ANSWER = '这一段讲的是……'

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
  const tally: BotTally = {
    segments: 0,
    replayed: 0,
    duplicates: 0,
    delivered: 0,
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
  let reconnectTimer: NodeJS.Timeout | undefined
  let chatTimer: NodeJS.Timeout | undefined
  let nextId = 0

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
  }

  function send(type: string, body: object): void {
    if (socket === null || socket.readyState !== WebSocket.OPEN) return
    const id = `${type}-${++nextId}`
    requests.set(id, type)
    socket.send(JSON.stringify({ id, type, ...body }))
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
    ws.on('open', () => {
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
    say(`断线，${(retryIn / 1000).toFixed(1)} 秒后重连`)
    socket?.terminate()
  }

  /** Sends the reply of a conversation after a moment, unless one is on its way already. */
  function replySoon(conversationId: string, talk: { timer: NodeJS.Timeout | null; last: boolean }): void {
    if (talk.timer !== null) return
    talk.timer = setTimeout(() => {
      talk.timer = null
      send('chat.reply', { conversationId, text: talk.last ? LAST_LINE : pick(REPLY_LINES) })
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
    send('chat.start', { to: pick([...online]), text: pick(START_LINES) })
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
    if (code === 'initiation_cap') initiationsLeft = 0
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
    const detail = event.kind === 'segment' ? ` 第 ${event.index} 段` : ''
    say(`class.event #${seq} ${event.kind}${detail}${replayed ? '（补发）' : ''}`)
    if (!replayed && random() < opts.dropRate && mayDrop()) drop()
  }

  function onClosing(msg: Of<'closing'>): void {
    say(`closing ${msg.reason}：${msg.message}`)
    if (msg.reason === 'session_over') {
      // After the dismissal that is the lesson over. Before it (the doors not open yet, the service going down for
      // maintenance), the close of the connection is followed by another try.
      if (endsAt !== null && clock.now().getTime() >= endsAt) end('下课')
      return
    }
    end({ replaced: '学号在别处连上了', suspended: '停课', expelled: '开除', on_break: '学校放假' }[msg.reason])
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
        }
        endsAt = Date.parse(msg.session.endsAt)
        probation = msg.probation
        initiationsLeft = msg.limits.initiationsLeft
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

function countsText(t: Omit<BotTally, 'welcomed' | 'summary' | 'ended'>): string {
  const invalid = t.invalid > 0 ? `，不合协议的消息 ${t.invalid} 条` : ''
  return (
    `正文 ${t.segments} 段，补发 ${t.replayed} 条，重复 ${t.duplicates} 条，送达 ${t.delivered} 条消息，` +
    `${refusalsText(t.refusals)}，断线 ${t.drops} 次${invalid}`
  )
}

/** The totals printed at the end: one line per bot, then the sum. */
export function totalsText(bots: readonly Bot[]): string {
  const lines = ['—— 汇总 ——']
  const sum: Omit<BotTally, 'welcomed' | 'summary' | 'ended'> = {
    segments: 0,
    replayed: 0,
    duplicates: 0,
    delivered: 0,
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

const USAGE =
  '用法：npm run sim -- --keys .sim/keys.json --url ws://localhost:8081/v1/class [--chat-every 60] [--drop-rate 0.05] [--max-rounds 3]'

/** The command line, or null when it is not as `USAGE` says. */
export function parseSimArgs(argv: string[]): (SimOptions & { keys: string }) | null {
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
  if (keys === undefined || keys === '' || url === undefined || !/^wss?:\/\//.test(url)) return null
  if (!(chatEvery > 0) || !(dropRate >= 0 && dropRate <= 1)) return null
  // The protocol's bounds for hello's maxRounds.
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 50) return null
  return { keys, url, chatEvery, dropRate, maxRounds }
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
    const finish = (code: number) => {
      if (done) return
      done = true
      for (const bot of bots) bot.stop()
      console.log(totalsText(bots))
      if (code === 0 && !bots.some((b) => b.tally.welcomed)) {
        console.error('模拟失败：没有一个机器人进得了教室')
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
        onEnded: () => {
          if (bots.every((b) => b.tally.ended !== null)) finish(0)
        },
      }),
    )
    process.once('SIGINT', () => finish(130))
    console.log(`${bots.length} 个模拟机器人连向 ${args.url}，等到下课`)
    for (const bot of bots) bot.start()
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
