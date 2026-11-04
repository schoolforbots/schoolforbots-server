import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { fail, fakeServer, ok, SESSION, show, textContrast } from '../test-api.js'
import { Login } from './Login.js'

describe('the login page', () => {
  it('logs in with Enter, sending the password and the code', async () => {
    const server = fakeServer({ 'POST api/login': ok(SESSION) })
    const loggedIn = vi.fn()
    const user = userEvent.setup()
    show(<Login onLoggedIn={loggedIn} />)

    await user.type(screen.getByLabelText('密码'), 'a long password')
    await user.type(screen.getByLabelText('动态验证码'), '123456{Enter}')

    await vi.waitFor(() => expect(loggedIn).toHaveBeenCalledTimes(1))
    expect(loggedIn).toHaveBeenCalledWith('Asia/Shanghai')
    expect(server.calls.map((call) => call.body)).toEqual([{ password: 'a long password', code: '123456' }])
  })

  it('says it is logging in, in words, while the login is sent', async () => {
    fakeServer({ 'POST api/login': { pending: true } })
    const user = userEvent.setup()
    show(<Login onLoggedIn={vi.fn()} />)

    await user.type(screen.getByLabelText('密码'), 'a long password')
    await user.type(screen.getByLabelText('动态验证码'), '123456{Enter}')

    const sending = await screen.findByRole('button', { name: '正在登录' })
    expect(sending).toBeDisabled()
    // The words are the only sign of progress: they are readable on the disabled button's grey fill.
    expect(textContrast(sending)).toBeGreaterThanOrEqual(4.5)
    // No spinner: the words say it.
    expect(sending.querySelector('.ant-btn-loading-icon')).toBeNull()
  })

  it('shows why a login was refused, and empties the code for the next one', async () => {
    fakeServer({ 'POST api/login': fail(401, 'admin_login_failed', '密码或验证码不对。') })
    const loggedIn = vi.fn()
    const user = userEvent.setup()
    show(<Login onLoggedIn={loggedIn} />)

    await user.type(screen.getByLabelText('密码'), 'a wrong password')
    await user.type(screen.getByLabelText('动态验证码'), '654321')
    await user.click(screen.getByRole('button', { name: '登录' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('密码或验证码不对。')
    // Only a login that succeeds uses a code up: the hint says so, and no more.
    expect(alert).toHaveTextContent('每组验证码只能成功登录一次。刚用它登录过的话，等验证器换到下一组再试。')
    expect(screen.getByLabelText('动态验证码')).toHaveValue('')
    expect(screen.getByLabelText('密码')).toHaveValue('a wrong password')
    expect(loggedIn).not.toHaveBeenCalled()
  })

  it('shows the server’s reason when the login is locked', async () => {
    fakeServer({ 'POST api/login': fail(429, 'admin_locked', '失败次数太多，登录已暂时锁定，请稍后再试。') })
    const user = userEvent.setup()
    show(<Login onLoggedIn={vi.fn()} />)

    await user.type(screen.getByLabelText('密码'), 'a long password')
    await user.type(screen.getByLabelText('动态验证码'), '123456{Enter}')

    expect(await screen.findByRole('alert')).toHaveTextContent('失败次数太多，登录已暂时锁定，请稍后再试。')
  })

  it('asks for both fields before sending anything', async () => {
    const server = fakeServer({})
    const user = userEvent.setup()
    show(<Login onLoggedIn={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '登录' }))

    expect(await screen.findByText('请输入密码')).toBeInTheDocument()
    expect(await screen.findByText('请输入验证器上的 6 位数字')).toBeInTheDocument()
    expect(server.calls).toEqual([])
  })

  it('says why it is back, when a session ended', () => {
    show(<Login onLoggedIn={vi.fn()} notice="登录已经过期，重新登录后回到刚才那一页。" />)

    expect(screen.getByText('登录已经过期，重新登录后回到刚才那一页。')).toBeInTheDocument()
  })
})
