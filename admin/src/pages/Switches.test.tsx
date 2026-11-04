import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { fail, fakeServer, ok, show, switches, textContrast } from '../test-api.js'
import { Switches } from './Switches.js'

const READ = 'GET api/switches'

function row(name: string) {
  return within(screen.getByRole('region', { name }))
}

/** Esc as a browser sends it: the dialogs read `keyCode`, which user-event leaves at 0. */
function pressEscape() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', code: 'Escape', keyCode: 27 })
}

describe('the switches page', () => {
  it('says what it is reading while it waits', () => {
    fakeServer({ [READ]: { pending: true } })
    show(<Switches />)

    expect(screen.getByRole('status')).toHaveTextContent('正在读取开关')
  })

  it('says what failed, and reads again', async () => {
    let up = false
    fakeServer({ [READ]: () => (up ? ok(switches()) : fail(503, 'unavailable', '服务器正忙。')) })
    const user = userEvent.setup()
    show(<Switches />)

    expect(await screen.findByRole('alert')).toHaveTextContent('没能读取开关。服务器正忙。')
    up = true
    await user.click(screen.getByRole('button', { name: '重新读取' }))
    expect(await screen.findByRole('region', { name: '老师用大模型' })).toBeInTheDocument()
  })

  it('says so when the server lists no switch', async () => {
    fakeServer({ [READ]: ok({ switches: [] }) })
    show(<Switches />)

    expect(await screen.findByText('服务器这次没有列出开关，重新读取看看。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新读取' })).toBeInTheDocument()
  })

  it('has a row for each switch: what on and off do, where it stands, and when it last changed', async () => {
    fakeServer({ [READ]: ok(switches({ secondLayerChat: { on: true, updatedAt: '2026-11-03T12:05:00.000Z' } })) })
    show(<Switches />)

    await screen.findByRole('region', { name: '老师用大模型' })
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      '老师用大模型',
      '第二层·复查老师',
      '第二层·审查同学',
    ])

    const teacher = row('老师用大模型')
    expect(teacher.getByText('现在开着')).toBeInTheDocument()
    expect(teacher.getByText(/^开着：.*答疑.*点评/)).toBeInTheDocument()
    expect(teacher.getByText(/^关着：.*模板话/)).toBeInTheDocument()
    expect(teacher.getByText('还没切换过，用的是配置里的默认值。')).toBeInTheDocument()
    expect(teacher.getByRole('button', { name: '关掉' })).toBeInTheDocument()

    const review = row('第二层·复查老师')
    expect(review.getByText(/^开着：老师.*点名.*第三方 AI 服务/)).toBeInTheDocument()
    expect(review.getByText(/^关着：只用词库/)).toBeInTheDocument()

    const chat = row('第二层·审查同学')
    expect(chat.getByText('现在开着')).toBeInTheDocument()
    expect(chat.getByText(/^开着：同学之间的消息.*晚一两秒/)).toBeInTheDocument()
    // Off, chat is still delivered: only the second check stops.
    expect(chat.getByText('关着：同学之间的消息只用词库审，不再送去第三方 AI 服务。')).toBeInTheDocument()
    expect(chat.getByText('最近一次切换：2026 年 11 月 3 日 20:05')).toBeInTheDocument()
  })

  it('asks before it switches, then shows the new state and when it changed', async () => {
    const server = fakeServer({
      [READ]: ok(switches()),
      'PUT api/switches/teacherLlm': ok({ name: 'teacherLlm', on: false, updatedAt: '2026-11-04T01:30:00.000Z' }),
    })
    const user = userEvent.setup()
    show(<Switches />)

    await screen.findByRole('region', { name: '老师用大模型' })
    const off = row('老师用大模型').getByRole('button', { name: '关掉' })
    await user.click(off)
    let dialog = within(await screen.findByRole('dialog', { name: '关掉“老师用大模型”？' }))
    // Backing out is where the focus starts.
    expect(dialog.getByRole('button', { name: '先不关' })).toHaveFocus()
    expect(dialog.getByText(/模板话/)).toBeInTheDocument()
    expect(dialog.getByText(/几秒内生效，正在上的课不用断。/)).toBeInTheDocument()
    pressEscape()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(off).toHaveFocus()

    await user.click(off)
    dialog = within(await screen.findByRole('dialog', { name: '关掉“老师用大模型”？' }))
    await user.click(dialog.getByRole('button', { name: '先不关' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(server.calls.filter((call) => call.method === 'PUT')).toHaveLength(0)

    await user.click(off)
    dialog = within(await screen.findByRole('dialog', { name: '关掉“老师用大模型”？' }))
    await user.click(dialog.getByRole('button', { name: '关掉' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(server.calls.filter((call) => call.method === 'PUT').map((call) => call.body)).toEqual([{ on: false }])
    const teacher = row('老师用大模型')
    expect(teacher.getByText('现在关着')).toBeInTheDocument()
    expect(teacher.getByText('最近一次切换：2026 年 11 月 4 日 09:30')).toBeInTheDocument()
    const done = teacher.getByText('已关掉。上课服务几秒内读到。')
    await waitFor(() => expect(done).toHaveFocus())
    expect(teacher.getByRole('button', { name: '打开' })).toBeInTheDocument()
  })

  it('says it is switching, in words that can be read, while the change is sent', async () => {
    fakeServer({ [READ]: ok(switches()), 'PUT api/switches/teacherLlm': { pending: true } })
    const user = userEvent.setup()
    show(<Switches />)

    await screen.findByRole('region', { name: '老师用大模型' })
    await user.click(row('老师用大模型').getByRole('button', { name: '关掉' }))
    const dialog = within(await screen.findByRole('dialog', { name: '关掉“老师用大模型”？' }))
    await user.click(dialog.getByRole('button', { name: '关掉' }))

    const busy = dialog.getByRole('button', { name: '正在关掉' })
    expect(busy).toBeDisabled()
    // The dialog is white; on it the disabled button's grey fill and its words.
    expect(textContrast(busy)).toBeGreaterThanOrEqual(4.5)
    // Over the page colour too, where the boxes of the review page sit.
    expect(textContrast(busy, '#f7f6f2')).toBeGreaterThanOrEqual(4.5)
  })

  it('shows the server’s reason when it will not switch', async () => {
    fakeServer({
      [READ]: ok(switches()),
      'PUT api/switches/secondLayerChat': fail(503, 'unavailable', '服务器正忙。'),
    })
    const user = userEvent.setup()
    show(<Switches />)

    await screen.findByRole('region', { name: '第二层·审查同学' })
    await user.click(row('第二层·审查同学').getByRole('button', { name: '打开' }))
    const dialog = within(await screen.findByRole('dialog', { name: '打开“第二层·审查同学”？' }))
    await user.click(dialog.getByRole('button', { name: '打开' }))

    expect(await dialog.findByRole('alert')).toHaveTextContent('服务器正忙。')
    expect(row('第二层·审查同学').getByText('现在关着')).toBeInTheDocument()
  })
})
