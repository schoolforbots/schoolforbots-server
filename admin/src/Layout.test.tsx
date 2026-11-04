import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Layout } from './Layout.js'
import { dailyStats, dayNumbers, fakeServer, lessonQueue, ok, queueSlot, show, YESTERDAY } from './test-api.js'

function serve(queue = lessonQueue(), stats = dailyStats(7)) {
  return fakeServer({ 'GET api/stats/daily?days=7': ok(stats), 'GET api/lessons/queue': ok(queue) })
}

describe('the layout', () => {
  it('has the title, the logout and five tabs, the school data first', async () => {
    serve()
    show(<Layout onLoggedOut={vi.fn()} />)

    expect(screen.getByRole('heading', { level: 1, name: '机器人网校 · 后台' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '退出登录' })).toBeInTheDocument()
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent)
    expect(tabs).toEqual(['学校数据', '审课', '每周复盘', '查学生', '开关'])
    expect(screen.getByRole('tab', { name: '学校数据' })).toHaveAttribute('aria-selected', 'true')
  })

  it('counts the lessons still to review on the review tab', async () => {
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

    expect(await screen.findByRole('tab', { name: '审课 · 待审 3' })).toBeInTheDocument()
  })

  it('shows an honest placeholder on the pages still being built', async () => {
    serve()
    const user = userEvent.setup()
    show(<Layout onLoggedOut={vi.fn()} />)

    for (const name of ['审课', '每周复盘', '查学生', '开关']) {
      await user.click(screen.getByRole('tab', { name }))
      expect(within(screen.getByRole('tabpanel', { name })).getByText('这一页还在做。')).toBeInTheDocument()
    }
  })

  it('goes to the review tab from the reminder', async () => {
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

    expect(screen.getByRole('tab', { name: '审课' })).toHaveAttribute('aria-selected', 'true')
    expect(window.location.hash).toBe('#review')
  })

  it('opens the tab named in the address', async () => {
    serve()
    window.history.replaceState(null, '', '/#switches')
    show(<Layout onLoggedOut={vi.fn()} />)

    expect(screen.getByRole('tab', { name: '开关' })).toHaveAttribute('aria-selected', 'true')
  })
})
