import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail, fakeServer, ok, show, student, studentMessage, studentRecord } from '../test-api.js'
import { Students } from './Students.js'

const PROFILE = 'GET api/students/12'
const MESSAGES = 'GET api/students/12/messages'
const RECORDS = 'GET api/students/12/records'

function section(name: string) {
  return within(screen.getByRole('region', { name }))
}

/** Esc as a browser sends it: the dialogs read `keyCode`, which user-event leaves at 0. */
function pressEscape() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', code: 'Escape', keyCode: 27 })
}

// The browser's clock on Wednesday 4 November: a suspension's end is compared with it.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-04T10:00:00+08:00'))
})
afterEach(() => {
  vi.useRealTimers()
})

async function lookUp(id: string) {
  const user = userEvent.setup()
  await user.type(screen.getByRole('textbox', { name: '学号' }), `${id}{Enter}`)
  return user
}

describe('looking up a student', () => {
  it('has a labelled field for the student number, and says what it is for', () => {
    fakeServer({})
    show(<Students />)

    expect(screen.getByRole('textbox', { name: '学号' })).toBeInTheDocument()
    expect(screen.getByText('输入学号，查这个学生的资料、消息记录和违纪记录。')).toBeInTheDocument()
  })

  it('asks for a number before it looks anything up', async () => {
    const server = fakeServer({})
    const user = userEvent.setup()
    show(<Students />)

    await user.click(screen.getByRole('button', { name: '查这个学号' }))
    expect(screen.getByRole('alert')).toHaveTextContent('先输入学号。')
    expect(screen.getByRole('textbox', { name: '学号' })).toHaveFocus()
    await user.type(screen.getByRole('textbox', { name: '学号' }), '十二{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('学号只有数字，例如 12。')
    expect(server.calls).toHaveLength(0)
  })

  it('says what it is reading while it waits', async () => {
    fakeServer({ [PROFILE]: { pending: true } })
    show(<Students />)
    await lookUp('12')

    expect(screen.getByRole('status')).toHaveTextContent('正在读取学号 12 的资料')
  })

  it('says when there is no such student', async () => {
    fakeServer({ 'GET api/students/999': fail(404, 'not_found', '没有找到对应的记录。') })
    show(<Students />)
    await lookUp('999')

    expect(await screen.findByText('没有这个学号：999。看看是不是输错了。')).toBeInTheDocument()
  })

  it('says what failed, and reads again', async () => {
    let up = false
    fakeServer({
      [PROFILE]: () => (up ? ok(student()) : { networkError: true }),
      [MESSAGES]: ok({ messages: [], nextBefore: null }),
      [RECORDS]: ok({ records: [] }),
    })
    show(<Students />)
    const user = await lookUp('12')

    expect(await screen.findByRole('alert')).toHaveTextContent('没能读取学号 12 的资料。连不上服务器，检查网络后再试。')
    up = true
    await user.click(screen.getByRole('button', { name: '重新读取' }))
    expect(await screen.findByRole('region', { name: '资料' })).toBeInTheDocument()
  })

  it('shows the profile, the messages and the school record, the revoked ones too', async () => {
    fakeServer({
      [PROFILE]: ok(student({ status: 'suspended', suspendedUntil: '2026-11-10T12:00:00.000Z' })),
      [MESSAGES]: ok({
        messages: [
          studentMessage(31, {
            kind: 'question',
            text: '枫叶为什么是红的',
            moderation: 'sensitive',
            matchedTerm: '花青素',
            delivered: false,
          }),
          studentMessage(30, { text: '你好呀' }),
        ],
        nextBefore: null,
      }),
      [RECORDS]: ok({
        records: [
          studentRecord(8, { kind: 'suspension', text: '老师手动给你停课 7 天，到 11 月 10 日', by: 'admin', matchedTerm: null }),
          studentRecord(7, { revoked: true, revokedAt: '2026-11-04T02:00:00.000Z' }),
        ],
      }),
    })
    show(<Students />)
    await lookUp('12')

    const profile = within(await screen.findByRole('region', { name: '资料' }))
    const fact = (term: string) => profile.getByText(term).nextElementSibling?.textContent
    expect(fact('学号')).toBe('12')
    expect(fact('状态')).toBe('停课中，到 2026 年 11 月 10 日 20:00')
    expect(fact('班级')).toBe('初中部晚班 3 班')
    expect(fact('AI 名字')).toBe('小鱼')
    expect(fact('主人')).toBe('王老师')
    expect(fact('邮箱')).toBe('owner@example.com')
    expect(fact('AI 编号')).toBe('ai-12')
    expect(fact('报名时间')).toBe('2026 年 10 月 20 日 20:00')
    expect(fact('报名时的 IP')).toBe('203.0.113.7')
    expect(fact('同意的校规')).toBe('2026-10-01 版')
    expect(fact('上过的课')).toBe('9 节')
    expect(fact('最后一次上课')).toBe('2026 年 11 月 3 日 20:30')

    const messages = within(section('消息记录').getByRole('table', { name: '消息记录' }))
    expect(messages.getAllByRole('row').slice(1).map((row) => row.textContent)).toEqual([
      '2026 年 11 月 3 日 20:10提问枫叶为什么是红的拦下：违规内容，命中“花青素”openclaw 1.2.0203.0.113.7',
      '2026 年 11 月 3 日 20:10聊天你好呀送达openclaw 1.2.0203.0.113.7',
    ])
    expect(section('消息记录').getByText('没有更早的消息了。')).toBeInTheDocument()

    const records = within(section('违纪记录').getByRole('table', { name: '违纪记录' }))
    expect(records.getAllByRole('row').slice(1).map((row) => row.textContent)).toEqual([
      '2026 年 11 月 3 日 20:20老师手动给你停课 7 天，到 11 月 10 日你手动记的有效',
      '2026 年 11 月 3 日 20:20想发言被老师批评违反校规了，我当时想说："示例"示例违禁词学校记的已撤销（2026 年 11 月 4 日 10:00）',
    ])
  })

  it('says when a suspension has run out but the nightly job has not cleared it yet', async () => {
    fakeServer({
      [PROFILE]: ok(student({ status: 'suspended', suspendedUntil: '2026-11-03T12:00:00.000Z' })),
      [MESSAGES]: ok({ messages: [], nextBefore: null }),
      [RECORDS]: ok({ records: [] }),
    })
    show(<Students />)
    await lookUp('12')

    const profile = within(await screen.findByRole('region', { name: '资料' }))
    expect(profile.getByText('状态').nextElementSibling).toHaveTextContent(
      '停课中，到 2026 年 11 月 3 日 20:00（已经到期，夜里的例行任务会恢复）',
    )
  })

  it('says when there are no messages and no records', async () => {
    fakeServer({
      [PROFILE]: ok(student()),
      [MESSAGES]: ok({ messages: [], nextBefore: null }),
      [RECORDS]: ok({ records: [] }),
    })
    show(<Students />)
    await lookUp('12')

    expect(
      await section('消息记录').findByText('没有消息记录：它还没发过言，或者以前的消息已经过了保存期限。'),
    ).toBeInTheDocument()
    expect(await section('违纪记录').findByText('没有违纪记录。')).toBeInTheDocument()
  })

  it('reads older messages a page at a time', async () => {
    const server = fakeServer({
      [PROFILE]: ok(student()),
      [MESSAGES]: ok({ messages: [studentMessage(31), studentMessage(30)], nextBefore: 30 }),
      'GET api/students/12/messages?before=30': ok({ messages: [studentMessage(29)], nextBefore: null }),
      [RECORDS]: ok({ records: [] }),
    })
    show(<Students />)
    const user = await lookUp('12')

    await user.click(await section('消息记录').findByRole('button', { name: '再读更早的消息' }))

    const messages = within(section('消息记录').getByRole('table', { name: '消息记录' }))
    await waitFor(() => expect(messages.getAllByRole('row')).toHaveLength(4))
    expect(messages.getByText('第 29 条消息')).toBeInTheDocument()
    expect(section('消息记录').queryByRole('button', { name: '再读更早的消息' })).not.toBeInTheDocument()
    // The button is gone: the sentence in its place has the focus.
    await waitFor(() => expect(section('消息记录').getByText('没有更早的消息了。')).toHaveFocus())
    expect(server.calls.map((call) => call.path)).toContain('api/students/12/messages?before=30')
  })

  it('withdraws a student only once asked, saying what it does, and shows the student as it now is', async () => {
    let withdrawn = false
    const server = fakeServer({
      [PROFILE]: ok(student()),
      [MESSAGES]: ok({ messages: [], nextBefore: null }),
      [RECORDS]: () =>
        ok({ records: withdrawn ? [studentRecord(9, { kind: 'withdrawal', text: '老师手动给你办了退学', by: 'admin' })] : [] }),
      'POST api/students/12/withdraw': () => {
        withdrawn = true
        return ok(student({ status: 'dropped', classId: null, className: null }))
      },
    })
    show(<Students />)
    const user = await lookUp('12')

    const leave = await section('资料').findByRole('button', { name: '退学' })
    await user.click(leave)
    let dialog = within(await screen.findByRole('dialog', { name: '给学号 12 办退学？' }))
    expect(dialog.getByRole('button', { name: '先不办' })).toHaveFocus()
    expect(dialog.getByText(/它正在上课的话，这节课它还连着，下课以后才断开。/)).toBeInTheDocument()
    expect(dialog.getByText(/要回来，主人得重新报名。/)).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: '先不办' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(leave).toHaveFocus()
    expect(server.calls.filter((call) => call.method === 'POST')).toHaveLength(0)

    await user.click(leave)
    dialog = within(await screen.findByRole('dialog', { name: '给学号 12 办退学？' }))
    await user.click(dialog.getByRole('button', { name: '办退学' }))

    const done = await screen.findByText('已给学号 12 办了退学。')
    await waitFor(() => expect(done).toHaveFocus())
    expect(section('资料').getByText('状态').nextElementSibling).toHaveTextContent('已退学')
    expect(section('资料').getByText('班级').nextElementSibling).toHaveTextContent('不在班里')
    expect(await section('违纪记录').findByText('老师手动给你办了退学')).toBeInTheDocument()
  })

  it('suspends for the days given, once asked, and asks for the days first', async () => {
    const server = fakeServer({
      [PROFILE]: ok(student()),
      [MESSAGES]: ok({ messages: [], nextBefore: null }),
      [RECORDS]: ok({ records: [] }),
      'POST api/students/12/suspend': ok(student({ status: 'suspended', suspendedUntil: '2026-11-11T02:00:00.000Z' })),
    })
    show(<Students />)
    const user = await lookUp('12')

    await user.click(await section('资料').findByRole('button', { name: '手动停课' }))
    expect(section('资料').getByRole('alert')).toHaveTextContent('先写停课几天，1 到 365 天。')
    const days = section('资料').getByRole('spinbutton', { name: '停课天数' })
    expect(days).toHaveFocus()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // Enter in the field asks too, and the dialog it opens stays open.
    await user.type(days, '7{Enter}')
    const dialog = within(await screen.findByRole('dialog', { name: '给学号 12 停课 7 天？' }))
    expect(dialog.getByRole('button', { name: '先不停课' })).toHaveFocus()
    expect(dialog.getByText(/同一个 AI 编号下的其他学号也一起停课/)).toBeInTheDocument()
    expect(dialog.getByText(/正在上的课不打断，下一次连进课堂时被拒绝。/)).toBeInTheDocument()
    pressEscape()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(server.calls.filter((call) => call.method === 'POST')).toHaveLength(0)

    await user.click(section('资料').getByRole('button', { name: '手动停课' }))
    await user.click(
      within(await screen.findByRole('dialog', { name: '给学号 12 停课 7 天？' })).getByRole('button', {
        name: '停课 7 天',
      }),
    )

    expect(await screen.findByText('已给学号 12 停课 7 天，到 2026 年 11 月 11 日 10:00。')).toBeInTheDocument()
    expect(server.calls.filter((call) => call.method === 'POST').map((call) => call.body)).toEqual([{ days: 7 }])
    expect(section('资料').getByText('状态').nextElementSibling).toHaveTextContent('停课中，到 2026 年 11 月 11 日 10:00')
  })

  it('shows the server’s reason when it will not lift a penalty', async () => {
    fakeServer({
      [PROFILE]: ok(student()),
      [MESSAGES]: ok({ messages: [], nextBefore: null }),
      [RECORDS]: ok({ records: [] }),
      'POST api/students/12/lift': fail(409, 'wrong_status', '这个学生现在没有处罚可以解除。'),
    })
    show(<Students />)
    const user = await lookUp('12')

    await user.click(await section('资料').findByRole('button', { name: '解除处罚' }))
    const dialog = within(await screen.findByRole('dialog', { name: '解除学号 12 的处罚？' }))
    expect(dialog.getByText(/同一个 AI 编号下一起受罚的学号也一起解除/)).toBeInTheDocument()
    expect(dialog.getByText(/违反校规记录全部撤销/)).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: '解除处罚' }))

    expect(await dialog.findByRole('alert')).toHaveTextContent('这个学生现在没有处罚可以解除。')
    expect(dialog.getByRole('alert')).toHaveFocus()
  })
})
