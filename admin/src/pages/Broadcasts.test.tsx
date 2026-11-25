import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BroadcastClass, BroadcastView } from '../api.js'
import { fakeServer, ok, show, type Call, type Route } from '../test-api.js'
import { Broadcasts } from './Broadcasts.js'

const READ = 'GET api/broadcasts'
const CLASSES = 'GET api/broadcasts/classes'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-04T10:00:00+08:00'))
})
afterEach(() => {
  vi.useRealTimers()
})

const CLASS_LIST: BroadcastClass[] = [
  { id: 1, division: 'junior', slot: 'evening', classNo: 1, name: '初中部·晚班·1 班' },
  { id: 2, division: 'junior', slot: 'evening', classNo: 2, name: '初中部·晚班·2 班' },
]

function broadcast(over: Partial<BroadcastView> = {}): BroadcastView {
  return {
    id: 7,
    title: '今晚斗地主社有比赛',
    body: '晚上 9 点开始。',
    importance: 'normal',
    divisions: [],
    slots: [],
    classes: [],
    audience: '全校',
    status: 'draft',
    seq: null,
    publishedAt: null,
    withdrawnAt: null,
    expiresAt: null,
    noticeId: null,
    createdAt: '2026-11-04T01:00:00.000Z',
    ...over,
  }
}

const published = broadcast({ status: 'published', seq: 3, publishedAt: '2026-11-04T01:30:00.000Z' })

function serve(broadcasts: BroadcastView[], writes: Record<string, Route> = {}) {
  return fakeServer({ [READ]: ok({ broadcasts }), [CLASSES]: ok({ classes: CLASS_LIST }), ...writes })
}

const editor = () => within(screen.getByRole('region', { name: /^(写新广播|编辑广播|广播)$/ }))
const writeOf = (calls: Call[]) => calls.filter((call) => call.method !== 'GET')

async function openNew() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  show(<Broadcasts />)
  await user.click(await screen.findByRole('button', { name: '写新广播' }))
  return user
}

describe('the broadcasts page', () => {
  it('lists title, audience, importance, status and publication time', async () => {
    serve([
      broadcast({ id: 9, title: '新草稿', audience: '初中部 · 晚班', divisions: ['junior'], slots: ['evening'] }),
      broadcast({ id: 8, title: '开学', importance: 'important', status: 'published', seq: 2, publishedAt: '2026-11-03T02:30:00.000Z', noticeId: 1 }),
      broadcast({ id: 7, title: '旧的', status: 'withdrawn', seq: 1, publishedAt: '2026-10-30T12:05:00.000Z', withdrawnAt: '2026-10-31T00:00:00.000Z' }),
    ])
    show(<Broadcasts />)

    const table = await screen.findByRole('table', { name: '广播' })
    const rows = within(table)
      .getAllByRole('row')
      .map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent))
    expect(rows).toEqual([
      ['标题', '发给谁', '重要程度', '状态', '发布时间'],
      ['新草稿', '初中部 · 晚班', '普通', '草稿', '还没发布'],
      ['开学随公告发出', '全校', '重要', '已发布', '2026 年 11 月 3 日 10:30'],
      ['旧的', '全校', '普通', '已撤回', '2026 年 10 月 30 日 20:05'],
    ])
  })

  it('writes a broadcast to some divisions and slots and publishes it: makes the draft, then publishes it', async () => {
    const server = serve([], {
      'POST api/broadcasts': ok(broadcast({ id: 11 })),
      'POST api/broadcasts/11/publish': ok({ ...published, id: 11 }),
    })
    const user = await openNew()

    await user.type(editor().getByRole('textbox', { name: '标题' }), '初中部明天换主题')
    await user.click(editor().getByRole('radio', { name: '重要' }))
    await user.click(editor().getByRole('radio', { name: '按学部和时段' }))
    await user.click(editor().getByRole('checkbox', { name: '初中部' }))
    await user.click(editor().getByRole('checkbox', { name: '晚班' }))
    await user.click(editor().getByRole('button', { name: '发布' }))

    expect(await screen.findByText('已发布。插件下次来问时就会拿到。')).toHaveFocus()
    expect(writeOf(server.calls).map((call) => [`${call.method} ${call.path}`, call.body])).toEqual([
      [
        'POST api/broadcasts',
        {
          title: '初中部明天换主题',
          body: '',
          importance: 'important',
          divisions: ['junior'],
          slots: ['evening'],
          classes: [],
          expiresAt: null,
        },
      ],
      ['POST api/broadcasts/11/publish', undefined],
    ])
    // Out now: it is shown, not edited, and can only be withdrawn.
    expect(editor().queryByRole('textbox', { name: '标题' })).not.toBeInTheDocument()
    expect(editor().getByRole('button', { name: '撤回' })).toBeInTheDocument()
  })

  it('sends the classes picked by division, slot and number', async () => {
    const server = serve([], { 'POST api/broadcasts': ok(broadcast({ id: 12 })) })
    const user = await openNew()

    await user.type(editor().getByRole('textbox', { name: '标题' }), '表扬')
    await user.click(editor().getByRole('radio', { name: '指定班级' }))
    await user.click(await editor().findByRole('checkbox', { name: '初中部·晚班·2 班' }))
    await user.click(editor().getByRole('button', { name: '保存草稿' }))

    expect(await screen.findByText('草稿已保存。')).toBeInTheDocument()
    expect(writeOf(server.calls)[0]?.body).toMatchObject({
      divisions: [],
      slots: [],
      classes: [{ division: 'junior', slot: 'evening', classNo: 2 }],
    })
  })

  it('says what is missing and sends nothing', async () => {
    const server = serve([])
    const user = await openNew()

    await user.click(editor().getByRole('radio', { name: '按学部和时段' }))
    await user.click(editor().getByRole('button', { name: '发布' }))

    const problems = await screen.findByRole('status')
    expect(problems).toHaveTextContent('标题不能空着。')
    expect(problems).toHaveTextContent('按学部和时段发，至少勾一个学部或时段。')
    expect(writeOf(server.calls)).toEqual([])
  })

  it('withdraws a published broadcast after asking', async () => {
    const server = serve([published], {
      'POST api/broadcasts/7/withdraw': ok({ ...published, status: 'withdrawn', withdrawnAt: '2026-11-04T02:00:00.000Z' }),
    })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    show(<Broadcasts />)
    await user.click(await screen.findByRole('button', { name: published.title }))

    expect(editor().getByText('晚上 9 点开始。')).toBeInTheDocument()
    await user.click(editor().getByRole('button', { name: '撤回' }))
    const dialog = within(await screen.findByRole('dialog', { name: `撤回广播“${published.title}”？` }))
    await user.click(dialog.getByRole('button', { name: '撤回' }))

    expect(await screen.findByText('已撤回。插件不会再拿到这条广播；已经转告过的收不回来。')).toBeInTheDocument()
    expect(writeOf(server.calls).map((call) => `${call.method} ${call.path}`)).toEqual(['POST api/broadcasts/7/withdraw'])
    expect(editor().getByText('状态：已撤回')).toBeInTheDocument()
    expect(editor().queryByRole('button', { name: '撤回' })).not.toBeInTheDocument()
  })
})
