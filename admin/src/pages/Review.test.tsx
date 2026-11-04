import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LESSON_QUEUE_PATH, useLoad, type LessonDetail, type LessonQueue } from '../api.js'
import { fail, fakeServer, lessonDetail, lessonQueue, ok, queueSlot, show } from '../test-api.js'
import { Review } from './Review.js'

function ReviewPage() {
  return <Review queue={useLoad<LessonQueue>(LESSON_QUEUE_PATH)} />
}

const THU = '2026-11-05'
const FRI = '2026-11-06'

const missing = { status: 'missing', lessonId: null, version: null } as const

const QUEUE = `GET ${LESSON_QUEUE_PATH}`

/** A queue of one day with one division: the primary lesson, as `slot` says. */
function oneLesson(slot: Parameters<typeof queueSlot>[1] = { status: 'pending' }): LessonQueue {
  return lessonQueue([{ date: THU, divisions: [queueSlot('primary', slot)] }])
}

/** The list of one day's three divisions. */
function day(name: string) {
  return within(screen.getByRole('list', { name }))
}

/** The row of a division in the list, found by what its button says. */
function row(name: string | RegExp) {
  const button = screen.getByRole('button', { name })
  return within(button.closest('li') as HTMLElement)
}

function lessonCalls(server: ReturnType<typeof fakeServer>, path: string) {
  return server.calls.filter((call) => call.path === path)
}

/**
 * A lesson flagged three ways: privacy in the gist of segment 1, a word in segment 3, and an anti-trick rule written
 * in plain words in the review question (the server says which kind each is).
 */
function flaggedLesson(lesson: Partial<LessonDetail> = {}) {
  return lessonDetail({
    flags: [
      { part: 'gist', index: 0, kind: 'privacy', rule: '隐私信息' },
      { part: 'segment', index: 2, kind: 'word', rule: '花青素' },
      { part: 'review', index: null, kind: 'pattern', rule: '照着我说的做' },
    ],
    ...lesson,
  })
}

/** The browser's clock on Wednesday 4 November, the day before the lessons of the fixtures. */
function today() {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-04T10:00:00+08:00'))
}

