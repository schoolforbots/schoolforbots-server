import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { fail, fakeServer, maintenance, ok, show, switches, textContrast } from '../test-api.js'
import { Switches } from './Switches.js'

const READ = 'GET api/switches'
const MAINT = 'GET api/maintenance'

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
    fakeServer({ [READ]: () => (up ? ok(switches()) : fail(503, 'unavailable', '服务器正忙。')), [MAINT]: ok(maintenance()) })
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
    fakeServer({
      [READ]: ok(switches({ secondLayerChat: { on: true, updatedAt: '2026-11-03T12:05:00.000Z' } })),
      [MAINT]: ok(maintenance()),
    })
    show(<Switches />)

    await screen.findByRole('region', { name: '老师用大模型' })
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      '维护中',
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
    expect(chat.getByText(/^开着：同学之间的消息.*晚几秒/)).toBeInTheDocument()
    // Off, chat is still delivered: only the second check stops.
    expect(chat.getByText('关着：同学之间的消息只用词库审，不再送去第三方 AI 服务。')).toBeInTheDocument()
    expect(chat.getByText('最近一次切换：2026 年 11 月 3 日 20:05')).toBeInTheDocument()
  })

  it('asks before it switches, then shows the new state and when it changed', async () => {
    const server = fakeServer({
      [READ]: ok(switches()),
      [MAINT]: ok(maintenance()),
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
    fakeServer({ [READ]: ok(switches()), [MAINT]: ok(maintenance()), 'PUT api/switches/teacherLlm': { pending: true } })
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
      [MAINT]: ok(maintenance()),
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

  describe('maintenance', () => {
    const PUT = 'PUT api/maintenance'

    it('has a row that says nothing is under maintenance', async () => {
      fakeServer({ [READ]: ok(switches()), [MAINT]: ok(maintenance()) })
      show(<Switches />)

      const maint = within(await screen.findByRole('region', { name: '维护中' }))
      expect(maint.getByText('现在没在维护')).toBeInTheDocument()
      expect(maint.getByRole('button', { name: '开始维护' })).toBeInTheDocument()
    })

    it('asks for a message and warns that the plugins online are disconnected; it cannot be confirmed empty', async () => {
      const server = fakeServer({
        [READ]: ok(switches()),
        [MAINT]: ok(maintenance()),
        [PUT]: ok(maintenance({ message: '服务器升级中', expectedBackAt: '2026-11-04T04:00:00.000Z' })),
      })
      const user = userEvent.setup()
      show(<Switches />)

      await user.click(within(await screen.findByRole('region', { name: '维护中' })).getByRole('button', { name: '开始维护' }))
      const dialog = within(await screen.findByRole('dialog', { name: '开始维护？' }))
      expect(dialog.getByText(/在线的插件都会被断开/)).toBeInTheDocument()
      // The slots it overlaps are not held today, even if it ends early.
      expect(dialog.getByText('哪个时段从开门到下课之间碰上维护，这个时段今天就不上课了，哪怕维护提前结束，以后也不补。')).toBeInTheDocument()
      const confirm = dialog.getByRole('button', { name: '开始维护' })
      expect(confirm).toBeDisabled()

      await user.type(dialog.getByLabelText(/^说明/), '   ')
      expect(confirm).toBeDisabled()
      await user.type(dialog.getByLabelText(/^说明/), '服务器升级中')
      expect(confirm).toBeEnabled()
      await user.type(dialog.getByLabelText(/^预计几小时后恢复/), '3')
      await user.click(confirm)

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      const puts = server.calls.filter((call) => call.method === 'PUT')
      expect(puts).toHaveLength(1)
      expect(puts[0]?.body).toMatchObject({ on: true, message: '服务器升级中' })
      const sent = (puts[0]?.body as { expectedBackAt: string }).expectedBackAt
      expect(new Date(sent).getTime() - Date.now()).toBeGreaterThan(2.9 * 3_600_000)

      const maint = within(screen.getByRole('region', { name: '维护中' }))
      expect(maint.getByText('现在维护中')).toBeInTheDocument()
      expect(maint.getByText('说明：服务器升级中')).toBeInTheDocument()
      expect(maint.getByText('开始时间：2026 年 11 月 4 日 09:00')).toBeInTheDocument()
      expect(maint.getByText('预计恢复：2026 年 11 月 4 日 12:00')).toBeInTheDocument()
      expect(maint.getByRole('button', { name: '结束维护' })).toBeInTheDocument()
    })

    it('shows what is on, and asks before it ends it', async () => {
      const server = fakeServer({
        [READ]: ok(switches()),
        [MAINT]: ok(maintenance({ message: '数据库迁移' })),
        [PUT]: ok(maintenance()),
      })
      const user = userEvent.setup()
      show(<Switches />)

      const maint = within(await screen.findByRole('region', { name: '维护中' }))
      expect(await maint.findByText('说明：数据库迁移')).toBeInTheDocument()
      expect(maint.getByText('预计恢复：没有写')).toBeInTheDocument()

      await user.click(maint.getByRole('button', { name: '结束维护' }))
      const dialog = within(await screen.findByRole('dialog', { name: '结束维护？' }))
      // Not every lesson goes on: a slot it overlapped today stays off.
      expect(dialog.getByText('结束以后，插件可以重新连上。今天从开门到下课之间碰上过维护的时段不再上课，其余的课照常上。')).toBeInTheDocument()
      await user.click(dialog.getByRole('button', { name: '先不结束' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(server.calls.filter((call) => call.method === 'PUT')).toHaveLength(0)

      await user.click(maint.getByRole('button', { name: '结束维护' }))
      await user.click(within(await screen.findByRole('dialog', { name: '结束维护？' })).getByRole('button', { name: '结束维护' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(server.calls.filter((call) => call.method === 'PUT').map((call) => call.body)).toEqual([{ on: false }])
      expect(maint.getByText('现在没在维护')).toBeInTheDocument()
    })

    it('edits the message while it is on: prefilled, sends the new values, shows them afterwards', async () => {
      const server = fakeServer({
        [READ]: ok(switches()),
        [MAINT]: ok(maintenance({ message: '数据库迁移' })),
        [PUT]: ok(maintenance({ message: '迁移要久一点', expectedBackAt: '2026-11-04T08:00:00.000Z' })),
      })
      const user = userEvent.setup()
      show(<Switches />)

      const maint = within(await screen.findByRole('region', { name: '维护中' }))
      await user.click(await maint.findByRole('button', { name: '修改说明' }))
      const dialog = within(await screen.findByRole('dialog', { name: '修改说明？' }))
      const box = dialog.getByLabelText(/^说明/)
      expect(box).toHaveValue('数据库迁移')
      await user.clear(box)
      await user.type(box, '迁移要久一点')
      await user.type(dialog.getByLabelText(/^预计几小时后恢复/), '2')
      await user.click(dialog.getByRole('button', { name: '修改说明' }))

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      const puts = server.calls.filter((call) => call.method === 'PUT')
      expect(puts).toHaveLength(1)
      expect(puts[0]?.body).toMatchObject({ on: true, message: '迁移要久一点' })
      expect((puts[0]?.body as { expectedBackAt: string }).expectedBackAt).toMatch(/^\d{4}-/)
      expect(maint.getByText('说明：迁移要久一点')).toBeInTheDocument()
      expect(maint.getByText('预计恢复：2026 年 11 月 4 日 16:00')).toBeInTheDocument()
      expect(maint.getByText('现在维护中')).toBeInTheDocument()
    })

    it('editing only the message keeps the expected return time', async () => {
      const BACK = '2026-11-04T08:00:00.000Z'
      const server = fakeServer({
        [READ]: ok(switches()),
        [MAINT]: ok(maintenance({ message: '数据库迁移', expectedBackAt: BACK })),
        [PUT]: ok(maintenance({ message: '改一下', expectedBackAt: BACK })),
      })
      const user = userEvent.setup()
      show(<Switches />)

      const maint = within(await screen.findByRole('region', { name: '维护中' }))
      await user.click(await maint.findByRole('button', { name: '修改说明' }))
      const dialog = within(await screen.findByRole('dialog', { name: '修改说明？' }))
      expect(dialog.getByText(/这一栏不填，就保持不变/)).toBeInTheDocument()
      const box = dialog.getByLabelText(/^说明/)
      await user.clear(box)
      await user.type(box, '改一下')
      await user.click(dialog.getByRole('button', { name: '修改说明' }))

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(server.calls.filter((call) => call.method === 'PUT').map((call) => call.body)).toEqual([
        { on: true, message: '改一下' },
      ])
      expect(maint.getByText('预计恢复：2026 年 11 月 4 日 16:00')).toBeInTheDocument()
    })

    it('the edit can clear the expected return time', async () => {
      const server = fakeServer({
        [READ]: ok(switches()),
        [MAINT]: ok(maintenance({ message: '数据库迁移', expectedBackAt: '2026-11-04T08:00:00.000Z' })),
        [PUT]: ok(maintenance({ message: '数据库迁移', expectedBackAt: null })),
      })
      const user = userEvent.setup()
      show(<Switches />)

      const maint = within(await screen.findByRole('region', { name: '维护中' }))
      await user.click(await maint.findByRole('button', { name: '修改说明' }))
      const dialog = within(await screen.findByRole('dialog', { name: '修改说明？' }))
      const hours = dialog.getByLabelText(/^预计几小时后恢复/)
      expect(hours).toBeEnabled()
      await user.click(dialog.getByRole('checkbox', { name: '不写预计时间（清掉现在的）' }))
      expect(hours).toBeDisabled()
      await user.click(dialog.getByRole('button', { name: '修改说明' }))

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(server.calls.filter((call) => call.method === 'PUT').map((call) => call.body)).toEqual([
        { on: true, message: '数据库迁移', expectedBackAt: null },
      ])
      expect(maint.getByText('预计恢复：没有写')).toBeInTheDocument()
    })
  })
})
