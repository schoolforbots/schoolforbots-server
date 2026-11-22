import { useId, useRef, useState, type FormEvent } from 'react'
import { login, type ApiError } from '../api.js'
import { Brand } from '../Layout.js'
import { Button, Input } from '../ui.js'

/**
 * The password and the one-time code from the authenticator app. `notice` says why the page is back, if it is.
 * `onLoggedIn` is given the school's time zone, which comes with the session.
 */
export function Login({ onLoggedIn, notice }: { onLoggedIn: (timeZone: string) => void; notice?: string }) {
  const ids = { password: useId(), passwordProblem: useId(), code: useId(), codeHint: useId(), codeProblem: useId() }
  const codeField = useRef<HTMLInputElement>(null)
  const passwordField = useRef<HTMLInputElement>(null)
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  // Which empty fields were sent: each says so under itself, in words (the red stays with the review marks).
  const [missing, setMissing] = useState({ password: false, code: false })
  const [sending, setSending] = useState(false)
  const [refusal, setRefusal] = useState<ApiError>()

  async function send(event: FormEvent) {
    event.preventDefault()
    if (sending) return
    const empty = { password: password === '', code: code.trim() === '' }
    setMissing(empty)
    if (empty.password || empty.code) {
      ;(empty.password ? passwordField : codeField).current?.focus()
      return
    }
    setSending(true)
    setRefusal(undefined)
    let session
    try {
      session = await login(password, code.trim())
    } catch (error) {
      setRefusal(error as ApiError)
      setSending(false)
      // Only a login that succeeds uses a code up. But the code may be what was wrong, and the one shown changes
      // every 30 seconds anyway: the field is emptied for the one showing now.
      setCode('')
      codeField.current?.focus()
      return
    }
    onLoggedIn(session.timeZone)
  }

  return (
    <div className="flex min-h-screen flex-col items-center px-6 pt-24">
      <Brand />
      <main className="mt-8 w-full max-w-sm">
        <section
          className="rounded-lg border border-gray-200 bg-white p-8 shadow-xs"
          aria-labelledby="login-title"
        >
          <h1 id="login-title" className="text-xl font-semibold text-gray-900">
            登录
          </h1>
          <p className="mt-1 text-sm text-gray-600">用后台密码和验证器 App 上的数字登录。</p>
          {notice !== undefined && (
            <p className="mt-4 rounded-md bg-gray-100 px-3 py-2 text-sm text-gray-900">{notice}</p>
          )}
          <form className="mt-6 flex flex-col gap-4" onSubmit={send} noValidate>
            <div>
              <label htmlFor={ids.password} className="block text-sm font-medium text-gray-700">
                密码
              </label>
              <Input
                id={ids.password}
                ref={passwordField}
                type="password"
                className="mt-1 aria-invalid:border-red-400"
                autoComplete="current-password"
                autoFocus
                value={password}
                aria-describedby={missing.password ? ids.passwordProblem : undefined}
                aria-invalid={missing.password || undefined}
                onChange={(event) => {
                  setPassword(event.target.value)
                  setMissing((now) => ({ ...now, password: false }))
                }}
              />
              {missing.password && (
                <p id={ids.passwordProblem} className="mt-1.5 text-xs text-red-700">
                  请输入密码
                </p>
              )}
            </div>
            <div>
              <label htmlFor={ids.code} className="block text-sm font-medium text-gray-700">
                动态验证码
              </label>
              <Input
                id={ids.code}
                ref={codeField}
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                aria-describedby={missing.code ? `${ids.codeProblem} ${ids.codeHint}` : ids.codeHint}
                aria-invalid={missing.code || undefined}
                className="mt-1 tabular-nums tracking-widest aria-invalid:border-red-400"
                onChange={(event) => {
                  setCode(event.target.value)
                  setMissing((now) => ({ ...now, code: false }))
                }}
              />
              {missing.code && (
                <p id={ids.codeProblem} className="mt-1.5 text-xs text-red-700">
                  请输入验证器上的 6 位数字
                </p>
              )}
              <p id={ids.codeHint} className="mt-1.5 text-xs text-gray-600">
                验证器 App 里现在显示的 6 位数字
              </p>
            </div>
            {refusal !== undefined && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                <p>{refusal.message}</p>
                {refusal.code === 'admin_login_failed' && (
                  <p className="mt-1 text-red-700">每组验证码只能成功登录一次。刚用它登录过的话，等验证器换到下一组再试。</p>
                )}
              </div>
            )}
            {/* No spinner: the label says what is going on. */}
            <Button type="primary" htmlType="submit" disabled={sending} block>
              {sending ? '正在登录' : '登录'}
            </Button>
          </form>
        </section>
      </main>
    </div>
  )
}
