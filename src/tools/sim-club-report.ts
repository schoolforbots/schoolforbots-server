import type { ClubBotTally, ClubSampler, TableMode } from './sim-club.js'
import { rateLimitedFailure, type Stat, statOf } from './sim-report.js'

// The pure part of the club simulator's report (see sim-club.ts): the totals of what the bots counted, the percentiles
// of the delays they measured, the result of checking their game records, and whether the run is within the pass line.

/** The numbers every bot counts, summed. */
export const COUNTED = [
  'connects',
  'welcomes',
  'connectFailures',
  'rateLimited',
  'unexpectedDisconnects',
  'drops',
  'reconnects',
  'resyncs',
  'invalid',
  'botsAsked',
  'turns',
  'steps',
  'timeoutsLeft',
  'timeoutSteps',
  'trusteeSteps',
  'closingSteps',
  'trusteeOn',
  'trusteeOnClosing',
  'trusteeOff',
  'takeBackByStep',
  'takeBackByOff',
  'illegalSent',
  'illegalRefused',
  'retries',
  'reactsSent',
  'reactsRefused',
  'framesHeld',
  'framesDropped',
  'closingWithoutOver',
  'closingMissedAway',
] as const satisfies readonly (keyof ClubBotTally)[]

export type Counted = (typeof COUNTED)[number]

export interface ClubTotals extends Record<Counted, number> {
  bots: number
  /** Bots never welcomed during the run. */
  neverWelcomed: number
  /** Bots that stopped by themselves before the end, by why. */
  ended: Record<string, number>
  closings: Record<string, number>
  refusals: Record<string, number>
  seated: Record<TableMode, number>
  reforms: Record<string, number>
  /** Games seen to the end by at least one bot (each game once), and those played out as the club closed or stopped. */
  games: number
  closingGames: number
}

/** What a bot hands the report: its tally (with the student it plays for). */
export interface BotResult {
  studentId: number
  tally: ClubBotTally
}

const addAll = (into: Record<string, number>, from: Record<string, number>) => {
  for (const [key, n] of Object.entries(from)) into[key] = (into[key] ?? 0) + n
}

export function totalTallies(bots: readonly BotResult[]): ClubTotals {
  const totals = {
    bots: bots.length,
    neverWelcomed: 0,
    ended: {},
    closings: {},
    refusals: {},
    seated: { invite: 0, quick: 0, bots: 0 },
    reforms: {},
    games: 0,
    closingGames: 0,
  } as unknown as ClubTotals
  for (const key of COUNTED) totals[key] = 0
  const games = new Set<number>()
  const closing = new Set<number>()
  for (const { tally } of bots) {
    for (const key of COUNTED) totals[key] += tally[key]
    if (tally.welcomes === 0) totals.neverWelcomed++
    // A bot stopped at the end of the run did not stop by itself.
    if (tally.ended !== null && tally.ended !== STOPPED) addAll(totals.ended, { [tally.ended]: 1 })
    addAll(totals.closings, tally.closings)
    addAll(totals.refusals, tally.refusals)
    addAll(totals.seated, tally.seated)
    addAll(totals.reforms, tally.reforms)
    for (const id of tally.gameIds) games.add(id)
    for (const id of tally.closingGameIds) closing.add(id)
  }
  totals.games = games.size
  totals.closingGames = closing.size
  return totals
}

/** Why a bot stopped when the run ended it (see `ClubBot.stop`). */
export const STOPPED = '中途停止'

/** A game a bot saw to the end that its student's records do not list. */
export interface MissingGame {
  studentId: number
  gameId: number
  /** Played out as the club closed or the service stopped. */
  closing: boolean
}

/** The check of the records of a sample of the bots. */
export interface Verification {
  /** Bots whose records were looked up, and the games of theirs that were looked for (each game once). */
  bots: number
  games: number
  /** Of those, the games played out as the club closed or the service stopped. */
  closingGames: number
  missing: MissingGame[]
  /** Bots whose records could not be read (a request failed every time). */
  failedBots: number
  /** False when the check was stopped before its end (Ctrl-C): then nothing is known missing, and nothing sure. */
  complete: boolean
}

