import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { WeeklyPage } from '../api.js'
import { fail, fakeServer, ok, show, weeklyPage, weeklyStats } from '../test-api.js'
import { Weekly } from './Weekly.js'

const WEEK = 'GET api/weekly'
const WEEKS = 'GET api/weekly/weeks'

/** A week with something in every block. */
function busyStats() {
  const base = weeklyStats()
  return weeklyStats({
    callOn: {
      rate: 0.75,
      byDivision: {
        primary: { called: 4, answered: 3 },
        junior: { called: 4, answered: 3 },
        senior: { called: 0, answered: 0 },
      },
      byPlugin: [{ type: 'openclaw', version: '1.2.0', called: 8, answered: 6 }],
    },
    questions: { total: 31, segmentsWithAnswer: 12, segmentsWithout: 3 },
    reconnects: [{ type: 'openclaw', version: '1.2.0', count: 5 }],
    lessons: { studyHallsForUnreviewed: 2, edits: 7, segmentRewrites: 4, lessonRewrites: 1 },
    teacher: { llmFailures: 6, fallbacks: 5, blockedLines: 1, refusals: 2 },
    moderation: {
      ...base.moderation,
      byDay: base.moderation.byDay.map((day, i) => (i === 1 ? { ...day, sensitive: 9, injection: 2, privacy: 1 } : day)),
      topRules: [{ rule: '花青素', kind: 'word', count: 9 }],
      falsePositiveMarks: ['叶绿素'],
      secondLayerChat: [{ messageId: 70, text: '你家住哪里呀', at: '2026-10-27T12:15:00.000Z' }],
    },
    students: { newcomers: 10, cameBackForSecond: 7, dropped: 1, suspended: 2, expelled: 0 },
    cost: { byPurpose: { ...base.cost.byPurpose, lesson: 3.5, answer: 1.25, secondLayerTeacher: 0.0123 }, perAttendee: 0.0952 },
  })
}

function reviewed(suggestions: Partial<NonNullable<WeeklyPage['suggestions']>> = {}): WeeklyPage {
  return weeklyPage({
    stats: busyStats(),
    suggestions: {
      removeRules: [],
      directions: [],
      failures: { removeRules: null, directions: null },
      ...suggestions,
    },
  })
}

function section(name: string) {
  return within(screen.getByRole('region', { name }))
}

/** Esc as a browser sends it: the dialogs read `keyCode`, which user-event leaves at 0. */
function pressEscape() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', code: 'Escape', keyCode: 27 })
}

