import { describe, expect, test } from 'vitest'
import { emptyTally } from '../../src/tools/sim-club.js'
import {
  type BotResult,
  type ClubExpect,
  clubReportJson,
  clubReportLines,
  clubVerdict,
  STOPPED,
  summarizeClub,
  totalTallies,
  type Verification,
} from '../../src/tools/sim-club-report.js'

/** A bot that got in and saw a game to the end, unless `counts` says otherwise. */
function bot(studentId: number, counts: Partial<ReturnType<typeof emptyTally>> = {}): BotResult {
  return { studentId, tally: { ...emptyTally(), welcomes: 1, gameIds: new Set([100 + studentId]), ...counts } }
}

const line = (e: Partial<ClubExpect> = {}): ClubExpect => ({ ackMs: null, turnMs: null, ...e })

const verified = (missing: Verification['missing'] = [], failedBots = 0): Verification => ({
  bots: 2,
  games: 5,
  closingGames: 1,
  missing,
  failedBots,
  complete: true,
})

describe('the totals', () => {
  test('add up every count, and count each game once however many bots saw it', () => {
    const totals = totalTallies([
      bot(1, {
        steps: 10,
        framesDropped: 1,
        resyncs: 2,
        refusals: { stale_turn: 1, illegal_move: 2 },
        closings: { maintenance: 1 },
        seated: { invite: 2, quick: 0, bots: 0 },
        reforms: { games: 1 },
        gameIds: new Set([1, 2]),
        closingGameIds: new Set([2]),
        ended: STOPPED,
      }),
      bot(2, {
        steps: 5,
        refusals: { illegal_move: 1 },
        seated: { invite: 1, quick: 0, bots: 0 },
        gameIds: new Set([2, 3]),
        closingGameIds: new Set([2]),
        ended: '学号在别处连上了',
      }),
      bot(3, { welcomes: 0, gameIds: new Set() }),
    ])
    expect(totals).toMatchObject({
      bots: 3,
      neverWelcomed: 1,
      steps: 15,
      framesDropped: 1,
      resyncs: 2,
      refusals: { stale_turn: 1, illegal_move: 3 },
      closings: { maintenance: 1 },
      seated: { invite: 3, quick: 0, bots: 0 },
      reforms: { games: 1 },
      games: 3,
      closingGames: 1,
      // Only the bot that stopped by itself.
      ended: { 学号在别处连上了: 1 },
    })
  })
})