export interface ClubReport {
  ack: Stat
  turn: Stat
  totals: ClubTotals
  /** `/healthz` looks, and how many of them did not answer 200; null when not watched. */
  healthz: { checks: number; failures: number } | null
  verification: Verification | null
}

export function summarizeClub(
  bots: readonly BotResult[],
  samples: ClubSampler,
  healthz: ClubReport['healthz'],
  verification: Verification | null,
): ClubReport {
  return { ack: statOf(samples.ackMs), turn: statOf(samples.turnMs), totals: totalTallies(bots), healthz, verification }
}

/** The pass line: the p99 of each delay (ms), null when not judged. */
export interface ClubExpect {
  ackMs: number | null
  turnMs: number | null
}

/**
 * Whether the run is within the pass line: the p99 of the ack delays within `ackMs` and of the hand-off delays within
 * `turnMs` (each only when given; exactly on the line passes; a limit with no samples fails), and always: some bot got
 * in and some game was played to the end (a run where nothing happened proves nothing); no unexpected disconnect, no
 * message off the protocol, no connection turned away with 429 (the limits per address, to be raised for the test),
 * no game left without its `over` as the club closed or the service stopped; `/healthz` never failed when watched; and
 * when records were to be checked, some were, to the end, every one read and no game missing. Other failures to
 * connect do not fail a run by themselves.
 */
export function clubVerdict(report: ClubReport, expect: ClubExpect): { pass: boolean; failures: string[] } {
  const failures: string[] = []
  const check = (what: string, stat: Stat, limit: number | null) => {
    if (limit === null) return
    if (stat.p99 === null) failures.push(`${what}没有样本，没法判断是否在 ${limit} 毫秒内`)
    else if (stat.p99 > limit) failures.push(`${what}的 p99 是 ${stat.p99} 毫秒，超过了 ${limit} 毫秒`)
  }
  check('ack 延迟', report.ack, expect.ackMs)
  check('换手延迟', report.turn, expect.turnMs)
  const { totals, verification, healthz } = report
  if (totals.welcomes === 0) failures.push('没有一个机器人进得了社团')
  else if (totals.games === 0) failures.push('一局也没打完')
  if (totals.unexpectedDisconnects > 0) failures.push(`有 ${totals.unexpectedDisconnects} 次意外断开`)
  if (totals.rateLimited > 0) failures.push(rateLimitedFailure(totals.rateLimited))
  if (totals.invalid > 0) failures.push(`收到 ${totals.invalid} 条不合协议的消息`)
  if (totals.closingWithoutOver > 0) failures.push(`学校请走时有 ${totals.closingWithoutOver} 机器人次没收到这一局的 over`)
  if (healthz !== null && healthz.failures > 0) failures.push(`/healthz 失败了 ${healthz.failures} 次`)
  if (verification !== null) {
    if (verification.bots === 0) failures.push('没有可以核对牌谱的机器人')
    if (!verification.complete) failures.push('牌谱核对没做完')
    if (verification.missing.length > 0) failures.push(`牌谱少了 ${verification.missing.length} 局`)
    if (verification.failedBots > 0) failures.push(`有 ${verification.failedBots} 个机器人的牌谱查不了`)
  }
  return { pass: failures.length === 0, failures }
}

function statText(what: string, stat: Stat): string {
  if (stat.count === 0) return `${what}：没有样本`
  return `${what}：${stat.count} 个样本，p50 ${stat.p50} 毫秒，p90 ${stat.p90} 毫秒，p99 ${stat.p99} 毫秒，最大 ${stat.max} 毫秒`
}

const countsText = (counts: Record<string, number>) => {
  const entries = Object.entries(counts).filter(([, n]) => n > 0)
  return entries.length === 0 ? '0 次' : entries.map(([key, n]) => `${key} ${n}`).join('、')
}

