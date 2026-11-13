import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { DailyStats } from '../api.js'
import {
  dailyStats,
  dayNumbers,
  fail,
  fakeServer,
  ok,
  seriesDay,
  shiftDate,
  show,
  YESTERDAY,
  type Reply,
} from '../test-api.js'
import { Data } from './Data.js'

const LAST_WEEK = shiftDate(YESTERDAY, -7)
const TODAY = shiftDate(YESTERDAY, 1)
const TODAY_LAST_WEEK = shiftDate(TODAY, -7)
// The answers count today up to 16:00 at the school unless they say otherwise.
const TODAY_TITLE = '今天（截至 16:00），11 月 4 日（周三）'
const YESTERDAY_TITLE = '昨天，11 月 3 日（周二）'

/** The tiles of one day: the panel titled `day`. */
function panel(day: string) {
  return within(screen.getByRole('region', { name: day }))
}

function tile(name: string, day = YESTERDAY_TITLE) {
  return within(panel(day).getByRole('group', { name }))
}

/** A week with something on every curve, ending yesterday. */
function busyWeek() {
  return dailyStats(7, {
    series: Array.from({ length: 7 }, (_, i) =>
      seriesDay(shiftDate(YESTERDAY, i - 6), {
        dauBySlot: { morning: 10 + i, afternoon: 20 + i, evening: 30 + i },
        chat: 100 * (i + 1),
        blockedByCategory: { sensitive: i, injection: 1, privacy: 0 },
        costByPurpose: {
          lesson: 1.5,
          answer: 0.25 * i,
          comment: 0.1,
          weekly: 0,
          secondLayerTeacher: 0.0123,
          secondLayerChat: 0,
          wordList: 0,
        },
      }),
    ),
    switchChanges: [{ name: 'teacherLlm', on: false, at: '2026-11-02T06:00:00.000Z' }],
  })
}