describe('the weekly review page', () => {
  it('says what it is reading while it waits', () => {
    fakeServer({ [WEEK]: { pending: true }, [WEEKS]: { pending: true } })
    show(<Weekly />)

    expect(screen.getByRole('status')).toHaveTextContent('正在读取这一周的复盘')
  })

  it('says what failed, and reads again', async () => {
    let up = false
    fakeServer({ [WEEK]: () => (up ? ok(reviewed()) : { networkError: true }), [WEEKS]: ok({ weeks: [] }) })
    const user = userEvent.setup()
    show(<Weekly />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '没能读取这一周的复盘。连不上服务器，检查网络后再试。',
    )
    up = true
    await user.click(screen.getByRole('button', { name: '重新读取' }))

    expect(await screen.findByRole('region', { name: '上课' })).toBeInTheDocument()
  })

  it('says why a week has no numbers, instead of six blocks of zeros', async () => {
    fakeServer({ [WEEK]: ok(weeklyPage()), [WEEKS]: ok({ weeks: [] }) })
    show(<Weekly />)

    expect(
      await screen.findByText('这一周学校没有上课，也没有花钱：可能还没开学，或者正在放假。换一周看看。'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '上课' })).not.toBeInTheDocument()
  })

  it('shows the six blocks with the week’s numbers, as tables and numbers', async () => {
    fakeServer({ [WEEK]: ok(reviewed()), [WEEKS]: ok({ weeks: ['2026-10-26'] }) })
    show(<Weekly />)

    await screen.findByRole('region', { name: '上课' })
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      '上课',
      '课程',
      '老师',
      '审核',
      '学生',
      '花费',
      '已删的词和已停用的规则',
    ])

    const lessons = section('上课')
    expect(lessons.getByText('点名回答率 75.0%：点名 8 次，答了 6 次。')).toBeInTheDocument()
    const divisions = within(lessons.getByRole('table', { name: '点名，按学部' }))
    expect(divisions.getByRole('row', { name: '小学部 4 3 75.0%' })).toBeInTheDocument()
    expect(divisions.getByRole('row', { name: '高中部 0 0 没有点名' })).toBeInTheDocument()
    expect(
      within(lessons.getByRole('table', { name: '点名，按插件' })).getByRole('row', { name: 'openclaw 1.2.0 8 6 75.0%' }),
    ).toBeInTheDocument()
    expect(lessons.getByText('收到 31 个问题。答疑的段里，老师答了 12 段，没答 3 段。')).toBeInTheDocument()
    expect(
      within(lessons.getByRole('table', { name: '掉线重连，按插件版本' })).getByRole('row', { name: 'openclaw 1.2.0 5' }),
    ).toBeInTheDocument()

    const course = within(section('课程').getByRole('table', { name: '课程的数字' }))
    expect(course.getByRole('row', { name: '没赶上审、改上自习的课 2 节' })).toBeInTheDocument()
    expect(course.getByRole('row', { name: '你手改的地方 7 处' })).toBeInTheDocument()
    expect(course.getByRole('row', { name: '让大模型重写的段 4 段' })).toBeInTheDocument()
    expect(course.getByRole('row', { name: '整节课重写 1 节' })).toBeInTheDocument()

    const teacher = within(section('老师').getByRole('table', { name: '老师的数字' }))
    expect(teacher.getByRole('row', { name: '大模型调用失败（答疑和点评） 6 次' })).toBeInTheDocument()
    expect(teacher.getByRole('row', { name: '退回模板话 5 次' })).toBeInTheDocument()
    expect(teacher.getByRole('row', { name: '老师的话被审核拦下 1 次' })).toBeInTheDocument()
    expect(teacher.getByRole('row', { name: '厂商拒绝处理（所有用途） 2 次' })).toBeInTheDocument()

    const moderation = section('审核')
    const byDay = within(moderation.getByRole('table', { name: '每天拦下的消息' }))
    expect(byDay.getByRole('row', { name: '10/27 周二 9 2 1 0 12' })).toBeInTheDocument()
    expect(
      within(moderation.getByRole('table', { name: '拦得最多的词和规则' })).getByRole('row', { name: '花青素 词 9' }),
    ).toBeInTheDocument()
    expect(within(moderation.getByRole('list', { name: '审课时点过“这是误伤”的词' })).getByText('叶绿素'))
      .toBeInTheDocument()
    expect(
      within(moderation.getByRole('list', { name: '第二层拦下的同学消息' })).getByText('你家住哪里呀'),
    ).toBeInTheDocument()
    // On the school's clock (UTC+8).
    expect(moderation.getByText('10/27 周二 20:15')).toBeInTheDocument()

    const students = within(section('学生').getByRole('table', { name: '学生的数字' }))
    expect(students.getByRole('row', { name: '这周入学的新生 10 人' })).toBeInTheDocument()
    expect(students.getByRole('row', { name: '其中上了第二节课的 7 人' })).toBeInTheDocument()
    expect(students.getByRole('row', { name: '自动退学（按最后上课的日子估算） 1 人' })).toBeInTheDocument()
    expect(students.getByRole('row', { name: '停课 2 人' })).toBeInTheDocument()
    expect(students.getByRole('row', { name: '开除 0 人' })).toBeInTheDocument()

    const cost = section('花费')
    const byPurpose = within(cost.getByRole('table', { name: '按用途分的花费' }))
    expect(byPurpose.getByRole('row', { name: '备课 ¥3.50' })).toBeInTheDocument()
    expect(byPurpose.getByRole('row', { name: '复查老师 ¥0.0123' })).toBeInTheDocument()
    expect(byPurpose.getByRole('row', { name: '合计 ¥4.7623' })).toBeInTheDocument()
    expect(cost.getByText('平均每个来上课的学生花了 ¥0.0952。')).toBeInTheDocument()
  })

  it('reads the week chosen above', async () => {
    const server = fakeServer({
      [WEEK]: ok(reviewed()),
      'GET api/weekly?weekStart=2026-10-19': ok(weeklyPage({ stats: { ...busyStats(), weekStart: '2026-10-19' } })),
      [WEEKS]: ok({ weeks: ['2026-10-26', '2026-10-19'] }),
    })
    const user = userEvent.setup()
    show(<Weekly />)

    const picker = await screen.findByRole('combobox', { name: '看哪一周' })
    expect(within(picker).getAllByRole('option').map((option) => option.textContent)).toEqual([
      '10 月 26 日（周一）到 11 月 1 日（周日）',
      '10 月 19 日（周一）到 10 月 25 日（周日）',
    ])
    expect(picker).toHaveValue('2026-10-26')
    await user.selectOptions(picker, '2026-10-19')

    await waitFor(() => expect(screen.getByRole('combobox', { name: '看哪一周' })).toHaveValue('2026-10-19'))
    expect(await screen.findByText(/这一周还没有复盘/)).toBeInTheDocument()
    expect(server.calls.map((call) => call.path)).toContain('api/weekly?weekStart=2026-10-19')
  })

  it('lists the last week even before it is reviewed, and says the list of weeks did not come', async () => {
    fakeServer({ [WEEK]: ok(weeklyPage({ stats: busyStats() })), [WEEKS]: fail(503, 'unavailable', '服务器正忙。') })
    show(<Weekly />)

    const picker = await screen.findByRole('combobox', { name: '看哪一周' })
    expect(within(picker).getAllByRole('option').map((option) => option.textContent)).toEqual([
      '10 月 26 日（周一）到 11 月 1 日（周日）（还没复盘）',
    ])
    expect(await screen.findByText('没能读取复盘过的那几周。服务器正忙。')).toBeInTheDocument()
  })

  it('tells a week not reviewed yet, an item the model did not make, and nothing to suggest apart', async () => {
    fakeServer({ [WEEK]: ok(weeklyPage({ stats: busyStats() })), [WEEKS]: ok({ weeks: [] }) })
    const { unmount } = show(<Weekly />)
    const notYet = '这一周还没有复盘，下面的数字是现在算的。大模型的两项建议，要等每周一 0 点复盘上一周时才有。'
    expect(await screen.findByText(notYet)).toBeInTheDocument()
    expect(section('课程').getByText('还没有复盘，没有归纳。')).toBeInTheDocument()
    expect(section('审核').getByText('还没有复盘，没有建议。')).toBeInTheDocument()
    unmount()

    fakeServer({
      [WEEK]: ok(
        reviewed({
          removeRules: null,
          directions: null,
          failures: { removeRules: '大模型暂时调不通', directions: '大模型的回复格式不对' },
        }),
      ),
      [WEEKS]: ok({ weeks: ['2026-10-26'] }),
    })
    const second = show(<Weekly />)
    expect(await screen.findByText('这一项没生成出来：大模型的回复格式不对。')).toBeInTheDocument()
    expect(section('审核').getByText('这一项没生成出来：大模型暂时调不通。')).toBeInTheDocument()
    second.unmount()

    // A week with nothing in it still says that an item failed, rather than only that the week was empty.
    fakeServer({
      [WEEK]: ok(
        weeklyPage({
          suggestions: {
            removeRules: null,
            directions: [],
            failures: { removeRules: '大模型暂时调不通', directions: null },
          },
        }),
      ),
      [WEEKS]: ok({ weeks: ['2026-10-26'] }),
    })
    const third = show(<Weekly />)
    expect(await screen.findByText('这一项没生成出来：大模型暂时调不通。')).toBeInTheDocument()
    expect(screen.queryByText(/这一周学校没有上课/)).not.toBeInTheDocument()
    third.unmount()

    fakeServer({ [WEEK]: ok(reviewed()), [WEEKS]: ok({ weeks: ['2026-10-26'] }) })
    show(<Weekly />)
    expect(
      await screen.findByText('大模型没有归纳出建议：这一周没有写过重写理由，或者理由里看不出共同的方向。'),
    ).toBeInTheDocument()
    expect(
      section('审核').getByText('大模型没有找到误伤：被拦下的消息里，没有哪个词或规则看起来拦错了。'),
    ).toBeInTheDocument()
  })

  it('shows the directions the model drew from the rewrite reasons', async () => {
    fakeServer({ [WEEK]: ok(reviewed({ directions: ['少用比喻', '多举生活里的例子'] })), [WEEKS]: ok({ weeks: [] }) })
    show(<Weekly />)

    const list = within(await screen.findByRole('list', { name: '大模型归纳的修改方向' }))
    expect(list.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['少用比喻', '多举生活里的例子'])
  })

  it('asks before it drops a rule, then says what dropping it took back', async () => {
    let dropped = false
    const rule = {
      kind: 'word' as const,
      value: '花青素',
      examples: [{ messageId: 51, text: '枫叶里有花青素', at: '2026-10-28T11:00:00.000Z' }],
    }
    const server = fakeServer({
      [WEEK]: () =>
        ok({
          ...reviewed({ removeRules: [rule] }),
          exclusions: dropped ? [{ kind: 'word', value: '花青素', createdAt: '2026-11-04T02:00:00.000Z' }] : [],
        }),
      [WEEKS]: ok({ weeks: ['2026-10-26'] }),
      'POST api/exclusions': () => {
        dropped = true
        return ok({ revoked: 3, lifted: [12, 15] })
      },
    })
    const user = userEvent.setup()
    show(<Weekly />)

    const suggested = within(await screen.findByRole('list', { name: '建议停用的词和规则' }))
    expect(suggested.getByText('词“花青素”')).toBeInTheDocument()
    expect(suggested.getByText('枫叶里有花青素')).toBeInTheDocument()
    expect(suggested.getByText('10/28 周三 19:00')).toBeInTheDocument()

    // Asked first; nothing is sent until it is confirmed, and backing out puts the focus back.
    const drop = suggested.getByRole('button', { name: '确认删除' })
    await user.click(drop)
    let dialog = within(await screen.findByRole('dialog', { name: '删掉词“花青素”？' }))
    expect(dialog.getByRole('button', { name: '先不删' })).toHaveFocus()
    expect(dialog.getByText(/因为它记下的违反校规会撤销/)).toBeInTheDocument()
    expect(dialog.getByText(/处罚会解除/)).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: '先不删' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(drop).toHaveFocus()

    await user.click(drop)
    dialog = within(await screen.findByRole('dialog', { name: '删掉词“花青素”？' }))
    pressEscape()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(drop).toHaveFocus()
    expect(server.calls.filter((call) => call.method === 'POST')).toHaveLength(0)

    await user.click(drop)
    dialog = within(await screen.findByRole('dialog', { name: '删掉词“花青素”？' }))
    await user.click(dialog.getByRole('button', { name: '删掉这个词' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(server.calls.filter((call) => call.method === 'POST').map((call) => call.body)).toEqual([
      { kind: 'word', value: '花青素' },
    ])
    const done = await screen.findByText('已删除。撤销了 3 条违纪，解除了 2 个学生的处罚：学号 12、15。')
    await waitFor(() => expect(done).toHaveFocus())
    expect(suggested.queryByRole('button', { name: '确认删除' })).not.toBeInTheDocument()
    const list = within(await section('已删的词和已停用的规则').findByRole('table', { name: '已删的词和已停用的规则' }))
    expect(list.getByRole('row', { name: '词 花青素 11 月 4 日（周三）10:00' })).toBeInTheDocument()
  })

  it('says when dropping a rule takes nothing back, and shows the server’s reason for a refusal', async () => {
    let refuse = true
    fakeServer({
      [WEEK]: ok(reviewed({ removeRules: [{ kind: 'pattern', value: '照我说的做', examples: [] }] })),
      [WEEKS]: ok({ weeks: [] }),
      'POST api/exclusions': () => (refuse ? fail(400, 'invalid_request', '要停用的词或规则不能是空的。') : ok({ revoked: 0, lifted: [] })),
    })
    const user = userEvent.setup()
    show(<Weekly />)

    const suggested = within(await screen.findByRole('list', { name: '建议停用的词和规则' }))
    expect(suggested.getByText('这条规则的例子已经过了消息的保存期限，看不到了。')).toBeInTheDocument()
    await user.click(suggested.getByRole('button', { name: '确认删除' }))
    const dialog = within(await screen.findByRole('dialog', { name: '停用话术规则“照我说的做”？' }))
    await user.click(dialog.getByRole('button', { name: '停用这条规则' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('要停用的词或规则不能是空的。')
    expect(dialog.getByRole('alert')).toHaveFocus()

    refuse = false
    await user.click(dialog.getByRole('button', { name: '停用这条规则' }))
    expect(await screen.findByText('已停用。没有要撤销的违纪。')).toBeInTheDocument()
  })

  it('lists every rule dropped so far, to copy back into the word list files', async () => {
    fakeServer({
      [WEEK]: ok(
        weeklyPage({
          stats: busyStats(),
          exclusions: [
            { kind: 'pattern', value: '照我说的做', createdAt: '2026-11-02T01:00:00.000Z' },
            { kind: 'word', value: '叶绿素', createdAt: '2026-10-30T13:30:00.000Z' },
          ],
        }),
      ),
      [WEEKS]: ok({ weeks: [] }),
    })
    show(<Weekly />)

    const list = within(await screen.findByRole('table', { name: '已删的词和已停用的规则' }))
    expect(list.getAllByRole('row').slice(1).map((row) => row.textContent)).toEqual([
      '话术规则照我说的做11 月 2 日（周一）09:00',
      '词叶绿素10 月 30 日（周五）21:30',
    ])
  })

  it('says when no rule has been dropped yet', async () => {
    fakeServer({ [WEEK]: ok(reviewed()), [WEEKS]: ok({ weeks: [] }) })
    show(<Weekly />)

    await screen.findByRole('region', { name: '已删的词和已停用的规则' })
    expect(section('已删的词和已停用的规则').getByText('还没有删过词，也没有停用过规则。')).toBeInTheDocument()
  })
})