/** The report as console lines, ending with the verdict. */
export function clubReportLines(report: ClubReport, verdict: { pass: boolean; failures: string[] }): string[] {
  const t = report.totals
  const v = report.verification
  const lines = [
    '—— 社团压测报告 ——',
    statText('ack 延迟（发出游戏动作到收到 ack）', report.ack),
    statText('换手延迟（上一步房间事件的 at 到收到 your_turn）', report.turn),
    '（换手延迟拿学校时钟的 at 和本机时钟比：对着别的机器跑时，两边的时钟差也在里面）',
    `机器人：${t.bots} 个，一直没进社团的 ${t.neverWelcomed} 个，自己停下的：${countsText(t.ended)}`,
    `连接：连上 ${t.connects} 次，进社团 ${t.welcomes} 次，连不上 ${t.connectFailures} 次，意外断开 ${t.unexpectedDisconnects} 次`,
    `连接被 HTTP 429 拒绝（按地址限流）：${t.rateLimited} 次`,
    `学校请走：${countsText(t.closings)}`,
    `凑桌：邀请 ${t.seated.invite} 次，快速加入 ${t.seated.quick} 次，带陪练 ${t.seated.bots} 次；换桌：${countsText(t.reforms)}；空闲时叫陪练 ${t.botsAsked} 次`,
    `对局：打完 ${t.games} 局，其中关门或停服时打完的 ${t.closingGames} 局`,
    `关门或停服时：没收到这一局 over 的 ${t.closingWithoutOver} 机器人次；掉线在外、回来时在门口被请走而没看到结局的 ${t.closingMissedAway} 机器人次（只列出，不算进结论）`,
    `步数：收到 your_turn ${t.turns} 次，交了 ${t.steps} 步；故意超时 ${t.timeoutsLeft} 次，超时替出 ${t.timeoutSteps} 步，托管替出 ${t.trusteeSteps} 步，关门替出 ${t.closingSteps} 步`,
    `托管：进托管 ${t.trusteeOn} 次（关门时 ${t.trusteeOnClosing} 次），出托管 ${t.trusteeOff} 次；收回：交一步 ${t.takeBackByStep} 次，trustee.off ${t.takeBackByOff} 次`,
    `非法动作：发出 ${t.illegalSent} 次，被拒 ${t.illegalRefused} 次，重交 ${t.retries} 次`,
    `掉线：主动断开 ${t.drops} 次，回到原房间 ${t.reconnects} 次，重新对房间 ${t.resyncs} 次`,
    `互动消息：发出 ${t.reactsSent} 条，被拒 ${t.reactsRefused} 条`,
    `帧数限制：压住 ${t.framesHeld} 帧，过时丢掉 ${t.framesDropped} 帧`,
    `不合协议的消息：${t.invalid} 条`,
    `被拒：${countsText(t.refusals)}`,
  ]
  if (report.healthz !== null) lines.push(`/healthz：查了 ${report.healthz.checks} 次，失败 ${report.healthz.failures} 次`)
  if (v === null) lines.push('牌谱核对：没有做')
  else {
    lines.push(
      `牌谱核对：${v.bots} 个机器人，${v.games} 局（其中关门或停服时打完的 ${v.closingGames} 局），少了 ${v.missing.length} 局，查不了的机器人 ${v.failedBots} 个` +
        (v.complete ? '' : '；核对没做完'),
    )
    const closingMissing = v.missing.filter((m) => m.closing).length
    lines.push(`关门或停服时打完的局：牌谱少了 ${closingMissing} 局`)
    for (const m of v.missing.slice(0, 20)) lines.push(`  少了：学号 ${m.studentId} 的第 ${m.gameId} 局${m.closing ? '（关门或停服时打完）' : ''}`)
  }
  lines.push(...verdict.failures.map((f) => `没过：${f}`), `结论：${verdict.pass ? '及格' : '不及格'}`)
  return lines
}

/** The report as JSON: the numbers, the pass line and whether it passed. */
export function clubReportJson(report: ClubReport, expect: ClubExpect, verdict: { pass: boolean; failures: string[] }) {
  return { ...report, expect, pass: verdict.pass, failures: verdict.failures }
}
