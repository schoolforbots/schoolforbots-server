import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoticeView } from '../api.js'
import { fail, fakeServer, notice, ok, show, type Call, type Route } from '../test-api.js'
import { SchoolZone } from '../zone.js'
import { Notices } from './Notices.js'

const READ = 'GET api/notices'

// The browser's clock: 10:00 on Wednesday 4 November at the school. A publication time cannot be later.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-04T10:00:00+08:00'))
})
afterEach(() => {
  vi.useRealTimers()
})

/** A server that lists `notices` and answers the writes in `writes`. */
function serve(notices: NoticeView[], writes: Record<string, Route> = {}) {
  return fakeServer({ [READ]: ok({ notices }), ...writes })
}

function editor() {
  return within(screen.getByRole('region', { name: /^(写新|编辑)公告$/ }))
}

const writeOf = (calls: Call[]) => calls.filter((call) => call.method !== 'GET')

async function openNew() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  show(<Notices />)
  await user.click(await screen.findByRole('button', { name: '写新公告' }))
  return user
}

describe('the notices page: the list', () => {
  it('says what it is reading while it waits, and what failed', async () => {
    let up = false
    fakeServer({ [READ]: () => (up ? ok({ notices: [] }) : fail(503, 'unavailable', '服务器正忙。')) })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    show(<Notices />)

    expect(screen.getByRole('status')).toHaveTextContent('正在读取公告')
    expect(await screen.findByRole('alert')).toHaveTextContent('没能读取公告。服务器正忙。')
    up = true
    await user.click(screen.getByRole('button', { name: '重新读取' }))
    expect(await screen.findByText('还没有公告。写一条，存成草稿，看过预览再发布。')).toBeInTheDocument()
  })

  it('lists title, kind, status and publication time on the school clock, as the server orders them', async () => {
    serve([
      notice({ id: 9, title: '新草稿' }),
      notice({
        id: 8,
        title: '凌晨维护',
        kind: 'maintenance',
        startsAt: '2026-11-23T18:00:00.000Z',
        status: 'published',
        publishedAt: '2026-11-03T02:30:00.000Z',
        updatedAt: '2026-11-03T04:00:00.000Z',
      }),
      notice({ id: 7, title: '旧公告', status: 'withdrawn', publishedAt: '2026-10-30T12:05:00.000Z' }),
    ])
    show(<Notices />)

    const table = await screen.findByRole('table', { name: '公告' })
    const rows = within(table)
      .getAllByRole('row')
      .map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent))
    expect(rows).toEqual([
      ['标题', '类型', '状态', '发布时间'],
      ['新草稿', '普通', '草稿', '还没发布'],
      ['凌晨维护已更新（发布以后改过：2026 年 11 月 3 日 12:00）', '维护', '已发布', '2026 年 11 月 3 日 10:30'],
      ['旧公告', '普通', '已撤下', '2026 年 10 月 30 日 20:05'],
    ])
  })

  it('says so when there is no notice', async () => {
    serve([])
    show(<Notices />)

    expect(await screen.findByText('还没有公告。写一条，存成草稿，看过预览再发布。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '写新公告' })).toBeInTheDocument()
  })
})

