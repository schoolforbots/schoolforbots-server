import { Button, Form, Input, type InputRef } from 'antd'
import { useRef, useState } from 'react'
import { login, type ApiError } from '../api.js'
import { TopBar } from '../Layout.js'

interface Fields {
  password: string
  code: string
}

/** The password and the one-time code from the authenticator app. `notice` says why the page is back, if it is. */
export function Login({ onLoggedIn, notice }: { onLoggedIn: () => void; notice?: string }) {
  const [form] = Form.useForm<Fields>()
  const codeField = useRef<InputRef>(null)
  const [sending, setSending] = useState(false)
  const [refusal, setRefusal] = useState<ApiError>()

  async function send({ password, code }: Fields) {
    setSending(true)
    setRefusal(undefined)
    try {
      await login(password, code.trim())
    } catch (error) {
      setRefusal(error as ApiError)
      setSending(false)
      // A code is good for one login only, right or wrong: the next try needs the next one.
      form.setFieldValue('code', '')
      codeField.current?.focus()
      return
    }
    onLoggedIn()
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
                  <p>每组验证码只能用一次。用错或用过的，等验证器换到下一组再登录。</p>
                )}
              </div>
            )}
            <Button type="primary" htmlType="submit" loading={sending} block>
              登录
            </Button>
          </Form>
        </section>
      </main>
    </>
  )
}