describe('the school data page', () => {
  it('says what it is reading while it waits', () => {
    fakeServer({ 'GET api/stats/daily?days=7': { pending: true } })
    show(<Data onGoReview={vi.fn()} />)

    expect(screen.getByRole('status')).toHaveTextContent('正在读取学校数据')
  })

  it('says why there are no curves yet, and when they come', async () => {
    fakeServer({ 'GET api/stats/daily?days=7': ok(dailyStats(7)) })
    show(<Data onGoReview={vi.fn()} />)

    expect(
      await screen.findByText('最近 7 天还没有数据。学校开学后，第二天这里会出现第一组数字。'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('figure')).not.toBeInTheDocument()
  })

  it('says what failed, and reads again', async () => {
    let up = false
    fakeServer({
      'GET api/stats/daily?days=7': () =>
        up ? ok(dailyStats(7, { yesterday: dayNumbers(YESTERDAY, { dau: 42 }) })) : { networkError: true },
    })
    const user = userEvent.setup()
    show(<Data onGoReview={vi.fn()} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('没能读取学校数据。连不上服务器，检查网络后再试。')
    up = true
    await user.click(screen.getByRole('button', { name: '重新读取' }))

    expect(await screen.findByRole('heading', { name: YESTERDAY_TITLE })).toBeInTheDocument()
    expect(tile('来上课的学生').getByText('42')).toBeInTheDocument()
  })

  it('shows the server’s reason when it refuses', async () => {
    fakeServer({ 'GET api/stats/daily?days=7': fail(503, 'llm_unavailable', '服务器正忙。') })
    show(<Data onGoReview={vi.fn()} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('没能读取学校数据。服务器正忙。')
  })

  it('shows yesterday’s numbers, each with the change from the same day last week', async () => {
    fakeServer({
      'GET api/stats/daily?days=7': ok(
        dailyStats(7, {
          yesterday: dayNumbers(YESTERDAY, {
            dau: 128,
            chat: 5321,
            blocked: 12,
            violations: 3,
            suspensions: 1,
            expulsions: 0,
            registrations: 9,
            costYuan: 3.21,
          }),
          sameDayLastWeek: dayNumbers(LAST_WEEK, {
            dau: 120,
            chat: 5321,
            blocked: 20,
            violations: 1,
            suspensions: 1,
            expulsions: 2,
            registrations: 0,
            costYuan: 2,
          }),
          month: { costYuan: 45.67, budgetYuan: 300, overBudget: false },
        }),
      ),
    })
    show(<Data onGoReview={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: YESTERDAY_TITLE })).toBeInTheDocument()
    const expected: [string, string, string][] = [
      ['来上课的学生', '128', '比上周二多 8'],
      ['聊天消息', '5,321', '和上周二一样'],
      ['拦下的消息', '12', '比上周二少 8'],
      ['违反校规', '3', '比上周二多 2'],
      ['停课', '1', '和上周二一样'],
      ['开除', '0', '比上周二少 2'],
      ['新报名', '9', '比上周二多 9'],
      ['大模型花费', '¥3.21', '比上周二多 ¥1.21'],
    ]
    for (const [name, value, change] of expected) {
      expect(tile(name).getByText(value)).toBeInTheDocument()
      expect(tile(name).getByText(change)).toBeInTheDocument()
    }
    // The month so far goes with today, whose spend is in it.
    expect(tile('大模型花费', TODAY_TITLE).getByText('本月 ¥45.67，预算 ¥300.00')).toBeInTheDocument()
    expect(tile('大模型花费').queryByText(/本月/)).not.toBeInTheDocument()
  })

  it('shows today’s numbers up to now, each set against the same day last week up to the same time', async () => {
    fakeServer({
      'GET api/stats/daily?days=7': ok(
        dailyStats(7, {
          todaySoFar: dayNumbers(TODAY, {
            dau: 64,
            chat: 2100,
            blocked: 5,
            violations: 1,
            suspensions: 0,
            expulsions: 0,
            registrations: 4,
            costYuan: 1.5,
          }),
          sameTimeLastWeek: dayNumbers(TODAY_LAST_WEEK, {
            dau: 60,
            chat: 2100,
            blocked: 7,
            violations: 0,
            suspensions: 0,
            expulsions: 1,
            registrations: 1,
            costYuan: 1.75,
          }),
          yesterday: dayNumbers(YESTERDAY, { dau: 128 }),
        }),
      ),
    })
    show(<Data onGoReview={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: TODAY_TITLE })).toBeInTheDocument()
    // What they are set against is said once, above them.
    expect(panel(TODAY_TITLE).getByText('和上周三零点到 16:00 的数字比。')).toBeInTheDocument()
    const expected: [string, string, string][] = [
      ['来上课的学生', '64', '比上周三多 4'],
      ['聊天消息', '2,100', '和上周三一样'],
      ['拦下的消息', '5', '比上周三少 2'],
      ['违反校规', '1', '比上周三多 1'],
      ['停课', '0', '和上周三一样'],
      ['开除', '0', '比上周三少 1'],
      ['新报名', '4', '比上周三多 3'],
      ['大模型花费', '¥1.50', '比上周三少 ¥0.25'],
    ]
    for (const [name, value, change] of expected) {
      expect(tile(name, TODAY_TITLE).getByText(value)).toBeInTheDocument()
      expect(tile(name, TODAY_TITLE).getByText(change)).toBeInTheDocument()
    }
    // Today comes first, yesterday after it, as they were counted.
    const titles = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)
    expect(titles.slice(0, 2)).toEqual([TODAY_TITLE, YESTERDAY_TITLE])
    expect(tile('来上课的学生').getByText('128')).toBeInTheDocument()
  })

  it('reads the time up to which today is counted on the school’s clock', async () => {
    // 16:00 in Shanghai is 09:00 in London.
    fakeServer({ 'GET api/stats/daily?days=7': ok(dailyStats(7, { timeZone: 'Europe/London' })) })
    show(<Data onGoReview={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: '今天（截至 08:00），11 月 4 日（周三）' })).toBeInTheDocument()
  })

  it('says when the same day last week came before the school opened', async () => {
    fakeServer({
      'GET api/stats/daily?days=7': ok(dailyStats(7, { sameDayLastWeek: null, sameTimeLastWeek: null })),
    })
    show(<Data onGoReview={vi.fn()} />)

    await screen.findByRole('heading', { name: TODAY_TITLE })
    expect(panel(YESTERDAY_TITLE).getAllByText('上周二学校还没开学')).toHaveLength(8)
    expect(panel(TODAY_TITLE).getAllByText('上周三学校还没开学')).toHaveLength(8)
    expect(panel(TODAY_TITLE).queryByText(/的数字比/)).not.toBeInTheDocument()
  })

  it('says why no class is held today, and still shows the day’s numbers', async () => {
    const cases: [DailyStats['todayStatus'], string][] = [
      [{ state: 'not_started', breakName: null, schoolDay: false, maintenance: false }, '学校还没开学，今天不上课。'],
      [{ state: 'on_break', breakName: '寒假', schoolDay: false, maintenance: true }, '今天放假（寒假），不上课。'],
      [{ state: 'on_break', breakName: null, schoolDay: false, maintenance: false }, '今天放假，不上课。'],
      [{ state: 'in_term', breakName: null, schoolDay: false, maintenance: false }, '今天是周三，周末不上课。'],
      [
        { state: 'in_term', breakName: null, schoolDay: true, maintenance: true },
        '现在维护中：上课服务不让任何人进，碰上维护的时段今天不上课。',
      ],
    ]
    for (const [todayStatus, why] of cases) {
      fakeServer({
        'GET api/stats/daily?days=7': ok(
          dailyStats(7, { todayStatus, todaySoFar: dayNumbers(TODAY, { registrations: 12 }) }),
        ),
      })
      const { unmount } = show(<Data onGoReview={vi.fn()} />)

      await screen.findByRole('heading', { name: TODAY_TITLE })
      expect(panel(TODAY_TITLE).getByText(`和上周三零点到 16:00 的数字比。${why}`)).toBeInTheDocument()
      expect(tile('新报名', TODAY_TITLE).getByText('12')).toBeInTheDocument()
      unmount()
    }
  })

  it('says nothing above today’s numbers on a school day', async () => {
    fakeServer({ 'GET api/stats/daily?days=7': ok(dailyStats(7)) })
    show(<Data onGoReview={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: TODAY_TITLE })).toBeInTheDocument()
    expect(panel(TODAY_TITLE).getByText('和上周三零点到 16:00 的数字比。')).toBeInTheDocument()
    expect(panel(TODAY_TITLE).queryByText(/不上课/)).not.toBeInTheDocument()
  })

  it('reads today’s numbers again up to now', async () => {
    let answer: Reply = ok(dailyStats(7, { todaySoFar: dayNumbers(TODAY, { chat: 10 }) }))
    const { calls } = fakeServer({ 'GET api/stats/daily?days=7': () => answer })
    const user = userEvent.setup()
    show(<Data onGoReview={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: TODAY_TITLE })).toBeInTheDocument()
    expect(tile('聊天消息', TODAY_TITLE).getByText('10')).toBeInTheDocument()

    // A class later, at 16:30 (08:30 UTC).
    answer = ok(dailyStats(7, { todaySoFar: dayNumbers(TODAY, { chat: 250 }), asOf: `${TODAY}T08:30:00.000Z` }))
    await user.click(screen.getByRole('button', { name: '更新到现在' }))
    const later = '今天（截至 16:30），11 月 4 日（周三）'
    expect(await screen.findByRole('heading', { name: later })).toBeInTheDocument()
    expect(tile('聊天消息', later).getByText('250')).toBeInTheDocument()
    expect(panel(later).getByText('和上周三零点到 16:30 的数字比。')).toBeInTheDocument()

    // While it reads, the button says so and keeps the focus; a second click asks nothing more.
    answer = { pending: true }
    const update = screen.getByRole('button', { name: '更新到现在' })
    await user.click(update)
    expect(update).toHaveTextContent('正在更新')
    expect(update).toHaveFocus()
    await user.click(update)
    expect(calls).toHaveLength(3)
    expect(tile('聊天消息', later).getByText('250')).toBeInTheDocument()
  })

  it('reminds of the lessons to review, the failed ones and the spend over budget', async () => {
    const goReview = vi.fn()
    fakeServer({
      'GET api/stats/daily?days=7': ok(
        dailyStats(7, {
          month: { costYuan: 312.4, budgetYuan: 300, overBudget: true },
          reminders: {
            unreviewed: [
              { date: '2026-11-05', division: 'primary', deadline: '2026-11-05T01:45:00.000Z' },
              { date: '2026-11-05', division: 'junior', deadline: '2026-11-05T01:45:00.000Z' },
              { date: '2026-11-06', division: 'senior', deadline: '2026-11-06T01:45:00.000Z' },
            ],
            generationFailed: [
              { date: '2026-11-06', division: 'senior', attempts: 3, lastError: '大模型暂时不可用（超时、网络出错或服务繁忙）' },
            ],
          },
        }),
      ),
    })
    const user = userEvent.setup()
    show(<Data onGoReview={goReview} />)

    const reminders = within(await screen.findByRole('region', { name: '要处理的事' }))
    expect(reminders.getByText('3 节课要在开门前审完，不然那一天改上自习：')).toBeInTheDocument()
    expect(reminders.getByText('11 月 5 日（周四）09:45 开门：小学部、初中部')).toBeInTheDocument()
    expect(reminders.getByText('11 月 6 日（周五）09:45 开门：高中部')).toBeInTheDocument()
    expect(
      reminders.getByText(
        '11 月 6 日（周五）高中部的课没生成出来，试了 3 次，最后一次的原因：大模型暂时不可用（超时、网络出错或服务繁忙）。系统会接着重试；等不及的话，到审课页手动粘贴。',
      ),
    ).toBeInTheDocument()
    expect(
      reminders.getByText(
        '本月大模型花费 ¥312.40，超过了预算 ¥300.00。大模型照常在用，不会自动停；要少花钱，到开关页关掉暂时不用的功能。',
      ),
    ).toBeInTheDocument()

    await user.click(reminders.getByRole('button', { name: '去审课' }))
    expect(goReview).toHaveBeenCalledTimes(1)
  })

  it('says a failed lesson of today will not be made again, only pasted in', async () => {
    fakeServer({
      'GET api/stats/daily?days=7': ok(
        dailyStats(7, {
          reminders: {
            unreviewed: [],
            generationFailed: [{ date: '2026-11-04', division: 'junior', attempts: 5, lastError: '大模型的回复里没有找到 JSON' }],
          },
        }),
      ),
    })
    show(<Data onGoReview={vi.fn()} />)

    const reminders = within(await screen.findByRole('region', { name: '要处理的事' }))
    expect(
      reminders.getByText(
        '11 月 4 日（周三）初中部的课没生成出来，试了 5 次，最后一次的原因：大模型的回复里没有找到 JSON。' +
          '今天的课系统不会再生成了：要今天上这节课，到审课页手动粘贴，赶在开门前审过。',
      ),
    ).toBeInTheDocument()
  })

  it('draws the lines the second layer stopped, and says when the model cost nothing', async () => {
    fakeServer({
      'GET api/stats/daily?days=7': ok(
        dailyStats(7, {
          series: dailyStats(7).series.map((day, i) => ({ ...day, chat: 3, blockedBySecondLayer: i === 6 ? 2 : 0 })),
        }),
      ),
    })
    show(<Data onGoReview={vi.fn()} />)

    // Only the second layer stopped anything: the chart is drawn, not said to be empty.
    const blocked = within(await screen.findByRole('figure', { name: '每天拦下了多少条消息，各是因为什么？' }))
    expect(blocked.queryByText('最近 7 天没有拦下消息。')).not.toBeInTheDocument()
    expect(blocked.getAllByText('第二层').length).toBeGreaterThan(0)
    const cost = within(screen.getByRole('figure', { name: '每天在大模型上花了多少钱，花在哪些用途上？' }))
    expect(cost.getByText('最近 7 天大模型没有花钱。')).toBeInTheDocument()
  })

  it('says when there is nothing to do', async () => {
    fakeServer({ 'GET api/stats/daily?days=7': ok(dailyStats(7)) })
    show(<Data onGoReview={vi.fn()} />)

    const reminders = within(await screen.findByRole('region', { name: '要处理的事' }))
    expect(
      reminders.getByText('现在没有要处理的事：开门前要审的课都审完了，没有一直生成不出来的课，本月花费也没超预算。'),
    ).toBeInTheDocument()
    expect(reminders.queryByRole('button')).not.toBeInTheDocument()
  })

  it('asks for 30 days when 30 天 is picked', async () => {
    const server = fakeServer({
      'GET api/stats/daily?days=7': ok(busyWeek()),
      'GET api/stats/daily?days=30': ok(
        dailyStats(30, { series: dailyStats(30).series.map((day) => ({ ...day, chat: 5 })) }),
      ),
    })
    const user = userEvent.setup()
    show(<Data onGoReview={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: '最近 7 天' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '30 天' })).not.toBeChecked()
    await user.click(screen.getByText('30 天'))

    expect(await screen.findByRole('heading', { name: '最近 30 天' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '30 天' })).toBeChecked()
    expect(server.calls.map((call) => call.path)).toEqual(['api/stats/daily?days=7', 'api/stats/daily?days=30'])
  })

  it('draws the four curves, each titled with the question it answers', async () => {
    fakeServer({ 'GET api/stats/daily?days=7': ok(busyWeek()) })
    show(<Data onGoReview={vi.fn()} />)

    const titles = (await screen.findAllByRole('figure')).map(
      (figure) => within(figure).getByRole('heading', { level: 3 }).textContent,
    )
    expect(titles).toEqual([
      '每天有多少学生来上课？',
      '每天有多少条聊天消息？',
      '每天拦下了多少条消息，各是因为什么？',
      '每天在大模型上花了多少钱，花在哪些用途上？',
    ])

    const students = within(screen.getByRole('figure', { name: '每天有多少学生来上课？' }))
    const legend = within(students.getByRole('list', { name: '图例' }))
    expect(legend.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '上午班',
      '下午班',
      '晚班',
      '竖线：切换过开关的日子',
    ])
    // The names again at the ends of the lines.
    expect(students.getAllByText('晚班')).toHaveLength(2)

    const chat = within(screen.getByRole('figure', { name: '每天有多少条聊天消息？' }))
    expect(chat.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['竖线：切换过开关的日子'])

    const blocked = within(screen.getByRole('figure', { name: '每天拦下了多少条消息，各是因为什么？' }))
    // The second layer gives no category: its own line, so the lines add up to the day's number.
    expect(blocked.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '违规内容',
      '隐私',
      '骗 AI',
      '第二层',
      '竖线：切换过开关的日子',
    ])

    const cost = within(screen.getByRole('figure', { name: '每天在大模型上花了多少钱，花在哪些用途上？' }))
    expect(cost.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '备课',
      '答疑',
      '点评',
      '每周复盘',
      '复查老师',
      '审查同学',
      '整理词库',
      '竖线：切换过开关的日子',
    ])
  })

  it('shows one day’s numbers on the keyboard, the switch changes of that day included', async () => {
    fakeServer({ 'GET api/stats/daily?days=7': ok(busyWeek()) })
    const user = userEvent.setup()
    show(<Data onGoReview={vi.fn()} />)

    const students = within(await screen.findByRole('figure', { name: '每天有多少学生来上课？' }))
    students.getByRole('group', { name: /用左右方向键/ }).focus()
    await user.keyboard('{ArrowLeft}')

    const readout = students.getByRole('status')
    expect(readout).toHaveTextContent('11 月 2 日（周一）')
    expect(readout).toHaveTextContent('15上午班')
    expect(readout).toHaveTextContent('25下午班')
    expect(readout).toHaveTextContent('35晚班')
    expect(readout).toHaveTextContent('14:00 老师用大模型：关')
  })

  it('shows every day’s numbers as a table', async () => {
    fakeServer({ 'GET api/stats/daily?days=7': ok(busyWeek()) })
    const user = userEvent.setup()
    show(<Data onGoReview={vi.fn()} />)

    const cost = within(await screen.findByRole('figure', { name: '每天在大模型上花了多少钱，花在哪些用途上？' }))
    await user.click(cost.getByRole('button', { name: '用表格看' }))

    const rows = cost.getAllByRole('row').map((row) => [...row.children].map((cell) => cell.textContent))
    expect(rows[0]).toEqual(['日期', '备课', '答疑', '点评', '每周复盘', '复查老师', '审查同学', '整理词库', '切换开关'])
    // Newest first: yesterday, then the day of the switch change.
    expect(rows[1]).toEqual(['11/3 周二', '¥1.50', '¥1.50', '¥0.10', '¥0.00', '¥0.0123', '¥0.00', '¥0.00', ''])
    expect(rows[2]?.[8]).toBe('14:00 老师用大模型：关')
    expect(cost.getByRole('button', { name: '用折线图看' })).toBeInTheDocument()
  })

  it('reads the doors times and the switch days on the school’s clock, the zone the answer names', async () => {
    fakeServer({
      'GET api/stats/daily?days=7': ok({
        ...busyWeek(),
        timeZone: 'Asia/Tokyo',
        // 23:30 on 11-01 in UTC+8 is 00:30 on 11-02 in Tokyo.
        switchChanges: [{ name: 'teacherLlm', on: false, at: '2026-11-01T15:30:00.000Z' }],
        reminders: {
          unreviewed: [{ date: '2026-11-05', division: 'primary', deadline: '2026-11-05T01:45:00.000Z' }],
          generationFailed: [],
        },
      }),
    })
    const user = userEvent.setup()
    show(<Data onGoReview={vi.fn()} />)

    const reminders = within(await screen.findByRole('region', { name: '要处理的事' }))
    expect(reminders.getByText('11 月 5 日（周四）10:45 开门：小学部')).toBeInTheDocument()
    const students = within(screen.getByRole('figure', { name: '每天有多少学生来上课？' }))
    students.getByRole('group', { name: /用左右方向键/ }).focus()
    await user.keyboard('{ArrowLeft}')
    expect(students.getByRole('status')).toHaveTextContent('11 月 2 日（周一）')
    expect(students.getByRole('status')).toHaveTextContent('00:30 老师用大模型：关')
  })

  it('keeps the day the keyboard picked when the pointer leaves the chart', async () => {
    fakeServer({ 'GET api/stats/daily?days=7': ok(busyWeek()) })
    const user = userEvent.setup()
    show(<Data onGoReview={vi.fn()} />)

    const students = within(await screen.findByRole('figure', { name: '每天有多少学生来上课？' }))
    const plot = students.getByRole('group', { name: /用左右方向键/ })
    plot.focus()
    await user.keyboard('{ArrowLeft}')
    const area = plot.querySelector('rect') as SVGRectElement
    fireEvent.pointerMove(area, { clientX: 100 })
    fireEvent.pointerLeave(area)

    expect(students.getByRole('status')).toHaveTextContent('11 月 2 日（周一）')
  })

  it('keeps the readout in the page while it shows nothing, so the day read out later is announced', async () => {
    fakeServer({ 'GET api/stats/daily?days=7': ok(busyWeek()) })
    show(<Data onGoReview={vi.fn()} />)

    const students = within(await screen.findByRole('figure', { name: '每天有多少学生来上课？' }))
    const readout = students.getByRole('status')
    expect(readout).toBeEmptyDOMElement()
    // Hidden from sight only, never with display: none, which would take the live region out of the page.
    expect(readout).toHaveClass('visually-hidden')
  })

  it('says it is reading another range, while the curves before stay', async () => {
    fakeServer({ 'GET api/stats/daily?days=7': ok(busyWeek()), 'GET api/stats/daily?days=30': { pending: true } })
    const user = userEvent.setup()
    show(<Data onGoReview={vi.fn()} />)

    await screen.findByRole('heading', { name: '最近 7 天' })
    await user.click(screen.getByText('30 天'))

    expect(await screen.findByText('正在读取最近 30 天的数据，下面先留着最近 7 天的。')).toBeInTheDocument()
    expect(screen.getAllByRole('figure')).toHaveLength(4)
  })
})