describe('the notices page: writing', () => {
  it('saves a new general notice as a draft, the title trimmed, with no times', async () => {
    const server = serve([], { 'POST api/notices': ok(notice({ id: 10, title: '放假通知', body: '**周五**放假' })) })
    const user = await openNew()

    expect(screen.getByRole('heading', { name: '写新公告' })).toHaveFocus()
    await user.type(editor().getByRole('textbox', { name: '标题' }), '  放假通知 ')
    await user.type(editor().getByRole('textbox', { name: '正文' }), '**周五**放假')
    await user.click(editor().getByRole('button', { name: '保存草稿' }))

    expect(await screen.findByText('草稿已保存。')).toHaveFocus()
    const [write] = writeOf(server.calls)
    expect(write).toMatchObject({
      method: 'POST',
      path: 'api/notices',
      headers: { 'x-requested-with': 'admin' },
      body: { title: '放假通知', body: '**周五**放假', kind: 'general' },
    })
    expect(write?.body).not.toHaveProperty('startsAt')
    // Saved, it is a draft being edited, and the list is read again.
    expect(screen.getByRole('heading', { name: '编辑公告' })).toBeInTheDocument()
    expect(editor().getByText('状态：草稿')).toBeInTheDocument()
    expect(server.calls.filter((call) => call.method === 'GET')).toHaveLength(2)
  })

  it('previews the body as the website will show it', async () => {
    serve([])
    const user = await openNew()

    const body = editor().getByRole('textbox', { name: '正文' })
    fireEvent.change(body, {
      target: {
        value:
          '第一段<b>不是加粗</b>\n\n- **重点**\n- [状态页](https://status.schoolforbots.org)\n- [别点](javascript:alert(1))',
      },
    })
    await user.type(editor().getByRole('textbox', { name: '标题' }), '预览看看')

    const preview = within(editor().getByRole('region', { name: '预览' }))
    expect(preview.getByRole('heading', { name: '预览看看' })).toBeInTheDocument()
    expect(preview.getByText('第一段<b>不是加粗</b>')).toBeInTheDocument()
    expect(preview.getByText('重点').tagName).toBe('STRONG')
    expect(preview.getByRole('link', { name: '状态页' })).toHaveAttribute('rel', 'noopener noreferrer')
    expect(preview.getAllByRole('link')).toHaveLength(1)
    expect(preview.getByText('[别点](javascript:alert(1))')).toBeInTheDocument()
  })

  it('asks for the maintenance times only for a maintenance notice', async () => {
    serve([])
    const user = await openNew()

    expect(editor().queryByLabelText('维护开始')).not.toBeInTheDocument()
    expect(editor().queryByLabelText('维护结束（可以不填）')).not.toBeInTheDocument()
    await user.click(editor().getByRole('radio', { name: '维护' }))
    expect(editor().getByLabelText('维护开始')).toBeInTheDocument()
    expect(editor().getByLabelText('维护结束（可以不填）')).toBeInTheDocument()
    expect(editor().getByText('时间都按学校时区（Asia/Shanghai）填写。')).toBeInTheDocument()
    await user.click(editor().getByRole('radio', { name: '普通' }))
    expect(editor().queryByLabelText('维护开始')).not.toBeInTheDocument()
  })

  it('sends the maintenance times entered on the school clock in UTC', async () => {
    const server = serve([], { 'POST api/notices': ok(notice({ kind: 'maintenance' })) })
    const user = await openNew()

    await user.type(editor().getByRole('textbox', { name: '标题' }), '凌晨维护')
    await user.click(editor().getByRole('radio', { name: '维护' }))
    fireEvent.change(editor().getByLabelText('维护开始'), { target: { value: '2026-11-24T02:00' } })
    fireEvent.change(editor().getByLabelText('维护结束（可以不填）'), { target: { value: '2026-11-24T03:30' } })
    await user.click(editor().getByRole('button', { name: '保存草稿' }))

    await screen.findByText('草稿已保存。')
    expect(writeOf(server.calls)[0]?.body).toEqual({
      title: '凌晨维护',
      body: '',
      kind: 'maintenance',
      startsAt: '2026-11-23T18:00:00.000Z',
      endsAt: '2026-11-23T19:30:00.000Z',
    })
  })

  it('reads the times on the school clock, not this computer’s', async () => {
    const server = serve(
      [
        notice({
          kind: 'maintenance',
          startsAt: '2026-11-24T07:00:00.000Z',
          endsAt: null,
          status: 'published',
          publishedAt: '2026-11-03T15:00:00.000Z',
        }),
      ],
      { 'PUT api/notices/7': ok(notice({ status: 'published', publishedAt: '2026-11-03T15:00:00.000Z' })) },
    )
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    show(
      <SchoolZone value="America/New_York">
        <Notices />
      </SchoolZone>,
    )

    await user.click(await screen.findByRole('button', { name: '期中考试安排' }))
    expect(screen.getByRole('cell', { name: '2026 年 11 月 3 日 10:00' })).toBeInTheDocument()
    expect(editor().getByLabelText('维护开始')).toHaveValue('2026-11-24T02:00')
    expect(editor().getByLabelText('维护结束（可以不填）')).toHaveValue('')
    expect(editor().getByLabelText('发布时间')).toHaveValue('2026-11-03T10:00')
    fireEvent.change(editor().getByLabelText('维护开始'), { target: { value: '2026-11-24T01:00' } })
    await user.click(editor().getByRole('button', { name: '保存修改' }))

    await screen.findByText('修改已保存。')
    expect(writeOf(server.calls)[0]?.body).toMatchObject({ startsAt: '2026-11-24T06:00:00.000Z', endsAt: null })
  })

  it('sends back a time not changed as the instant it was, though the clock shows it twice', async () => {
    // 01:30 on 1 November in New York comes twice; the notice has the second (EST, 06:30 UTC).
    const second = notice({ kind: 'maintenance', startsAt: '2026-11-01T06:30:00.000Z' })
    const server = serve([second], { 'PUT api/notices/7': ok(second) })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    show(
      <SchoolZone value="America/New_York">
        <Notices />
      </SchoolZone>,
    )

    await user.click(await screen.findByRole('button', { name: '期中考试安排' }))
    expect(editor().getByLabelText('维护开始')).toHaveValue('2026-11-01T01:30')
    await user.click(editor().getByRole('button', { name: '保存草稿' }))
    await screen.findByText('草稿已保存。')
    expect(writeOf(server.calls)[0]?.body).toMatchObject({ startsAt: '2026-11-01T06:30:00.000Z' })
  })

  it('says what is wrong before it sends anything', async () => {
    const server = serve([])
    const user = await openNew()

    await user.type(editor().getByRole('textbox', { name: '标题' }), '   ')
    await user.click(editor().getByRole('button', { name: '保存草稿' }))
    const checks = editor().getByRole('status')
    expect(checks).toHaveTextContent('标题不能空着。')
    expect(checks).toHaveFocus()

    fireEvent.change(editor().getByRole('textbox', { name: '标题' }), { target: { value: '长'.repeat(61) } })
    fireEvent.change(editor().getByRole('textbox', { name: '正文' }), { target: { value: '字'.repeat(4001) } })
    expect(editor().getByRole('status')).toHaveTextContent('标题最多 60 字，现在 61 字。')
    expect(editor().getByRole('status')).toHaveTextContent('正文最多 4000 字，现在 4001 字。')

    fireEvent.change(editor().getByRole('textbox', { name: '标题' }), { target: { value: '维护' } })
    fireEvent.change(editor().getByRole('textbox', { name: '正文' }), { target: { value: '' } })
    await user.click(editor().getByRole('radio', { name: '维护' }))
    expect(editor().getByRole('status')).toHaveTextContent('维护公告要写开始时间。')

    fireEvent.change(editor().getByLabelText('维护开始'), { target: { value: '2026-11-24T02:00' } })
    fireEvent.change(editor().getByLabelText('维护结束（可以不填）'), { target: { value: '2026-11-24T02:00' } })
    expect(editor().getByRole('status')).toHaveTextContent('维护结束要晚于开始。')
    await user.click(editor().getByRole('button', { name: '发布' }))

    expect(writeOf(server.calls)).toEqual([])
  })

  it('refuses what the server cannot store: a year out of range, a NUL, half a character', async () => {
    const server = serve([])
    const user = await openNew()

    fireEvent.change(editor().getByRole('textbox', { name: '标题' }), { target: { value: '标题\u0000' } })
    fireEvent.change(editor().getByRole('textbox', { name: '正文' }), { target: { value: '半个\uD800字' } })
    await user.click(editor().getByRole('radio', { name: '维护' }))
    // 07:00 on 1 January 2000 at the school is still 1999 in UTC.
    fireEvent.change(editor().getByLabelText('维护开始'), { target: { value: '2000-01-01T07:00' } })
    await user.click(editor().getByRole('button', { name: '保存草稿' }))

    const alert = editor().getByRole('status')
    expect(alert).toHaveTextContent('标题里有存不了的字符（NUL 或半个字符），删掉再试。')
    expect(alert).toHaveTextContent('正文里有存不了的字符（NUL 或半个字符），删掉再试。')
    expect(alert).toHaveTextContent('维护开始要在 2000 年到 9999 年之间。')
    expect(writeOf(server.calls)).toEqual([])
  })

  it('takes only years 2000 to 9999', async () => {
    const server = serve([])
    const user = await openNew()

    await user.type(editor().getByRole('textbox', { name: '标题' }), '维护')
    await user.click(editor().getByRole('radio', { name: '维护' }))
    for (const value of ['0099-01-01T00:00', '1999-06-01T12:00', '10000-01-01T00:00']) {
      fireEvent.change(editor().getByLabelText('维护开始'), { target: { value } })
      await user.click(editor().getByRole('button', { name: '保存草稿' }))
      expect(editor().getByRole('status')).toHaveTextContent('维护开始要在 2000 年到 9999 年之间。')
    }
    expect(writeOf(server.calls)).toEqual([])
  })

  it('does not read each key out: the checks are said when a button is pressed, and gone once saved', async () => {
    serve([], { 'POST api/notices': ok(notice({ title: '好了' })) })
    const user = await openNew()

    await user.click(editor().getByRole('button', { name: '保存草稿' }))
    expect(editor().queryByRole('alert')).not.toBeInTheDocument()
    expect(editor().getByRole('status')).toHaveTextContent('标题不能空着。')
    await user.type(editor().getByRole('textbox', { name: '标题' }), '好了')
    expect(editor().queryByText('标题不能空着。')).not.toBeInTheDocument()
    await user.click(editor().getByRole('button', { name: '保存草稿' }))
    await screen.findByText('草稿已保存。')

    // Emptied again after the save, the title is not complained about until the next press.
    await user.clear(editor().getByRole('textbox', { name: '标题' }))
    expect(editor().queryByText('标题不能空着。')).not.toBeInTheDocument()
  })

  it('counts the title and body in characters, as the server does', async () => {
    const server = serve([], { 'POST api/notices': ok(notice()) })
    const user = await openNew()

    // 60 characters outside the basic plane: 120 UTF-16 units, still within the limit.
    fireEvent.change(editor().getByRole('textbox', { name: '标题' }), { target: { value: '𠀀'.repeat(60) } })
    await user.click(editor().getByRole('button', { name: '保存草稿' }))

    await screen.findByText('草稿已保存。')
    expect(writeOf(server.calls)).toHaveLength(1)
  })

  it('shows the server’s refusal in its words', async () => {
    serve([], { 'POST api/notices': fail(400, 'invalid_request', '请求内容不对。') })
    const user = await openNew()

    await user.type(editor().getByRole('textbox', { name: '标题' }), '标题')
    await user.click(editor().getByRole('button', { name: '保存草稿' }))

    const alert = await editor().findByRole('alert')
    expect(alert).toHaveTextContent('没能保存：请求内容不对。')
    expect(alert).toHaveFocus()
    expect(editor().getByRole('button', { name: '保存草稿' })).toBeEnabled()
  })
})