/** Esc as a browser sends it: the dialogs read `keyCode`, which user-event leaves at 0. */
function pressEscape() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', code: 'Escape', keyCode: 27 })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the review page', () => {
  it('says what it is reading, why the list is empty, and what failed', async () => {
    fakeServer({ [QUEUE]: { pending: true } })
    const { unmount } = show(<ReviewPage />)
    expect(screen.getByRole('status')).toHaveTextContent('正在读取这几天的课')
    unmount()

    fakeServer({ [QUEUE]: ok(lessonQueue([])) })
    const empty = show(<ReviewPage />)
    expect(await screen.findByText(/接下来几天都不上课/)).toBeInTheDocument()
    empty.unmount()

    fakeServer({ [QUEUE]: { networkError: true } })
    show(<ReviewPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent('没能读取这几天的课。连不上服务器，检查网络后再试。')
    expect(screen.getByRole('button', { name: '重新读取' })).toBeInTheDocument()
  })

  it('lists the days with where each division’s lesson stands', async () => {
    const failure = { attempts: 2, lastError: '大模型交回的段数不对' }
    fakeServer({
      [QUEUE]: ok(
        lessonQueue([
          {
            date: '2026-11-04',
            divisions: [
              queueSlot('primary', { status: 'approved', locked: true, lessonId: 11 }),
              queueSlot('junior', { status: 'pending', locked: true, lessonId: 12 }),
              queueSlot('senior', { ...missing, locked: true }),
            ],
          },
          {
            date: THU,
            divisions: [
              queueSlot('primary', { status: 'flagged', flags: 3, lessonId: 1 }),
              queueSlot('junior', { status: 'pending', lessonId: 2 }),
              queueSlot('senior', { status: 'approved', lessonId: 3, topic: '儿童节是怎么来的' }),
            ],
          },
          {
            date: FRI,
            divisions: [
              queueSlot('primary', missing),
              queueSlot('junior', { ...missing, generationFailed: failure }),
              queueSlot('senior', { status: 'pending', lessonId: 6, generationFailed: failure }),
            ],
          },
        ]),
      ),
      'GET api/lessons/1': ok(flaggedLesson()),
    })
    show(<ReviewPage />)

    await screen.findByRole('list', { name: '11 月 4 日（周三）' })
    // Each row's own button says the division and where its lesson stands.
    const rows = (name: string) =>
      day(name)
        .getAllByRole('listitem')
        .map((item) => item.querySelector('button')?.textContent)
    expect(rows('11 月 4 日（周三）')).toEqual(['小学部 已开课', '初中部 当天已定', '高中部 当天已定'])
    expect(rows('11 月 5 日（周四）')).toEqual(['小学部 红笔 3 处', '初中部 待审', '高中部 已通过'])
    expect(rows('11 月 6 日（周五）')).toEqual(['小学部 待生成', '初中部 生成失败', '高中部 待审，重新生成失败'])
    expect(row('高中部 已通过').getByText('题目：《儿童节是怎么来的》')).toBeInTheDocument()
    // In api mode a missing lesson is made by the model; only a failed one can be pasted in by hand.
    expect(row('小学部 待生成').queryByRole('button', { name: '粘贴结果' })).not.toBeInTheDocument()
    expect(row('初中部 生成失败').getByRole('button', { name: '粘贴结果' })).toBeInTheDocument()

    // The first lesson still to review opens.
    expect(screen.getByRole('button', { name: '小学部 红笔 3 处' })).toHaveAttribute('aria-current', 'true')
    expect(await screen.findByRole('heading', { level: 2, name: '秋天的叶子为什么会变色' })).toBeInTheDocument()
  })

  it('shows the segments with their gists, each call-on question after the segment the queue names', async () => {
    fakeServer({
      [QUEUE]: ok({
        ...lessonQueue([{ date: THU, divisions: [queueSlot('primary', { status: 'pending', lessonId: 1 })] }]),
        callOns: [
          { kind: 'review', afterSegment: 1 },
          { kind: 'extension', afterSegment: 3 },
        ],
      }),
      'GET api/lessons/1': ok(lessonDetail()),
    })
    show(<ReviewPage />)

    await screen.findByRole('heading', { level: 2, name: '秋天的叶子为什么会变色' })
    const sections = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)
    expect(sections.filter((name) => !/月/.test(name ?? ''))).toEqual([
      '第 1 段',
      '复习题',
      '第 2 段',
      '第 3 段',
      '引申题',
      '第 4 段',
      '第 5 段',
    ])
    const first = within(screen.getByRole('region', { name: '第 1 段' }))
    expect(first.getByRole('group', { name: '正文' })).toHaveTextContent('叶子里的叶绿素慢慢分解')
    expect(first.getByRole('group', { name: '要点' })).toHaveTextContent('绿色退去是叶绿素分解了')
    const review = within(screen.getByRole('region', { name: '复习题' }))
    expect(review.getByText('第 1 段讲完后点名问')).toBeInTheDocument()
    expect(review.getByRole('group', { name: '题目' })).toHaveTextContent('叶子变黄，是因为什么东西分解了？')
  })

  it('marks the flagged words with the red pen and notes every mark by the kind the server gives', async () => {
    const lesson = flaggedLesson()
    lesson.content.segments[3] = { text: '有人说这是 C++ 式的落叶。', gist: '落叶为了保住水分' }
    lesson.flags.push({ part: 'segment', index: 3, kind: 'word', rule: 'c++' })
    fakeServer({
      [QUEUE]: ok(oneLesson({ status: 'flagged', flags: 4 })),
      'GET api/lessons/1': ok(lesson),
    })
    show(<ReviewPage />)

    const third = within(await screen.findByRole('region', { name: '第 3 段' }))
    expect(third.getByText('花青素', { selector: 'mark' })).toBeInTheDocument()
    expect(third.getByText('词库命中“花青素”一词')).toBeInTheDocument()
    expect(third.getByRole('button', { name: '这是误伤' })).toHaveAccessibleDescription('词库命中“花青素”一词')
    // The gist of segment 3 has no mark of its own.
    expect(within(third.getByRole('group', { name: '要点' })).getByText('没有批注')).toBeInTheDocument()

    // A word with a pattern's characters in it is still a word, underlined as written.
    const fourth = within(screen.getByRole('region', { name: '第 4 段' }))
    expect(fourth.getByText('C++', { selector: 'mark' })).toBeInTheDocument()
    expect(fourth.getByText('词库命中“c++”一词')).toBeInTheDocument()

    // An anti-trick rule in plain words is still a rule: named as one, never printed, never underlined.
    const review = within(screen.getByRole('region', { name: '复习题' }))
    expect(review.getByText('命中一条防骗规则')).toBeInTheDocument()
    expect(screen.queryByText(/照着我说的做/)).not.toBeInTheDocument()
    expect(review.queryByText(/./, { selector: 'mark' })).not.toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '第 1 段' })).getByText('可能含有隐私信息')).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: '标题' })).getByText('没有批注')).toBeInTheDocument()
  })

  it('keeps 通过 out of reach while red marks remain, and says why', async () => {
    fakeServer({
      [QUEUE]: ok(oneLesson({ status: 'flagged', flags: 3 })),
      'GET api/lessons/1': ok(flaggedLesson()),
    })
    show(<ReviewPage />)

    expect(await screen.findByRole('button', { name: '通过，审下一节' })).toBeDisabled()
    expect(screen.getByText('还有 3 处红笔标记：改掉，或者点“这是误伤”，才能通过。')).toBeInTheDocument()
  })

  it('approves once the marks are called false positives, then opens the next lesson to review', async () => {
    let approved = false
    const queue = () =>
      lessonQueue([
        {
          date: THU,
          divisions: [
            queueSlot('primary', approved ? { status: 'approved' } : { status: 'flagged', flags: 1, lessonId: 1 }),
            queueSlot('junior', { status: 'approved', lessonId: 2 }),
            queueSlot('senior', { status: 'pending', lessonId: 3, locked: true }),
          ],
        },
        {
          date: FRI,
          divisions: [
            queueSlot('primary', missing),
            queueSlot('junior', { status: 'pending', lessonId: 5 }),
            queueSlot('senior', { status: 'pending', lessonId: 6 }),
          ],
        },
      ])
    const server = fakeServer({
      [QUEUE]: () => ok(queue()),
      'GET api/lessons/1': ok(lessonDetail({ flags: [{ part: 'segment', index: 2, kind: 'word', rule: '花青素' }] })),
      'POST api/lessons/1/false-positive': ok(lessonDetail({ version: 2, falsePositives: ['花青素'] })),
      'POST api/lessons/1/approve': () => {
        approved = true
        return ok(lessonDetail({ version: 2, approvedAt: '2026-11-04T08:00:00.000Z' }))
      },
      'GET api/lessons/5': ok(lessonDetail({ id: 5, date: FRI, division: 'junior', title: '水是怎么变成云的' })),
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    await user.click(await screen.findByRole('button', { name: '这是误伤' }))
    const approve = await screen.findByRole('button', { name: '通过，审下一节' })
    await waitFor(() => expect(approve).toBeEnabled())
    expect(screen.queryByText(/处红笔标记/)).not.toBeInTheDocument()
    await user.click(approve)

    // The approved, locked and missing slots are passed over; the next lesson's title takes the focus.
    expect(await screen.findByRole('heading', { level: 2, name: '水是怎么变成云的' })).toHaveFocus()
    expect(screen.getByRole('button', { name: '初中部 待审' })).toHaveAttribute('aria-current', 'true')
    const writes = server.calls.filter((call) => call.method === 'POST')
    expect(writes.map((call) => [call.path, call.body])).toEqual([
      ['api/lessons/1/false-positive', { baseVersion: 1, rule: '花青素' }],
      ['api/lessons/1/approve', { baseVersion: 2 }],
    ])
    // The list is read again, so it shows the approval.
    expect(await screen.findByRole('button', { name: '小学部 已通过' })).toBeInTheDocument()
  })

  it('says so when the last lesson to review is approved', async () => {
    let approved = false
    fakeServer({
      [QUEUE]: () =>
        ok(
          lessonQueue([
            {
              date: THU,
              divisions: [
                queueSlot('primary', { status: approved ? 'approved' : 'pending' }),
                queueSlot('junior', { status: 'approved', lessonId: 2 }),
                queueSlot('senior', missing),
              ],
            },
          ]),
        ),
      'GET api/lessons/1': ok(lessonDetail()),
      'POST api/lessons/1/approve': () => {
        approved = true
        return ok(lessonDetail({ approvedAt: '2026-11-04T08:00:00.000Z' }))
      },
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    await user.click(await screen.findByRole('button', { name: '通过，审下一节' }))

    expect(await screen.findByText('这几天要审的课都审完了。')).toHaveFocus()
    expect(screen.getByText('还有 1 节课没生成，系统生成好以后，会出现在左边等你审。')).toBeInTheDocument()
  })

  it('offers to paste today’s missing lesson, which the model no longer makes, and counts it apart', async () => {
    const TODAY = '2026-11-04'
    fakeServer({
      [QUEUE]: ok(
        lessonQueue([
          { date: TODAY, divisions: [queueSlot('primary', missing), queueSlot('junior', { ...missing, locked: true })] },
          { date: THU, divisions: [queueSlot('primary', missing)] },
        ]),
      ),
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    expect(await screen.findByText('还有 1 节课要手动补上：用左边那一行的“复制提示词”和“粘贴结果”。')).toBeInTheDocument()
    expect(screen.getByText('还有 1 节课没生成，系统生成好以后，会出现在左边等你审。')).toBeInTheDocument()
    // Today's row offers the paste in api mode; Thursday's waits for the model; the decided day offers nothing.
    const today = within(screen.getByRole('list', { name: '11 月 4 日（周三）' }))
    expect(today.getAllByRole('button', { name: '粘贴结果' })).toHaveLength(1)
    expect(within(screen.getByRole('list', { name: '11 月 5 日（周四）' })).queryByRole('button', { name: '粘贴结果' })).toBeNull()

    await user.click(today.getAllByRole('button', { name: /^小学部/ })[0]!)
    expect(await screen.findByText(/今天的课不会再自动生成了/)).toBeInTheDocument()
  })

  it('says a lesson of today will not be made again for its new topic', async () => {
    const TODAY = '2026-11-04'
    fakeServer({
      [QUEUE]: ok(
        lessonQueue([
          {
            date: TODAY,
            divisions: [queueSlot('primary', { status: 'pending', topic: '冬至', generationFailed: { attempts: 4, lastError: '大模型暂时不可用' } })],
          },
        ]),
      ),
      'GET api/lessons/1': ok(lessonDetail({ date: TODAY, topic: null })),
    })
    show(<ReviewPage />)

    expect(await screen.findByText('这一天指定了新题目《冬至》，可今天的课不会再按新题目生成了；这里是旧的内容。')).toBeInTheDocument()
    expect(screen.getByText('按新题目重新生成失败，试了 4 次。最后一次的原因：大模型暂时不可用。今天的课不会再重新生成了。')).toBeInTheDocument()
    expect(screen.getByText('今天的课不会再按新题目生成了，旧的内容也不能通过，这个学部今天上自习。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '通过，审下一节' })).toBeDisabled()
  })

  it('will not rewrite without a reason, then rewrites for the reason given and offers the one before', async () => {
    const reason = '太难懂了，换成小学生听得懂的说法'
    const rewritten = lessonDetail({
      version: 2,
      versions: [
        { version: 2, change: 'rewrite_segment', reason, segmentIndex: 1, createdAt: '2026-11-04T09:00:00.000Z' },
        ...lessonDetail().versions,
      ],
    })
    rewritten.content.segments[1] = { text: '黄颜色其实一直藏在叶子里。', gist: '黄色一直都在' }
    const server = fakeServer({
      [QUEUE]: ok(oneLesson()),
      'GET api/lessons/1': ok(lessonDetail()),
      'POST api/lessons/1/rewrite': ok(rewritten),
      'POST api/lessons/1/restore': ok(
        lessonDetail({
          version: 3,
          versions: [
            { version: 3, change: 'restore', reason: null, segmentIndex: null, createdAt: '2026-11-04T09:01:00.000Z' },
            ...rewritten.versions,
          ],
        }),
      ),
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    const second = within(await screen.findByRole('region', { name: '第 2 段' }))
    await user.click(second.getByRole('button', { name: '重写这段' }))
    await user.click(second.getByRole('button', { name: '请大模型重写' }))
    expect(second.getByRole('alert')).toHaveTextContent('先写重写的理由')
    expect(second.getByLabelText('重写的理由')).toHaveFocus()
    expect(server.calls.filter((call) => call.method === 'POST')).toEqual([])

    await user.type(second.getByLabelText('重写的理由'), reason)
    await user.click(second.getByRole('button', { name: '请大模型重写' }))

    expect(await second.findByText('黄颜色其实一直藏在叶子里。')).toBeInTheDocument()
    expect(second.queryByLabelText('重写的理由')).not.toBeInTheDocument()
    expect(second.getByRole('button', { name: '重写这段' })).toHaveFocus()
    expect(second.getByText(`理由：${reason}`)).toBeInTheDocument()
    await user.click(second.getByRole('button', { name: '换回上一版' }))

    expect(await second.findByText('叶子里本来就有黄色的胡萝卜素，夏天被绿色盖住了。')).toBeInTheDocument()
    expect(second.queryByRole('button', { name: '换回上一版' })).not.toBeInTheDocument()
    expect(second.getByRole('button', { name: '重写这段' })).toHaveFocus()
    expect(server.calls.filter((call) => call.method === 'POST').map((call) => [call.path, call.body])).toEqual([
      ['api/lessons/1/rewrite', { baseVersion: 1, kind: 'rewrite_segment', segmentIndex: 1, reason }],
      ['api/lessons/1/restore', { baseVersion: 2, toVersion: 1 }],
    ])
  })

  it('says a rewrite may take a while, and sends it once', async () => {
    const server = fakeServer({
      [QUEUE]: ok(oneLesson()),
      'GET api/lessons/1': ok(lessonDetail()),
      'POST api/lessons/1/rewrite': { pending: true },
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    await user.click(await screen.findByRole('button', { name: '整节课重写' }))
    await user.type(screen.getByLabelText('重写的理由'), '选题太窄了')
    await user.click(screen.getByRole('button', { name: '请大模型重写' }))

    expect(screen.getByText('大模型正在重写，可能要一分钟以上，别关这一页。')).toBeInTheDocument()
    const busy = screen.getByRole('button', { name: '正在重写' })
    expect(busy).toBeDisabled()
    await user.click(busy)
    expect(lessonCalls(server, 'api/lessons/1/rewrite')).toHaveLength(1)
    expect(lessonCalls(server, 'api/lessons/1/rewrite')[0]?.body).toEqual({
      baseVersion: 1,
      kind: 'rewrite_lesson',
      reason: '选题太窄了',
    })
  })

  it('offers to paste a rewrite by hand when the model is out of reach', async () => {
    fakeServer({
      [QUEUE]: ok(oneLesson()),
      'GET api/lessons/1': ok(lessonDetail()),
      'POST api/lessons/1/rewrite': fail(503, 'llm_unavailable', '大模型暂时调不通，稍后再试，或者改用手动粘贴。'),
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    const extension = within(await screen.findByRole('region', { name: '引申题' }))
    await user.click(extension.getByRole('button', { name: '重写这道题' }))
    await user.type(extension.getByLabelText('重写的理由'), '太难了')
    await user.click(extension.getByRole('button', { name: '请大模型重写' }))

    expect(await extension.findByRole('alert')).toHaveTextContent('大模型暂时调不通，稍后再试，或者改用手动粘贴。')
    expect(extension.getByRole('button', { name: '复制提示词' })).toBeInTheDocument()
    expect(extension.getByRole('button', { name: '粘贴结果' })).toBeInTheDocument()
  })

  it('says the lesson changed elsewhere, and reads it again', async () => {
    let reads = 0
    const server = fakeServer({
      [QUEUE]: ok(oneLesson()),
      'GET api/lessons/1': () => {
        reads++
        return ok(lessonDetail(reads === 1 ? {} : { version: 3 }))
      },
      'PUT api/lessons/1/parts': fail(409, 'stale_version', '这节课在别处改过了，刷新后再改。'),
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    const title = within(await screen.findByRole('group', { name: '标题' }))
    await user.click(title.getByRole('button', { name: '改字' }))
    const field = title.getByRole('textbox', { name: '标题' })
    await user.clear(field)
    await user.type(field, '叶子变色的秘密')
    await user.click(title.getByRole('button', { name: '保存改动' }))

    expect(await title.findByRole('alert')).toHaveTextContent('这节课在别处改过了，刷新后再改。')
    expect(title.getByRole('alert')).toHaveFocus()
    expect(lessonCalls(server, 'api/lessons/1/parts')[0]?.body).toEqual({
      baseVersion: 1,
      part: { part: 'title' },
      text: '叶子变色的秘密',
    })
    await user.click(title.getByRole('button', { name: '刷新' }))

    expect(await screen.findByText(/第 3 版/)).toBeInTheDocument()
    expect(title.queryByRole('alert')).not.toBeInTheDocument()
    // What was typed stays, to be saved again on the new version, with the cursor in it.
    expect(title.getByRole('textbox', { name: '标题' })).toHaveValue('叶子变色的秘密')
    expect(title.getByRole('textbox', { name: '标题' })).toHaveFocus()

    // Esc puts the box away, and the focus goes back to the button that opened it.
    await user.click(title.getByRole('textbox', { name: '标题' }))
    await user.keyboard('{Escape}')
    expect(title.queryByRole('textbox')).not.toBeInTheDocument()
    expect(title.getByRole('button', { name: '改字' })).toHaveFocus()
  })

  it('says the lesson has begun when a change comes too late', async () => {
    fakeServer({
      [QUEUE]: ok(oneLesson()),
      'GET api/lessons/1': ok(lessonDetail()),
      'POST api/lessons/1/approve': fail(409, 'lesson_locked', '这节课已经开课，不能再改。'),
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    await user.click(await screen.findByRole('button', { name: '通过，审下一节' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('这节课已经开课，不能再改。')
  })

  it('reads the lesson again when approving finds a red mark the word list has gained since, and shows it', async () => {
    let reads = 0
    const marked = { part: 'title' as const, index: null, kind: 'word' as const, rule: '新词' }
    fakeServer({
      [QUEUE]: ok(oneLesson()),
      'GET api/lessons/1': () => {
        reads++
        return ok(lessonDetail(reads > 1 ? { version: 2, flags: [marked] } : {}))
      },
      'POST api/lessons/1/approve': fail(409, 'lesson_has_flags', '这节课还有 1 处红笔标记，改掉或标为误伤以后才能通过'),
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    await user.click(await screen.findByRole('button', { name: '通过，审下一节' }))

    expect(await screen.findByRole('button', { name: /这是误伤/ })).toBeInTheDocument()
    expect(reads).toBe(2)
  })

  it('says the day has begun, with the focus, once the lesson read again is locked', async () => {
    let reads = 0
    fakeServer({
      [QUEUE]: ok(oneLesson()),
      'GET api/lessons/1': () => {
        reads++
        return ok(lessonDetail({ locked: reads > 1 }))
      },
      'POST api/lessons/1/approve': fail(409, 'lesson_locked', '这节课已经开课，不能再改。'),
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    await user.click(await screen.findByRole('button', { name: '通过，审下一节' }))

    const notice = await screen.findByText('这一天已经开课，这节课没赶在开门前通过，那天改上了自习。它不能再改了。')
    expect(notice).toHaveFocus()
    expect(screen.queryByRole('button', { name: '通过，审下一节' })).not.toBeInTheDocument()
  })

  it('moves the focus on from each 这是误伤 to the next, and to approving after the last', async () => {
    let lesson = flaggedLesson()
    fakeServer({
      [QUEUE]: ok(oneLesson({ status: 'flagged', flags: 3 })),
      'GET api/lessons/1': () => ok(lesson),
      'POST api/lessons/1/false-positive': (call) => {
        const { rule } = call.body as { rule: string }
        lesson = { ...lesson, version: lesson.version + 1, flags: lesson.flags.filter((flag) => flag.rule !== rule) }
        return ok(lesson)
      },
    })
    const user = userEvent.setup()
    show(<ReviewPage />)
    const wrong = (region: string) =>
      within(screen.getByRole('region', { name: region })).getByRole('button', { name: '这是误伤' })

    await screen.findByRole('region', { name: '第 1 段' })
    // In reading order: the gist of segment 1, the review question (after segment 2), segment 3.
    wrong('第 1 段').focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(wrong('复习题')).toHaveFocus())
    await user.keyboard('{Enter}')
    await waitFor(() => expect(wrong('第 3 段')).toHaveFocus())
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByRole('button', { name: '通过，审下一节' })).toHaveFocus())
  })

  it('puts the focus on why 通过 is held after the last 这是误伤, while the lesson is being remade', async () => {
    let lesson = lessonDetail({ topic: '落叶', flags: [{ part: 'segment', index: 2, kind: 'word', rule: '花青素' }] })
    fakeServer({
      [QUEUE]: ok(oneLesson({ status: 'flagged', flags: 1, topic: '冬至' })),
      'GET api/lessons/1': () => ok(lesson),
      'POST api/lessons/1/false-positive': () => {
        lesson = { ...lesson, version: 2, flags: [] }
        return ok(lesson)
      },
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    const region = within(await screen.findByRole('region', { name: '第 3 段' }))
    region.getByRole('button', { name: '这是误伤' }).focus()
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(screen.getByText('这节课正在按新题目重新生成，等新稿出来再审。')).toHaveFocus(),
    )
    expect(screen.getByRole('button', { name: '通过，审下一节' })).toBeDisabled()
  })

  it('reads the lesson again after a refused 这是误伤, and puts the focus back on the part', async () => {
    fakeServer({
      [QUEUE]: ok(oneLesson({ status: 'flagged', flags: 3 })),
      'GET api/lessons/1': ok(flaggedLesson()),
      'POST api/lessons/1/false-positive': fail(409, 'stale_version', '这节课在别处改过了，刷新后再改。'),
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    const first = within(await screen.findByRole('region', { name: '第 1 段' }))
    await user.click(first.getByRole('button', { name: '这是误伤' }))
    await user.click(await first.findByRole('button', { name: '刷新' }))

    expect(first.getByRole('group', { name: '要点' })).toHaveFocus()
  })

  it('starts no other change while one is under way, and keeps the box that waits for it', async () => {
    const server = fakeServer({
      [QUEUE]: ok(oneLesson()),
      'GET api/lessons/1': ok(lessonDetail()),
      'POST api/lessons/1/rewrite': { pending: true },
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    const second = within(await screen.findByRole('region', { name: '第 2 段' }))
    await user.click(second.getByRole('button', { name: '重写这段' }))
    await user.type(second.getByLabelText('重写的理由'), '太难懂了')
    await user.click(second.getByRole('button', { name: '请大模型重写' }))

    for (const name of ['改字', '重写这段', '重写这道题', '整节课重写', '通过，审下一节']) {
      for (const button of screen.getAllByRole('button', { name })) expect(button).toBeDisabled()
    }
    fireEvent.keyDown(second.getByLabelText('重写的理由'), { key: 'Escape' })
    expect(second.getByText('大模型正在重写，可能要一分钟以上，别关这一页。')).toBeInTheDocument()
    expect(server.calls.filter((call) => call.method !== 'GET')).toHaveLength(1)
  })

  it('sends one 这是误伤 at a time', async () => {
    const server = fakeServer({
      [QUEUE]: ok(oneLesson({ status: 'flagged', flags: 3 })),
      'GET api/lessons/1': ok(flaggedLesson()),
      'POST api/lessons/1/false-positive': { pending: true },
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    await user.click(within(await screen.findByRole('region', { name: '第 1 段' })).getByRole('button', { name: '这是误伤' }))
    for (const button of screen.getAllByRole('button', { name: '这是误伤' })) expect(button).toBeDisabled()
    await user.click(within(screen.getByRole('region', { name: '第 3 段' })).getByRole('button', { name: '这是误伤' }))
    expect(lessonCalls(server, 'api/lessons/1/false-positive')).toHaveLength(1)
  })

  it('shows a lesson of a day already begun without anything to change it', async () => {
    fakeServer({
      [QUEUE]: ok(oneLesson({ status: 'approved', locked: true })),
      'GET api/lessons/1': ok(lessonDetail({ locked: true, approvedAt: '2026-11-04T08:00:00.000Z' })),
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    await user.click(await screen.findByRole('button', { name: '小学部 已开课' }))

    expect(await screen.findByText('这节课已经开课，不能再改。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '改字' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '整节课重写' })).not.toBeInTheDocument()
  })

  it('moves through the list with the arrow keys', async () => {
    const server = fakeServer({
      [QUEUE]: ok(
        lessonQueue([
          {
            date: THU,
            divisions: [
              queueSlot('primary', { status: 'pending', lessonId: 1 }),
              queueSlot('junior', { status: 'approved', lessonId: 2 }),
              queueSlot('senior', missing),
            ],
          },
        ]),
      ),
      'GET api/lessons/1': ok(lessonDetail()),
      'GET api/lessons/2': ok(lessonDetail({ id: 2, division: 'junior', title: '水是怎么变成云的' })),
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    await screen.findByRole('heading', { level: 2, name: '秋天的叶子为什么会变色' })
    await user.tab()
    expect(screen.getByRole('button', { name: '小学部 待审' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')

    const junior = screen.getByRole('button', { name: '初中部 已通过' })
    expect(junior).toHaveFocus()
    expect(junior).toHaveAttribute('aria-current', 'true')
    expect(await screen.findByRole('heading', { level: 2, name: '水是怎么变成云的' })).toBeInTheDocument()
    expect(lessonCalls(server, 'api/lessons/2')).toHaveLength(1)

    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('button', { name: '高中部 待生成' })).toHaveFocus()
    expect(await screen.findByText('这节课还没有生成。')).toBeInTheDocument()
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(screen.getByRole('button', { name: '小学部 待审' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(screen.getByRole('button', { name: '高中部 待生成' })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(screen.getByRole('button', { name: '小学部 待审' })).toHaveFocus()
  })

  it('closes a reason box with Esc while nothing is being sent, and gives the focus back to its button', async () => {
    fakeServer({ [QUEUE]: ok(oneLesson()), 'GET api/lessons/1': ok(lessonDetail()) })
    const user = userEvent.setup()
    show(<ReviewPage />)

    const second = within(await screen.findByRole('region', { name: '第 2 段' }))
    await user.click(second.getByRole('button', { name: '重写这段' }))
    await user.type(second.getByLabelText('重写的理由'), '太难懂了')
    await user.keyboard('{Escape}')
    expect(second.queryByLabelText('重写的理由')).not.toBeInTheDocument()
    expect(second.getByRole('button', { name: '重写这段' })).toHaveFocus()
  })
})

describe('the review page in manual mode', () => {
  const manualQueue = (slot: Parameters<typeof queueSlot>[1]): LessonQueue => ({ ...oneLesson(slot), mode: 'manual' })

  it('copies the prompt of a lesson still to make', async () => {
    const server = fakeServer({
      [QUEUE]: ok(manualQueue(missing)),
      'GET api/prompts?kind=generate&date=2026-11-05&division=primary': ok({ text: '给小学部备一节自然课。' }),
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    const slot = await screen.findByRole('button', { name: '小学部 待生成' })
    await user.click(within(slot.closest('li') as HTMLElement).getByRole('button', { name: '复制提示词' }))

    expect(await row('小学部 待生成').findByText('已复制')).toBeInTheDocument()
    expect(await navigator.clipboard.readText()).toBe('给小学部备一节自然课。')
    expect(server.calls.map((call) => call.path)).toContain(
      'api/prompts?kind=generate&date=2026-11-05&division=primary',
    )
  })

  it('shows the prompt to copy by hand when the clipboard is out of reach', async () => {
    fakeServer({
      [QUEUE]: ok(manualQueue(missing)),
      'GET api/prompts?kind=generate&date=2026-11-05&division=primary': ok({ text: '给小学部备一节自然课。' }),
    })
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
    show(<ReviewPage />)

    await screen.findByRole('button', { name: '小学部 待生成' })
    await user.click(row('小学部 待生成').getByRole('button', { name: '复制提示词' }))

    const dialog = within(await screen.findByRole('dialog', { name: '复制提示词' }))
    expect(dialog.getByRole('textbox', { name: '提示词' })).toHaveValue('给小学部备一节自然课。')
    expect(dialog.getByRole('textbox', { name: '提示词' })).toHaveAttribute('readonly')
    await user.click(dialog.getByRole('textbox', { name: '提示词' }))
    pressEscape()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(row('小学部 待生成').getByRole('button', { name: '复制提示词' })).toHaveFocus()
  })

  it('gives the focus back to the 粘贴结果 that opened the dialog, closed with 关闭 or Esc', async () => {
    fakeServer({ [QUEUE]: ok(manualQueue(missing)) })
    const user = userEvent.setup()
    show(<ReviewPage />)

    const paste = await screen.findByRole('button', { name: '粘贴结果' })
    await user.click(paste)
    const dialog = within(await screen.findByRole('dialog', { name: '粘贴结果：11 月 5 日（周四）小学部' }))
    await user.click(dialog.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(paste).toHaveFocus()

    await user.click(paste)
    await user.click(within(await screen.findByRole('dialog')).getByRole('textbox', { name: '大模型的回复' }))
    pressEscape()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(paste).toHaveFocus()
  })

  it('takes a pasted lesson, showing the server’s reason under the box when it will not do', async () => {
    let pasted = false
    const server = fakeServer({
      [QUEUE]: () =>
        ok(manualQueue(pasted ? { status: 'pending', lessonId: 1 } : missing)),
      'POST api/lessons/paste': (call) => {
        if (!String((call.body as { pasted: string }).pasted).includes('{')) {
          return fail(422, 'lesson_format', '没有在粘贴的内容里找到 JSON')
        }
        pasted = true
        return ok(lessonDetail({ source: 'manual' }))
      },
      'GET api/lessons/1': ok(lessonDetail({ source: 'manual' })),
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    await screen.findByRole('button', { name: '小学部 待生成' })
    await user.click(row('小学部 待生成').getByRole('button', { name: '粘贴结果' }))
    const dialog = within(await screen.findByRole('dialog', { name: '粘贴结果：11 月 5 日（周四）小学部' }))
    await user.click(dialog.getByRole('textbox', { name: '大模型的回复' }))
    await user.paste('好的，这是课程。')
    await user.click(dialog.getByRole('button', { name: '存成待审的课' }))

    const reason = await dialog.findByRole('alert')
    expect(reason).toHaveTextContent('没有在粘贴的内容里找到 JSON')
    expect(reason).toHaveFocus()
    // The reason sits under the box.
    expect(dialog.getByRole('textbox', { name: '大模型的回复' }).compareDocumentPosition(reason)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )

    await user.clear(dialog.getByRole('textbox', { name: '大模型的回复' }))
    await user.paste('好的：{"title":"秋天的叶子为什么会变色"}')
    await user.click(dialog.getByRole('button', { name: '存成待审的课' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByRole('heading', { level: 2, name: '秋天的叶子为什么会变色' })).toHaveFocus()
    expect(screen.getByRole('button', { name: '小学部 待审' })).toHaveAttribute('aria-current', 'true')
    expect(lessonCalls(server, 'api/lessons/paste').map((call) => call.body)).toEqual([
      { kind: 'generate', date: THU, division: 'primary', pasted: '好的，这是课程。' },
      { kind: 'generate', date: THU, division: 'primary', pasted: '好的：{"title":"秋天的叶子为什么会变色"}' },
    ])
  })

  it('rewrites by copying the prompt with the reason and pasting the reply', async () => {
    const reason = '换一个生活里的例子'
    const promptPath =
      'api/prompts?kind=rewrite_call_on&date=2026-11-05&division=primary&lessonId=1&callOn=extension' +
      `&reason=${encodeURIComponent(reason)}`
    const server = fakeServer({
      [QUEUE]: ok(manualQueue({ status: 'pending', lessonId: 1 })),
      'GET api/lessons/1': ok(lessonDetail()),
      [`GET ${promptPath}`]: ok({ text: '重写引申题。' }),
      'POST api/lessons/paste': ok(lessonDetail({ version: 2 })),
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    const extension = within(await screen.findByRole('region', { name: '引申题' }))
    await user.click(extension.getByRole('button', { name: '重写这道题' }))
    expect(extension.queryByRole('button', { name: '请大模型重写' })).not.toBeInTheDocument()
    await user.click(extension.getByRole('button', { name: '复制提示词' }))
    expect(extension.getByRole('alert')).toHaveTextContent('先写重写的理由')

    await user.type(extension.getByLabelText('重写的理由'), reason)
    await user.click(extension.getByRole('button', { name: '复制提示词' }))
    expect(await extension.findByText('已复制')).toBeInTheDocument()
    expect(await navigator.clipboard.readText()).toBe('重写引申题。')

    // Closed without pasting: the focus is back on the box's own 粘贴结果.
    await user.click(extension.getByRole('button', { name: '粘贴结果' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(extension.getByRole('button', { name: '粘贴结果' })).toHaveFocus()

    await user.click(extension.getByRole('button', { name: '粘贴结果' }))
    const dialog = within(await screen.findByRole('dialog', { name: '粘贴结果：重写引申题' }))
    await user.click(dialog.getByRole('textbox', { name: '大模型的回复' }))
    await user.paste('{"extension":"为什么冬天的松树还是绿的？"}')
    await user.click(dialog.getByRole('button', { name: '换上重写的内容' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(lessonCalls(server, 'api/lessons/paste')[0]?.body).toEqual({
      kind: 'rewrite_call_on',
      date: THU,
      division: 'primary',
      lessonId: 1,
      callOn: 'extension',
      reason,
      baseVersion: 1,
      pasted: '{"extension":"为什么冬天的松树还是绿的？"}',
    })
  })
})

describe('giving a day a topic', () => {
  function topicQueue(): LessonQueue {
    return lessonQueue([
      {
        date: '2026-11-04',
        divisions: [
          queueSlot('primary', { status: 'approved', locked: true }),
          queueSlot('junior'),
          queueSlot('senior'),
        ],
      },
      {
        date: THU,
        divisions: [
          queueSlot('primary', { status: 'pending', lessonId: 1 }),
          queueSlot('junior', missing),
          queueSlot('senior', { ...missing, topic: '月亮为什么有圆缺' }),
        ],
      },
      {
        date: FRI,
        divisions: [
          queueSlot('primary', missing),
          queueSlot('junior', { status: 'approved', lessonId: 8 }),
          queueSlot('senior', missing),
        ],
      },
    ])
  }

  /** Picks `date` in the dialog's date field, as a browser's date picker sets it. */
  function pickDate(dialog: ReturnType<typeof within>, date: string) {
    fireEvent.change(dialog.getByLabelText('日期'), { target: { value: date } })
  }

  const NO_TOPICS = { 'GET api/topics': ok({ topics: [] }) }

  it('starts from the first lesson day after today, takes any later one, and asks first when the lesson was approved', async () => {
    today()
    const server = fakeServer({
      [QUEUE]: ok(topicQueue()),
      ...NO_TOPICS,
      'GET api/lessons/1': ok(lessonDetail()),
      'PUT api/topics/2026-11-06/junior': ok({ result: 'regenerating' }),
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    await user.click(await screen.findByRole('button', { name: '给某一天指定题目' }))
    const dialog = within(await screen.findByRole('dialog', { name: '给某一天指定题目' }))
    const day = dialog.getByLabelText('日期')
    expect(day).toHaveValue(THU)
    expect(day).toHaveAttribute('min', THU)
    expect(await dialog.findByText('明天以后还没有指定题目。')).toBeInTheDocument()
    pickDate(dialog, FRI)
    await user.click(within(dialog.getByRole('group', { name: '学部' })).getByRole('radio', { name: '初中部' }))
    await user.type(dialog.getByRole('textbox', { name: '题目' }), '冬至为什么吃饺子')
    await user.click(dialog.getByRole('button', { name: '指定这个题目' }))

    expect(dialog.getByText(/这节课会按新题目重写，需要重新审。/)).toHaveFocus()
    expect(lessonCalls(server, 'api/topics/2026-11-06/junior')).toHaveLength(0)
    await user.click(dialog.getByRole('button', { name: '按新题目重写' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(lessonCalls(server, 'api/topics/2026-11-06/junior').map((call) => call.body)).toEqual([
      { topic: '冬至为什么吃饺子' },
    ])
    expect(screen.getByRole('status')).toHaveTextContent(
      '已给 11/6 周五 初中部指定题目《冬至为什么吃饺子》。这节课已经回到待审，正在按新题目重新生成，新稿出来以后再审。',
    )
  })

  it('starts after the school’s today, whatever this computer’s clock says', async () => {
    // The computer still says Wednesday; the school has reached Thursday.
    today()
    fakeServer({ [QUEUE]: ok({ ...topicQueue(), today: THU }), ...NO_TOPICS, 'GET api/lessons/1': ok(lessonDetail()) })
    const user = userEvent.setup()
    show(<ReviewPage />)

    await user.click(await screen.findByRole('button', { name: '给某一天指定题目' }))
    const dialog = within(await screen.findByRole('dialog', { name: '给某一天指定题目' }))
    expect(dialog.getByLabelText('日期')).toHaveValue(FRI)
    expect(dialog.getByLabelText('日期')).toHaveAttribute('min', FRI)
  })

  it('gives a topic months ahead, lists the topics given, and takes one away from the list', async () => {
    today()
    const CHILDRENS_DAY = '2027-06-01'
    const server = fakeServer({
      [QUEUE]: ok(topicQueue()),
      'GET api/topics': ok({
        topics: [
          { date: '2026-11-04', division: 'junior', topic: '今天的题目' },
          { date: THU, division: 'senior', topic: '月亮为什么有圆缺' },
          { date: CHILDRENS_DAY, division: 'primary', topic: '儿童节是怎么来的' },
        ],
      }),
      'GET api/lessons/1': ok(lessonDetail()),
      'PUT api/topics/2027-06-05/primary': fail(422, 'topic_refused', '2027-06-05 不上课（周末、放假或还没开学），不能指定题目'),
      'PUT api/topics/2027-06-01/junior': ok({ result: 'stored' }),
      'PUT api/topics/2027-06-01/primary': ok({ result: 'stored' }),
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    await user.click(await screen.findByRole('button', { name: '给某一天指定题目' }))
    let dialog = within(await screen.findByRole('dialog', { name: '给某一天指定题目' }))
    const list = within(await dialog.findByRole('list', { name: '已经指定的题目' }))
    // Today's lesson is settled: its topic is not listed.
    expect(list.getAllByRole('button').map((b) => b.textContent)).toEqual([
      '11/5 周四 高中部《月亮为什么有圆缺》',
      '6/1 周二 小学部《儿童节是怎么来的》',
    ])

    // A Saturday: the server says why not.
    pickDate(dialog, '2027-06-05')
    await user.type(dialog.getByRole('textbox', { name: '题目' }), '周末的题目')
    await user.click(dialog.getByRole('button', { name: '指定这个题目' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('2027-06-05 不上课')

    pickDate(dialog, CHILDRENS_DAY)
    await user.click(within(dialog.getByRole('group', { name: '学部' })).getByRole('radio', { name: '初中部' }))
    await user.type(dialog.getByRole('textbox', { name: '题目' }), '六一的由来')
    await user.click(dialog.getByRole('button', { name: '指定这个题目' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(lessonCalls(server, 'api/topics/2027-06-01/junior').map((call) => call.body)).toEqual([{ topic: '六一的由来' }])
    expect(screen.getByRole('status')).toHaveTextContent('已给 6/1 周二 初中部指定题目《六一的由来》。')

    await user.click(screen.getByRole('button', { name: '给某一天指定题目' }))
    dialog = within(await screen.findByRole('dialog', { name: '给某一天指定题目' }))
    const picked = await dialog.findByRole('button', { name: '6/1 周二 小学部《儿童节是怎么来的》' })
    await user.click(picked)
    expect(picked).toHaveAttribute('aria-pressed', 'true')
    expect(dialog.getByLabelText('日期')).toHaveValue(CHILDRENS_DAY)
    expect(within(dialog.getByRole('group', { name: '学部' })).getByRole('radio', { name: '小学部' })).toBeChecked()
    expect(dialog.getByRole('textbox', { name: '题目' })).toHaveValue('儿童节是怎么来的')
    await user.click(dialog.getByRole('button', { name: '取消题目' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(lessonCalls(server, 'api/topics/2027-06-01/primary').map((call) => call.body)).toEqual([{ topic: null }])
  })

  it('says when the topics given could not be read, and reads them again', async () => {
    today()
    let fail_ = true
    fakeServer({
      [QUEUE]: ok(topicQueue()),
      'GET api/topics': () => (fail_ ? { networkError: true } : ok({ topics: [] })),
      'GET api/lessons/1': ok(lessonDetail()),
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    await user.click(await screen.findByRole('button', { name: '给某一天指定题目' }))
    const dialog = within(await screen.findByRole('dialog', { name: '给某一天指定题目' }))
    expect(await dialog.findByText(/没能读取已经指定的题目。连不上服务器/)).toBeInTheDocument()
    fail_ = false
    await user.click(dialog.getByRole('button', { name: '重新读取' }))
    expect(await dialog.findByText('明天以后还没有指定题目。')).toBeInTheDocument()
  })

  it('takes a topic away, shows the server’s reason for a refusal, and closes with Esc', async () => {
    today()
    const server = fakeServer({
      [QUEUE]: ok(topicQueue()),
      ...NO_TOPICS,
      'GET api/lessons/1': ok(lessonDetail()),
      'PUT api/topics/2026-11-05/senior': ok({ result: 'stored' }),
      'PUT api/topics/2026-11-05/primary': fail(422, 'topic_refused', '题目不能为空'),
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    await user.click(await screen.findByRole('button', { name: '给某一天指定题目' }))
    let dialog = within(await screen.findByRole('dialog', { name: '给某一天指定题目' }))
    await user.click(within(dialog.getByRole('group', { name: '学部' })).getByRole('radio', { name: '高中部' }))
    expect(dialog.getByRole('textbox', { name: '题目' })).toHaveValue('月亮为什么有圆缺')
    await user.click(dialog.getByRole('button', { name: '取消题目' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(lessonCalls(server, 'api/topics/2026-11-05/senior').map((call) => call.body)).toEqual([{ topic: null }])
    expect(screen.getByRole('status')).toHaveTextContent('已取消 11/5 周四 高中部的题目。')
    expect(screen.getByRole('button', { name: '给某一天指定题目' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: '给某一天指定题目' }))
    dialog = within(await screen.findByRole('dialog', { name: '给某一天指定题目' }))
    await user.type(dialog.getByRole('textbox', { name: '题目' }), '   ')
    await user.click(dialog.getByRole('button', { name: '指定这个题目' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('题目不能为空')
    expect(dialog.getByRole('alert')).toHaveFocus()

    pressEscape()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '给某一天指定题目' })).toHaveFocus()
  })

  it('opens a lesson a new topic took back to review, and holds its approval until the new one is made', async () => {
    today()
    let stage: 'reviewing' | 'done' | 'remaking' = 'reviewing'
    const friday = { status: 'approved', lessonId: 8 } as const
    fakeServer({
      [QUEUE]: () =>
        ok(
          lessonQueue([
            {
              date: THU,
              divisions: [queueSlot('primary', { status: stage === 'reviewing' ? 'pending' : 'approved' })],
            },
            {
              date: FRI,
              divisions: [
                queueSlot('junior', stage === 'remaking' ? { ...friday, status: 'pending', topic: '冬至' } : friday),
              ],
            },
          ]),
        ),
      'GET api/lessons/1': ok(lessonDetail()),
      'POST api/lessons/1/approve': () => {
        stage = 'done'
        return ok(lessonDetail({ approvedAt: '2026-11-04T02:00:00.000Z' }))
      },
      'PUT api/topics/2026-11-06/junior': () => {
        stage = 'remaking'
        return ok({ result: 'regenerating' })
      },
      'GET api/lessons/8': ok(lessonDetail({ id: 8, date: FRI, division: 'junior', title: '水是怎么变成云的' })),
      ...NO_TOPICS,
    })
    const user = userEvent.setup()
    show(<ReviewPage />)

    await user.click(await screen.findByRole('button', { name: '通过，审下一节' }))
    expect(await screen.findByText('这几天要审的课都审完了。')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '给某一天指定题目' }))
    const dialog = within(await screen.findByRole('dialog', { name: '给某一天指定题目' }))
    pickDate(dialog, FRI)
    await user.click(within(dialog.getByRole('group', { name: '学部' })).getByRole('radio', { name: '初中部' }))
    await user.type(dialog.getByRole('textbox', { name: '题目' }), '冬至')
    await user.click(dialog.getByRole('button', { name: '指定这个题目' }))
    await user.click(dialog.getByRole('button', { name: '按新题目重写' }))

    // The list says 待审 again: the page opens it rather than saying all is reviewed, and leaves the focus alone.
    expect(await screen.findByRole('heading', { level: 2, name: '水是怎么变成云的' })).toBeInTheDocument()
    expect(screen.queryByText('这几天要审的课都审完了。')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '给某一天指定题目' })).toHaveFocus()
    expect(screen.getByRole('button', { name: '通过，审下一节' })).toBeDisabled()
    expect(screen.getByText('这节课正在按新题目重新生成，等新稿出来再审。')).toBeInTheDocument()
  })
})
