import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { App } from './App.js'
import { dailyStats, fail, fakeServer, lessonQueue, ok, show } from './test-api.js'

const loginRequired = fail(401, 'admin_login_required', '请先登录。')

describe('the admin app', () => {
  it('shows the login page without a session, then the school data once logged in', async () => {
    let loggedIn = false
    fakeServer({
      'GET api/session': () => (loggedIn ? ok({ expiresAt: '2026-11-04T12:00:00.000Z' }) : loginRequired),
      'POST api/login': () => {
        loggedIn = true
        return ok({ expiresAt: '2026-11-04T12:00:00.000Z' })
      },
      'GET api/stats/daily?days=7': () => (loggedIn ? ok(dailyStats(7)) : loginRequired),
      'GET api/lessons/queue': () => (loggedIn ? ok(lessonQueue()) : loginRequired),
    })
    const user = userEvent.setup()
    show(<App />)

    expect(await screen.findByRole('heading', { name: '登录' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('密码'), 'a long password')
    await user.type(screen.getByLabelText('动态验证码'), '123456{Enter}')

    expect(await screen.findByRole('tab', { name: '学校数据', selected: true })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: /^昨天/ })).toBeInTheDocument()
  })

  it('goes back to the login page when a request finds the session gone', async () => {
    fakeServer({
      'GET api/session': ok({ expiresAt: '2026-11-04T12:00:00.000Z' }),
      'GET api/stats/daily?days=7': loginRequired,
      'GET api/lessons/queue': ok(lessonQueue()),
    })
    show(<App />)

    expect(await screen.findByRole('heading', { name: '登录' })).toBeInTheDocument()
    expect(screen.getByText('登录已经过期，重新登录后回到刚才那一页。')).toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })

  it('logs out', async () => {
    const server = fakeServer({
      'GET api/session': ok({ expiresAt: '2026-11-04T12:00:00.000Z' }),
      'GET api/stats/daily?days=7': ok(dailyStats(7)),
      'GET api/lessons/queue': ok(lessonQueue()),
      'POST api/logout': ok({ ok: true }),
    })
    const user = userEvent.setup()
    show(<App />)

    await user.click(await screen.findByRole('button', { name: '退出登录' }))

    expect(await screen.findByRole('heading', { name: '登录' })).toBeInTheDocument()
    expect(server.calls.some((call) => call.method === 'POST' && call.path === 'api/logout')).toBe(true)
    expect(screen.queryByText(/登录已经过期/)).not.toBeInTheDocument()
  })

  it('says what failed when it cannot check the session, and tries again', async () => {
    let reachable = false
    fakeServer({
      'GET api/session': () => (reachable ? loginRequired : { networkError: true }),
    })
    const user = userEvent.setup()
    show(<App />)

    expect(await screen.findByText('没能读取登录状态。连不上服务器，检查网络后再试。')).toBeInTheDocument()
    reachable = true
    await user.click(screen.getByRole('button', { name: '重新读取' }))

    expect(await screen.findByRole('heading', { name: '登录' })).toBeInTheDocument()
  })
})