describe('the notices page: editing and publishing', () => {
  const published = notice({ status: 'published', publishedAt: '2026-11-03T12:00:00.000Z' })

  async function open(title = '期中考试安排') {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    show(<Notices />)
    await user.click(await screen.findByRole('button', { name: title }))
    return user
  }

  it('edits a published notice: the whole content is sent, the publication time only when changed', async () => {
    const server = serve([published], {
      'PUT api/notices/7': (call) => ok({ ...published, ...(call.body as object), updatedAt: '2026-11-04T02:00:00.000Z' }),
    })
    const user = await open()

    expect(screen.getByRole('heading', { name: '编辑公告' })).toHaveFocus()
    expect(editor().getByText('状态：已发布')).toBeInTheDocument()
    expect(editor().getByRole('textbox', { name: '标题' })).toHaveValue('期中考试安排')
    expect(editor().getByRole('textbox', { name: '正文' })).toHaveValue('下周三期中考试。')
    expect(editor().getByLabelText('发布时间')).toHaveValue('2026-11-03T20:00')
    expect(editor().queryByRole('button', { name: '删除草稿' })).not.toBeInTheDocument()
    expect(editor().queryByRole('button', { name: '发布' })).not.toBeInTheDocument()

    await user.type(editor().getByRole('textbox', { name: '标题' }), '（改）')
    await user.click(editor().getByRole('button', { name: '保存修改' }))
    expect(await screen.findByText('修改已保存。')).toBeInTheDocument()
    expect(writeOf(server.calls)[0]).toMatchObject({
      method: 'PUT',
      path: 'api/notices/7',
      body: { title: '期中考试安排（改）', body: '下周三期中考试。', kind: 'general' },
    })
    expect(writeOf(server.calls)[0]?.body).not.toHaveProperty('publishedAt')

    fireEvent.change(editor().getByLabelText('发布时间'), { target: { value: '2026-11-02T09:15' } })
    await user.click(editor().getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(writeOf(server.calls)).toHaveLength(2))
    expect(writeOf(server.calls)[1]?.body).toMatchObject({ publishedAt: '2026-11-02T01:15:00.000Z' })
  })

  it('does not take a publication time later than now, or none', async () => {
    const server = serve([published])
    const user = await open()

    fireEvent.change(editor().getByLabelText('发布时间'), { target: { value: '2026-11-04T10:01' } })
    await user.click(editor().getByRole('button', { name: '保存修改' }))
    expect(editor().getByRole('status')).toHaveTextContent('发布时间不能晚于现在。')
    fireEvent.change(editor().getByLabelText('发布时间'), { target: { value: '' } })
    expect(editor().getByRole('status')).toHaveTextContent('发布时间不能空着。')
    expect(writeOf(server.calls)).toEqual([])
  })

  it('publishes a draft: saves it, then publishes it', async () => {
    const server = serve([notice()], {
      'PUT api/notices/7': ok(notice()),
      'POST api/notices/7/publish': ok(published),
    })
    const user = await open()

    expect(editor().queryByLabelText('发布时间')).not.toBeInTheDocument()
    await user.click(editor().getByRole('button', { name: '发布' }))

    expect(await screen.findByText('已发布。')).toHaveFocus()
    expect(writeOf(server.calls).map((call) => `${call.method} ${call.path}`)).toEqual([
      'PUT api/notices/7',
      'POST api/notices/7/publish',
    ])
    expect(editor().getByText('状态：已发布')).toBeInTheDocument()
    expect(editor().getByRole('button', { name: '撤下' })).toBeInTheDocument()
    // Out now, it has the time it was published, on the school clock.
    expect(editor().getByLabelText('发布时间')).toHaveValue('2026-11-03T20:00')
  })

  it('publishes a new notice: makes the draft, then publishes it', async () => {
    const server = serve([], {
      'POST api/notices': ok(notice({ id: 11 })),
      'POST api/notices/11/publish': ok({ ...published, id: 11 }),
    })
    const user = await openNew()

    await user.type(editor().getByRole('textbox', { name: '标题' }), '期中考试安排')
    await user.click(editor().getByRole('button', { name: '发布' }))

    expect(await screen.findByText('已发布。')).toBeInTheDocument()
    expect(writeOf(server.calls).map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST api/notices',
      'POST api/notices/11/publish',
    ])
  })

  it('says when the draft was saved but not published', async () => {
    serve([notice()], {
      'PUT api/notices/7': ok(notice()),
      'POST api/notices/7/publish': fail(503, 'unavailable', '服务器正忙。'),
    })
    const user = await open()

    await user.click(editor().getByRole('button', { name: '发布' }))
    expect(await editor().findByRole('alert')).toHaveTextContent('草稿已保存，但没能发布：服务器正忙。')
  })

  it('does not publish again a notice that was published meanwhile', async () => {
    const server = serve([notice()], { 'PUT api/notices/7': ok(published) })
    const user = await open()

    await user.click(editor().getByRole('button', { name: '发布' }))
    expect(await screen.findByText('已保存。这条公告已经是发布状态。')).toBeInTheDocument()
    expect(writeOf(server.calls).map((call) => `${call.method} ${call.path}`)).toEqual(['PUT api/notices/7'])
    expect(editor().getByText('状态：已发布')).toBeInTheDocument()
  })

  it('after a refusal, reads the list again and takes the notice as the server has it', async () => {
    let reads = 0
    const withdrawn = { ...published, status: 'withdrawn' as const }
    const server = fakeServer({
      [READ]: () => ok({ notices: [reads++ === 0 ? published : withdrawn] }),
      'POST api/notices/7/withdraw': fail(409, 'wrong_status', '只有已发布的公告才能撤下。'),
    })
    const user = await open()

    await user.click(editor().getByRole('button', { name: '撤下' }))
    expect(await editor().findByRole('alert')).toHaveTextContent('没能撤下：只有已发布的公告才能撤下。')
    expect(await editor().findByText('状态：已撤下')).toBeInTheDocument()
    expect(editor().getByRole('button', { name: '重新发布' })).toBeInTheDocument()
    expect(within(screen.getByRole('table', { name: '公告' })).getByText('已撤下')).toBeInTheDocument()
    expect(server.calls.filter((call) => call.method === 'GET').length).toBeGreaterThanOrEqual(2)
  })

  it('after a 404, keeps what was written, to be saved as a new draft', async () => {
    let reads = 0
    fakeServer({
      [READ]: () => ok({ notices: reads++ === 0 ? [notice()] : [] }),
      'PUT api/notices/7': fail(404, 'not_found', '没有找到对应的记录。'),
    })
    const user = await open()

    await user.click(editor().getByRole('button', { name: '保存草稿' }))
    expect(await editor().findByRole('alert')).toHaveTextContent('没能保存：没有找到对应的记录。')
    expect(await editor().findByText('状态：还没保存')).toBeInTheDocument()
    expect(editor().getByRole('textbox', { name: '标题' })).toHaveValue('期中考试安排')
    expect(await screen.findByText('还没有公告。写一条，存成草稿，看过预览再发布。')).toBeInTheDocument()
  })

  it('withdraws a published notice, and publishes it again', async () => {
    const withdrawn = { ...published, status: 'withdrawn' as const }
    const server = serve([published], {
      'POST api/notices/7/withdraw': ok(withdrawn),
      'PUT api/notices/7': ok(withdrawn),
      'POST api/notices/7/publish': ok(published),
    })
    const user = await open()

    await user.click(editor().getByRole('button', { name: '撤下' }))
    expect(await screen.findByText('已撤下。网站上不再显示这条公告。')).toHaveFocus()
    expect(editor().getByText('状态：已撤下')).toBeInTheDocument()
    expect(writeOf(server.calls).map((call) => `${call.method} ${call.path}`)).toEqual(['POST api/notices/7/withdraw'])

    await user.click(editor().getByRole('button', { name: '重新发布' }))
    expect(await screen.findByText('已重新发布，发布时间还是第一次发布的时间。')).toBeInTheDocument()
    expect(writeOf(server.calls).map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST api/notices/7/withdraw',
      'PUT api/notices/7',
      'POST api/notices/7/publish',
    ])
    expect(editor().getByText('状态：已发布')).toBeInTheDocument()
  })

  it('asks before withdrawing with changes unsaved, and keeps them', async () => {
    const withdrawn = { ...published, status: 'withdrawn' as const }
    const server = serve([published], { 'POST api/notices/7/withdraw': ok(withdrawn) })
    const user = await open()

    fireEvent.change(editor().getByLabelText('发布时间'), { target: { value: '2026-11-02T09:15' } })
    await user.click(editor().getByRole('button', { name: '撤下' }))
    let dialog = within(await screen.findByRole('dialog', { name: '有没保存的修改，先撤下吗？' }))
    expect(dialog.getByText(/撤下不会保存这些修改/)).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: '先不撤' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(writeOf(server.calls)).toEqual([])

    await user.click(editor().getByRole('button', { name: '撤下' }))
    dialog = within(await screen.findByRole('dialog', { name: '有没保存的修改，先撤下吗？' }))
    await user.click(dialog.getByRole('button', { name: '撤下' }))
    expect(await screen.findByText('已撤下。网站上不再显示这条公告。表单里的修改还没保存。')).toBeInTheDocument()
    expect(editor().getByLabelText('发布时间')).toHaveValue('2026-11-02T09:15')
  })

  it('shows a refused withdrawal in the server’s words', async () => {
    serve([published], { 'POST api/notices/7/withdraw': fail(409, 'wrong_status', '只有已发布的公告才能撤下。') })
    const user = await open()

    await user.click(editor().getByRole('button', { name: '撤下' }))
    expect(await editor().findByRole('alert')).toHaveTextContent('没能撤下：只有已发布的公告才能撤下。')
  })

  it('deletes a draft after asking, and only a draft', async () => {
    const server = serve([notice()], { 'DELETE api/notices/7': ok({ ok: true }) })
    const user = await open()

    await user.click(editor().getByRole('button', { name: '删除草稿' }))
    let dialog = within(await screen.findByRole('dialog', { name: '删除草稿“期中考试安排”？' }))
    expect(dialog.getByRole('button', { name: '先不删' })).toHaveFocus()
    await user.click(dialog.getByRole('button', { name: '先不删' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(writeOf(server.calls)).toEqual([])

    await user.click(editor().getByRole('button', { name: '删除草稿' }))
    dialog = within(await screen.findByRole('dialog', { name: '删除草稿“期中考试安排”？' }))
    await user.click(dialog.getByRole('button', { name: '删除' }))

    expect(await screen.findByText('草稿已删除。')).toHaveFocus()
    expect(writeOf(server.calls)).toMatchObject([
      { method: 'DELETE', path: 'api/notices/7', headers: { 'x-requested-with': 'admin' } },
    ])
    expect(screen.queryByRole('heading', { name: '编辑公告' })).not.toBeInTheDocument()
  })

  it('shows a refused deletion in the dialog', async () => {
    serve([notice()], { 'DELETE api/notices/7': fail(409, 'wrong_status', '发布过的公告不能删除，只能撤下。') })
    const user = await open()

    await user.click(editor().getByRole('button', { name: '删除草稿' }))
    const dialog = within(await screen.findByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: '删除' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('发布过的公告不能删除，只能撤下。')
  })

  it('asks before dropping unsaved changes: on closing, opening another notice, or writing a new one', async () => {
    const server = serve([notice(), notice({ id: 8, title: '另一条' })])
    const user = await open()

    await user.type(editor().getByRole('textbox', { name: '正文' }), '补一句')
    for (const button of [
      () => editor().getByRole('button', { name: '关闭' }),
      () => screen.getByRole('button', { name: '另一条' }),
      () => screen.getByRole('button', { name: '写新公告' }),
    ]) {
      await user.click(button())
      const dialog = within(await screen.findByRole('dialog', { name: '有没保存的修改，关掉就没了' }))
      expect(dialog.getByRole('button', { name: '回去接着改' })).toHaveFocus()
      await user.click(dialog.getByRole('button', { name: '回去接着改' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(editor().getByRole('textbox', { name: '正文' })).toHaveValue('下周三期中考试。补一句')
    }

    await user.click(screen.getByRole('button', { name: '另一条' }))
    const dialog = within(await screen.findByRole('dialog', { name: '有没保存的修改，关掉就没了' }))
    await user.click(dialog.getByRole('button', { name: '不保存，关掉' }))
    await waitFor(() => expect(editor().getByRole('textbox', { name: '标题' })).toHaveValue('另一条'))
    expect(writeOf(server.calls)).toEqual([])
  })

  it('closes the editor without asking when nothing was changed', async () => {
    const server = serve([notice()])
    const user = await open()

    await user.click(screen.getByRole('button', { name: '写新公告' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '写新公告' })).toBeInTheDocument()

    await user.click(editor().getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('heading', { name: '编辑公告' })).not.toBeInTheDocument()
    expect(writeOf(server.calls)).toEqual([])
  })
})
