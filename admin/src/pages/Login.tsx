import { Button, Form, Input, type InputRef } from 'antd'
import { useRef, useState } from 'react'
import { login, type ApiError } from '../api.js'
import { TopBar } from '../Layout.js'

interface Fields {
  password: string
  code: string
}

/**
 * The password and the one-time code from the authenticator app. `notice` says why the page is back, if it is.
 * `onLoggedIn` is given the school's time zone, which comes with the session.
 */
export function Login({ onLoggedIn, notice }: { onLoggedIn: (timeZone: string) => void; notice?: string }) {
  const [form] = Form.useForm<Fields>()
  const codeField = useRef<InputRef>(null)
  const [sending, setSending] = useState(false)
  const [refusal, setRefusal] = useState<ApiError>()

  async function send({ password, code }: Fields) {
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
      form.setFieldValue('code', '')
      codeField.current?.focus()
      return
    }
    onLoggedIn(session.timeZone)
  }

  return (
    <>
      <TopBar />
      <main className="login">
        <section className="panel login-panel" aria-labelledby="login-title">
          <h2 id="login-title" className="panel-title">
            登录
          </h2>
          {notice !== undefined && <p className="login-notice">{notice}</p>}
          <Form form={form} name="login" layout="vertical" requiredMark={false} onFinish={send}>
            <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}>
              <Input type="password" autoComplete="current-password" autoFocus />
            </Form.Item>
            <Form.Item
              label="动态验证码"
              name="code"
              extra="验证器 App 里现在显示的 6 位数字"
              rules={[{ required: true, whitespace: true, message: '请输入验证器上的 6 位数字' }]}
            >
              <Input ref={codeField} inputMode="numeric" autoComplete="one-time-code" />
            </Form.Item>
            {refusal !== undefined && (
              <div className="login-refusal" role="alert">
                <p>{refusal.message}</p>
                {refusal.code === 'admin_login_failed' && (
                  <p>每组验证码只能成功登录一次。刚用它登录过的话，等验证器换到下一组再试。</p>
                )}
              </div>
            )}
            {/* No spinner: the label says what is going on. */}
            <Button type="primary" htmlType="submit" disabled={sending} block>
              {sending ? '正在登录' : '登录'}
            </Button>
          </Form>
        </section>
      </main>
    </>
  )
}
