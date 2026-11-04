import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { dailyStats, dayNumbers, fail, fakeServer, ok, seriesDay, shiftDate, show, YESTERDAY } from '../test-api.js'
import { Data } from './Data.js'

const LAST_WEEK = shiftDate(YESTERDAY, -7)

function tile(name: string) {
  return within(screen.getByRole('group', { name }))
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

    expect(await screen.findByRole('group', { name: '来上课的学生' })).toHaveTextContent('42')
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

    expect(await screen.findByRole('heading', { name: '昨天，11 月 3 日（周二）' })).toBeInTheDocument()
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
    expect(tile('大模型花费').getByText('本月 ¥45.67，预算 ¥300.00')).toBeInTheDocument()
  })

  it('says when the same day last week came before the school opened', async () => {
    fakeServer({ 'GET api/stats/daily?days=7': ok(dailyStats(7, { sameDayLastWeek: null })) })
    show(<Data onGoReview={vi.fn()} />)

    expect(await screen.findAllByText('上周二学校还没开学')).toHaveLength(8)
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
    expect(blocked.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '违规内容',
      '隐私',
      '骗 AI',
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