describe('the verdict', () => {
  const samples = { ackMs: [10, 20, 30, 40, 1000], turnMs: [5, 6] }

  test('checks the p99 of each delay against its line, exactly on the line passing', () => {
    const report = summarizeClub([bot(1)], samples, null, null)
    expect(report.ack).toMatchObject({ count: 5, p50: 30, p99: 1000, max: 1000 })
    expect(clubVerdict(report, line({ ackMs: 1000, turnMs: 6 }))).toEqual({ pass: true, failures: [] })
    expect(clubVerdict(report, line({ ackMs: 999 })).failures).toEqual(['ack 延迟的 p99 是 1000 毫秒，超过了 999 毫秒'])
    expect(clubVerdict(report, line())).toEqual({ pass: true, failures: [] })
  })

  test('a line with no samples fails', () => {
    const report = summarizeClub([bot(1)], { ackMs: [], turnMs: [] }, null, null)
    expect(clubVerdict(report, line({ turnMs: 1000 })).failures).toEqual(['换手延迟没有样本，没法判断是否在 1000 毫秒内'])
  })

  test('an unexpected disconnect, a message off the protocol, a missing game or an unreadable record always fail', () => {
    const missing = [{ studentId: 1, gameId: 7, closing: true }]
    const report = summarizeClub([bot(1, { unexpectedDisconnects: 2, invalid: 1 })], samples, null, verified(missing, 1))
    expect(clubVerdict(report, line()).failures).toEqual([
      '有 2 次意外断开',
      '收到 1 条不合协议的消息',
      '牌谱少了 1 局',
      '有 1 个机器人的牌谱查不了',
    ])
  })

  test('failures to connect and refusals do not fail a run by themselves', () => {
    const report = summarizeClub([bot(1, { connectFailures: 3, refusals: { stale_turn: 4 } })], samples, { checks: 2, failures: 0 }, verified())
    expect(clubVerdict(report, line()).pass).toBe(true)
  })

  test('one connection turned away with 429 fails the run, and says the handshake limits are to be raised', () => {
    const report = summarizeClub([bot(1, { connectFailures: 3, rateLimited: 2 }), bot(2, { rateLimited: 1 })], samples, null, verified())
    expect(report.totals.rateLimited).toBe(3)
    const verdict = clubVerdict(report, line())
    expect(verdict.failures).toEqual(['有 3 次连接被 HTTP 429 拒绝：服务器按地址限流挡住了连接，压测配置里要调大 wsHandshake'])
    expect(clubReportLines(report, verdict).join('\n')).toContain('被 HTTP 429 拒绝（按地址限流）：3 次')
  })

  test('a run where nothing happened fails: nobody got in, no game ended, or no record could be checked', () => {
    const nobody = summarizeClub([bot(1, { welcomes: 0, gameIds: new Set(), connectFailures: 5 })], samples, null, null)
    expect(clubVerdict(nobody, line()).failures).toEqual(['没有一个机器人进得了社团'])
    const noGame = summarizeClub([bot(1, { gameIds: new Set() })], samples, null, null)
    expect(clubVerdict(noGame, line()).failures).toEqual(['一局也没打完'])
    const noSample = summarizeClub([bot(1)], samples, null, { ...verified(), bots: 0, games: 0, closingGames: 0 })
    expect(clubVerdict(noSample, line()).failures).toEqual(['没有可以核对牌谱的机器人'])
  })

  test('a game left without its over as the club closed, a failed /healthz, or a check not finished fail', () => {
    const report = summarizeClub([bot(1, { closingWithoutOver: 1 })], samples, { checks: 3, failures: 1 }, { ...verified(), complete: false })
    expect(clubVerdict(report, line()).failures).toEqual([
      '学校请走时有 1 机器人次没收到这一局的 over',
      '/healthz 失败了 1 次',
      '牌谱核对没做完',
    ])
    expect(clubReportLines(report, clubVerdict(report, line())).join('\n')).toContain('核对没做完')
  })
})

describe('the report', () => {
  test('in Chinese, with the paths, the closing games, the clock note, and the verdict', () => {
    const missing = [{ studentId: 9, gameId: 7, closing: true }]
    const report = summarizeClub(
      [bot(9, { timeoutsLeft: 2, takeBackByOff: 1, gameIds: new Set([7]), closingGameIds: new Set([7]) })],
      { ackMs: [10], turnMs: [] },
      { checks: 12, failures: 1 },
      verified(missing),
    )
    const verdict = clubVerdict(report, line())
    const text = clubReportLines(report, verdict).join('\n')
    expect(text).toContain('ack 延迟（发出游戏动作到收到 ack）：1 个样本')
    expect(text).toContain('换手延迟（上一步房间事件的 at 到收到 your_turn）：没有样本')
    expect(text).toContain('两边的时钟差')
    expect(text).toContain('故意超时 2 次')
    expect(text).toContain('trustee.off 1 次')
    expect(text).toContain('对局：打完 1 局，其中关门或停服时打完的 1 局')
    expect(text).toContain('/healthz：查了 12 次，失败 1 次')
    expect(text).toContain('关门或停服时打完的局：牌谱少了 1 局')
    expect(text).toContain('少了：学号 9 的第 7 局（关门或停服时打完）')
    expect(text).toContain('结论：不及格')
    const json = clubReportJson(report, line({ ackMs: 500 }), verdict)
    expect(json).toMatchObject({ pass: false, expect: { ackMs: 500, turnMs: null }, verification: { missing } })
  })
})
