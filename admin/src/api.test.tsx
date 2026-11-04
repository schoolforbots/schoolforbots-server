import { describe, expect, it, vi } from 'vitest'
import { getSession, login, logout, onSessionEnded, request } from './api.js'
import { fail, fakeServer, ok } from './test-api.js'

describe('the api client', () => {
  it('sends the admin header and the cookie with every request, to paths under the page', async () => {
    const server = fakeServer({
      'GET api/session': ok({ expiresAt: '2026-11-04T12:00:00.000Z' }),
      'POST api/logout': ok({ ok: true }),
    })

    await getSession()
    await logout()

    expect(server.calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET api/session', 'POST api/logout'])
    for (const call of server.calls) {
      expect(call.headers['x-requested-with']).toBe('admin')
      expect(call.credentials).toBe('same-origin')
    }
  })

  it('sends a body as JSON', async () => {
    const server = fakeServer({ 'POST api/login': ok({ expiresAt: '2026-11-04T12:00:00.000Z' }) })

    await login('a long password', '123456')

    expect(server.calls[0]?.headers['content-type']).toBe('application/json')
    expect(server.calls[0]?.body).toEqual({ password: 'a long password', code: '123456' })
  })

  it.each([409, 422, 503])('hands the server’s reason for a %i to the caller', async (status) => {
    fakeServer({ 'PUT api/lessons/7/parts': fail(status, 'stale_version', '这节课在别处改过了，刷新后再改。') })

    await expect(request('PUT', 'api/lessons/7/parts', { baseVersion: 1 })).rejects.toMatchObject({
      status,
      code: 'stale_version',
      message: '这节课在别处改过了，刷新后再改。',
    })
  })

  it('says in Chinese when the server cannot be reached', async () => {
    fakeServer({ 'GET api/session': { networkError: true } })

    await expect(getSession()).rejects.toMatchObject({ status: 0, message: '连不上服务器，检查网络后再试。' })
  })

  it('says so when the answer is not one of the server’s own', async () => {
    fakeServer({ 'GET api/session': { status: 502, raw: '<html>Bad Gateway</html>' } })

    await expect(getSession()).rejects.toMatchObject({
      status: 502,
      message: '服务器没有正常回应（502），稍后再试。',
    })
  })

  it('tells the app when the session has ended, but not when a login is refused', async () => {
    fakeServer({
      'GET api/stats/daily?days=7': fail(401, 'admin_login_required', '请先登录。'),
      'POST api/login': fail(401, 'admin_login_failed', '密码或验证码不对。'),
    })
    const ended = vi.fn()
    const stop = onSessionEnded(ended)

    await expect(login('a long password', '123456')).rejects.toMatchObject({ message: '密码或验证码不对。' })
    expect(ended).not.toHaveBeenCalled()

    await expect(request('GET', 'api/stats/daily?days=7')).rejects.toMatchObject({ status: 401 })
    expect(ended).toHaveBeenCalledTimes(1)

    stop()
    await expect(request('GET', 'api/stats/daily?days=7')).rejects.toMatchObject({ status: 401 })
    expect(ended).toHaveBeenCalledTimes(1)
  })
})
