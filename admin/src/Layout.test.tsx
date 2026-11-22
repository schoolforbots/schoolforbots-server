import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Layout } from './Layout.js'
import {
  dailyStats,
  dayNumbers,
  fakeServer,
  lessonQueue,
  ok,
  queueSlot,
  show,
  switches,
  weeklyPage,
  YESTERDAY,
} from './test-api.js'

function serve(queue = lessonQueue(), stats = dailyStats(7)) {
  return fakeServer({ 'GET api/stats/daily?days=7': ok(stats), 'GET api/lessons/queue': ok(queue) })
}

describe('the layout', () => {
  it('has the school’s name, the logout and six pages in the sidebar, the school data first and open', async () => {
    serve()
    show(<Layout onLoggedOut={vi.fn()} />)

    expect(screen.getByText('机器人网校')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '退出登录' })).toBeInTheDocument()
    const nav = within(screen.getByRole('navigation', { name: '后台页面' }))
    expect(nav.getAllByRole('link').map((link) => link.textContent)).toEqual([
      '学校数据',
      '审课',
      '每周复盘',
      '查学生',
      '开关',
      '公告',
    ])
    expect(nav.getByRole('link', { name: '学校数据' })).toHaveAttribute('aria-current', 'page')
    // The open page is named by the one h1, and the page itself is the main region of that name.
    expect(screen.getByRole('heading', { level: 1, name: '学校数据' })).toBeInTheDocument()
    expect(screen.getByRole('main', { name: '学校数据' })).toBeInTheDocument()
  })

  it('says it is logging out while it does', async () => {
    fakeServer({
      'GET api/stats/daily?days=7': ok(dailyStats(7)),
      'GET api/lessons/queue': ok(lessonQueue()),
      'POST api/logout': { pending: true },
    })
    const user = userEvent.setup()
    show(<Layout onLoggedOut={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '退出登录' }))
    expect(screen.getByRole('button', { name: '正在退出' })).toBeDisabled()
  })

  it('counts the lessons still to review beside 审课', async () => {
    serve(
      lessonQueue([
        {
          date: '2026-11-04',
          divisions: [
            queueSlot('primary', { status: 'pending', locked: true }),
            queueSlot('junior', { status: 'approved' }),
            queueSlot('senior', { status: 'flagged', flags: 2 }),
          ],
        },
        {
          date: '2026-11-05',
          divisions: [
            queueSlot('primary', { status: 'missing', lessonId: null, version: null }),
            queueSlot('junior', { status: 'pending' }),
            queueSlot('senior', { status: 'approved' }),
          ],
        },
      ]),
    )
    show(<Layout onLoggedOut={vi.fn()} />)

    expect(await screen.findByRole('link', { name: '审课 · 待审 3' })).toBeInTheDocument()
  })

  it('leaves out of the count a lesson missing on a day the model does not make lessons for yet', async () => {
    serve(
      lessonQueue([
        {
          date: '2026-11-05',
          divisions: [queueSlot('primary', { status: 'missing', lessonId: null, version: null })],
        },
        {
          date: '2026-11-09',
          aheadOfGeneration: true,
          divisions: [
            queueSlot('primary', { status: 'missing', lessonId: null, version: null }),
            queueSlot('junior', { status: 'pending' }),
          ],
        },
      ]),
    )
    show(<Layout onLoggedOut={vi.fn()} />)

    expect(await screen.findByRole('link', { name: '审课 · 待审 2' })).toBeInTheDocument()
  })

  it('says the count of lessons to review was not read, rather than showing none', async () => {
    fakeServer({ 'GET api/stats/daily?days=7': ok(dailyStats(7)), 'GET api/lessons/queue': { networkError: true } })
    show(<Layout onLoggedOut={vi.fn()} />)

    expect(await screen.findByRole('link', { name: '审课 · 待审数没读到' })).toBeInTheDocument()
  })

  it('shows the weekly review, the student lookup, the switches and the notices on their pages', async () => {
    fakeServer({
      'GET api/stats/daily?days=7': ok(dailyStats(7)),
      'GET api/lessons/queue': ok(lessonQueue()),
      'GET api/weekly': ok(weeklyPage()),
      'GET api/weekly/weeks': ok({ weeks: [] }),
      'GET api/switches': ok(switches()),
      'GET api/notices': ok({ notices: [] }),
    })
    const user = userEvent.setup()
    show(<Layout onLoggedOut={vi.fn()} />)

    await user.click(screen.getByRole('link', { name: '每周复盘' }))
    expect(await within(screen.getByRole('main', { name: '每周复盘' })).findByRole('combobox', { name: '看哪一周' }))
      .toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: '查学生' }))
    expect(within(screen.getByRole('main', { name: '查学生' })).getByRole('textbox', { name: '学号' }))
      .toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: '开关' }))
    expect(await within(screen.getByRole('main', { name: '开关' })).findByRole('region', { name: '老师用大模型' }))
      .toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: '公告' }))
    expect(await within(screen.getByRole('main', { name: '公告' })).findByRole('button', { name: '写新公告' }))
      .toBeInTheDocument()
    expect(screen.queryByText('这一页还在做。')).not.toBeInTheDocument()
  })

  it('shows the review page under 审课, from the same list the sidebar counts', async () => {
    const server = serve(
      lessonQueue([
        {
          date: '2026-11-05',
          divisions: [
            queueSlot('primary', { status: 'approved' }),
            queueSlot('junior', { status: 'missing', lessonId: null, version: null }),
            queueSlot('senior', { status: 'approved', lessonId: 3 }),
          ],
        },
      ]),
    )
    window.history.replaceState(null, '', '/#review')
    show(<Layout onLoggedOut={vi.fn()} />)

    const panel = within(await screen.findByRole('main', { name: '审课' }))
    expect(screen.getByRole('link', { name: '审课 · 待审 1' })).toHaveAttribute('aria-current', 'page')
    expect(panel.getByRole('button', { name: '初中部 待生成' })).toBeInTheDocument()
    expect(panel.getByText('这几天要审的课都审完了。')).toBeInTheDocument()
    expect(server.calls.filter((call) => call.path === 'api/lessons/queue')).toHaveLength(1)
  })

  it('goes to 审课 from the reminder', async () => {
    serve(
      lessonQueue(),
      dailyStats(7, {
        yesterday: dayNumbers(YESTERDAY),
        reminders: {
          unreviewed: [{ date: '2026-11-05', division: 'primary', deadline: '2026-11-05T01:45:00.000Z' }],
          generationFailed: [],
        },
      }),
    )
    const user = userEvent.setup()
    show(<Layout onLoggedOut={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: '去审课' }))

    expect(screen.getByRole('link', { name: '审课' })).toHaveAttribute('aria-current', 'page')
    expect(window.location.hash).toBe('#review')
  })

  it('opens the page named in the address', async () => {
    fakeServer({
      'GET api/stats/daily?days=7': ok(dailyStats(7)),
      'GET api/lessons/queue': ok(lessonQueue()),
      'GET api/switches': { pending: true },
    })
    window.history.replaceState(null, '', '/#switches')
    show(<Layout onLoggedOut={vi.fn()} />)

    expect(screen.getByRole('link', { name: '开关' })).toHaveAttribute('aria-current', 'page')
  })
})
