import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { ClubStudent, DoudizhuPage } from '../api.js'
import { clubDay, doudizhuPage, fail, fakeServer, ok, shiftDate, show, YESTERDAY } from '../test-api.js'
import { Clubs } from './Clubs.js'

const TODAY = shiftDate(YESTERDAY, 1)
const PATH = 'GET api/clubs/doudizhu?days=7'

const named = (studentId: number, owner: string, className: string | null = '初中部·晚班·3 班'): ClubStudent => ({
  studentId,
  displayName: `${owner}家的小鱼 #${String(studentId).padStart(4, '0')}`,
  className,
})

/** A busy week: something in every part of the page. */
function busy(): DoudizhuPage {
  const base = doudizhuPage(7)
  return {
    ...base,
    members: 412,
    todaySoFar: clubDay(TODAY, { games: 30, rankedGames: 20, players: 25, newMembers: 3 }),
    sameTimeLastWeek: clubDay(shiftDate(TODAY, -7), { games: 20, rankedGames: 10, players: 25, newMembers: 5 }),
    yesterday: clubDay(YESTERDAY, { games: 120, rankedGames: 80, players: 70, newMembers: 9 }),
    sameDayLastWeek: clubDay(shiftDate(YESTERDAY, -7), { games: 100, rankedGames: 60, players: 71, newMembers: 9 }),
    series: base.series.map((day, i) => ({ ...day, games: 10 + i, rankedGames: 5 + i, players: 8, newMembers: i })),
    week: {
      startsOn: '2026-11-02',
      board: {
        entries: [
          { rank: 1, ...named(37, '阿杰'), className: '初中部·晚班·3 班', points: 52, games: 14 },
          { rank: 2, ...named(38, '小美'), className: '初中部·晚班·3 班', points: 30, games: 12 },
          { rank: 2, ...named(39, '大壮'), className: '高中部·上午班·1 班', points: 30, games: 9 },
        ],
        total: 63,
      },
      conduct: {
        seats: 200,
        timedOut: { seats: 50, times: 61 },
        trustee: { seats: 20, moves: 140 },
        illegal: { seats: 2, moves: 3 },
      },
      sameAddress: {
        total: 1,
        games: [
          {
            gameId: 10422,
            // 20:15 at the school, yesterday.
            endedAt: `${YESTERDAY}T12:15:00.000Z`,
            ranked: true,
            students: [named(37, '阿杰'), named(52, '离校的', null)],
          },
        ],
      },
      pairs: [{ students: [named(37, '阿杰'), named(38, '小美')], games: 14, points: [52, -30] }],
    },
  }
}

const tile = (day: string, name: string) =>
  within(within(screen.getByRole('region', { name: day })).getByRole('group', { name }))

describe('the clubs page', () => {
  it('has a tab for each club, doudizhu open', async () => {
    fakeServer({ [PATH]: ok(busy()) })
    show(<Clubs />)
    const tabs = screen.getByRole('radiogroup', { name: '看哪个社团' })
    expect(within(tabs).getByRole('radio', { name: '斗地主社' })).toBeChecked()
    expect(await screen.findByRole('region', { name: /本周积分榜/ })).toBeInTheDocument()
  })

  it('shows today and yesterday next to the same day last week, and the members now', async () => {
    fakeServer({ [PATH]: ok(busy()) })
    show(<Clubs />)
    const today = '今天（截至 16:00），11 月 4 日（周三）'
    await screen.findByRole('region', { name: today })

    expect(tile(today, '对局').getByText('30')).toBeInTheDocument()
    expect(tile(today, '对局').getByText('比上周三多 10')).toBeInTheDocument()
    expect(tile(today, '对局').getByText('其中有机器人补位的 10 局')).toBeInTheDocument()
    expect(tile(today, '下场的学生').getByText('和上周三一样')).toBeInTheDocument()
    expect(tile(today, '新入社').getByText('比上周三少 2')).toBeInTheDocument()
    expect(tile(today, '现在的社员').getByText('412')).toBeInTheDocument()

    const yesterday = '昨天，11 月 3 日（周二）'
    expect(tile(yesterday, '对局').getByText('上周二 100')).toBeInTheDocument()
    expect(tile(yesterday, '下场的学生').getByText('比上周二少 1')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: yesterday })).queryByRole('group', { name: '现在的社员' })).toBeNull()
  })

  it("lists the week's board, the pairs, the games from one address and the conduct", async () => {
    fakeServer({ [PATH]: ok(busy()) })
    show(<Clubs />)

    const board = await screen.findByRole('region', { name: '本周积分榜（11 月 2 日（周一）起）' })
    expect(within(board).getByText(/共 63 位社员/)).toHaveTextContent('这里列前 3 位')
    const rows = within(board).getAllByRole('row').slice(1)
    expect(rows.map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent))).toEqual([
      ['1', '初中部·晚班·3 班', '52', '14'],
      ['2', '初中部·晚班·3 班', '30', '12'],
      ['2', '高中部·上午班·1 班', '30', '9'],
    ])

    const pairs = screen.getByRole('region', { name: '本周同桌最多的学生' })
    expect(within(pairs).getByRole('cell', { name: '阿杰家的小鱼 #0037（初中部·晚班·3 班）' })).toBeInTheDocument()
    expect(within(pairs).getByRole('cell', { name: '52 / -30' })).toBeInTheDocument()

    const address = screen.getByRole('region', { name: '本周同一个网络地址坐了两个座位的对局' })
    const [game] = within(address).getAllByRole('row').slice(1)
    expect(within(game!).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      '10422',
      '11/3 周二 20:15',
      '没有',
      '阿杰家的小鱼 #0037（初中部·晚班·3 班）、离校的家的小鱼 #0052',
    ])

    const conduct = screen.getByRole('region', { name: '本周的超时、托管和违规出牌' })
    expect(within(conduct).getByRole('row', { name: '超时过的座位 50，占 25.0%，共超时 61 次' })).toBeInTheDocument()
    expect(within(conduct).getByRole('row', { name: '被托管出过牌的座位 20，占 10.0%，托管出了 140 手' })).toBeInTheDocument()
  })

  it('says so when the week has nothing yet, and when the clubs are closed', async () => {
    fakeServer({ [PATH]: ok(doudizhuPage(7, { enabled: false })) })
    show(<Clubs />)
    expect(await screen.findByText(/社团现在关着/)).toBeInTheDocument()
    expect(screen.getByText('本周还没有社员下过没有机器人的对局。')).toBeInTheDocument()
    expect(screen.getByText('本周没有这样的对局。')).toBeInTheDocument()
    expect(screen.getByText('最近 7 天斗地主社还没有数据。')).toBeInTheDocument()
  })

  it('reads another range on asking, and says why it could not', async () => {
    const server = fakeServer({
      [PATH]: ok(busy()),
      'GET api/clubs/doudizhu?days=30': fail(500, 'internal', '服务器出错了'),
    })
    const user = userEvent.setup()
    show(<Clubs />)
    await screen.findByRole('heading', { name: '最近 7 天' })
    await user.click(screen.getByRole('radio', { name: '30 天' }))
    expect(await screen.findByText(/服务器出错了/)).toBeInTheDocument()
    expect(server.calls.map((call) => call.path)).toContain('api/clubs/doudizhu?days=30')
  })

  it('says why the page could not be read', async () => {
    fakeServer({ [PATH]: fail(500, 'internal', '服务器出错了') })
    show(<Clubs />)
    expect(await screen.findByText(/服务器出错了/)).toBeInTheDocument()
  })
})
