import { Badge, Button, Card, Input, PageActions, RadioGroup, TABLE, TBODY, TD, TH, TextArea, type Tone } from '../ui.js'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  createNotice,
  deleteNotice,
  editNotice,
  NOTICES_PATH,
  publishNotice,
  request,
  useLoad,
  withdrawNotice,
  type ApiError,
  type NoticeContent,
  type NoticeKind,
  type NoticeView,
} from '../api.js'
import { Confirm } from '../components/Confirm.js'
import { Empty, Failed, Loading } from '../components/States.js'
import { useFocusOnMount } from '../focus.js'
import { clockInput, dayMoment, instantOf, moment, NOTICE_KIND_NAMES, NOTICE_STATUS_NAMES } from '../labels.js'
import { NoticeBody } from '../notice-markdown.js'
import { useSchoolZone } from '../zone.js'

// 公告: the notices the website shows, drawn after HyperUI's orders page and settings form. The list is a table with
// the status of each notice as a badge, newest first as the server orders them; one is opened to edit it, below the
// list, in a form of labelled sections beside the preview of how the website will show it. A notice is written as a draft, published, withdrawn and published again; only a
// draft can be deleted, so one that was ever out stays on record. Times are entered and shown on the school's clock
// and sent in UTC. What the page checks before sending is what the server checks; a refusal is still said in the
// server's words.

const MAX_TITLE = 60
const MAX_BODY = 4000

/** Says what an action did; it takes the focus the button that did it had. */
function Done({ text }: { text: string }) {
  const self = useFocusOnMount<HTMLParagraphElement>()
  return (
    <p
      ref={self}
      tabIndex={-1}
      className="mt-4 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800"
      role="status"
    >
      {text}
    </p>
  )
}

/**
 * What stops the notice from being sent (a status: it follows the typing, so it is not read out at each key), or the
 * server's refusal (an alert). It takes the focus when it appears, so a press that was stopped is read out.
 */
function Problems({ lines, role }: { lines: string[]; role: 'status' | 'alert' }) {
  const self = useFocusOnMount<HTMLDivElement>()
  return (
    <div
      ref={self}
      tabIndex={-1}
      className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
      role={role}
    >
      {lines.length === 1 ? (
        <p>{lines[0]}</p>
      ) : (
        <ul className="list-disc space-y-0.5 pl-5">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Text the server can store as it is: no NUL, and no lone half of a surrogate pair. */
const storable = (text: string) =>
  !text.includes('\u0000') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)

/** Characters as the server counts them: code points. */
const length = (text: string) => [...text].length

/**
 * A time field read on the school's clock: the instant (UTC ISO), or null when it is empty; `problem` says what is
 * wrong with it. The server takes years 2000 to 9999, counted in UTC.
 */
function readTime(label: string, input: string, zone: string): { at: string | null; problem?: string } {
  if (input === '') return { at: null }
  const outOfRange = { at: null, problem: `${label}要在 2000 年到 9999 年之间。` }
  // The year as written first: a field takes years of any number of digits.
  const written = Number(/^(\d+)-/.exec(input)?.[1] ?? NaN)
  if (written < 2000 || written > 9999) return outOfRange
  const at = instantOf(input, zone)
  if (at === null) return { at: null, problem: `${label}的时间不对，学校时区里没有这个时间。` }
  const year = new Date(at).getUTCFullYear()
  if (year < 2000 || year > 9999) return outOfRange
  return { at }
}

type Action = 'save' | 'publish' | 'withdraw'

/** The colour of a notice's status: a draft grey, out on the website green, taken down yellow. */
const STATUS_TONES: Record<NoticeView['status'], Tone> = { draft: 'gray', published: 'green', withdrawn: 'yellow' }

const LABEL = 'block text-sm font-medium text-gray-700'
const HINT = 'mt-1 text-xs text-gray-600'

/** One part of the form, as the settings template draws it: what it is on the left, its fields on the right. */
function FormSection({ title, about, children }: { title: string; about: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-6 py-6">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        <p className="mt-1 text-sm text-gray-600">{about}</p>
      </div>
      <div className="col-span-2 space-y-4">{children}</div>
    </div>
  )
}

function NoticeEditor({
  initial,
  dirtyRef,
  onChanged,
  onDeleted,
  onClose,
}: {
  /** Null for a new notice. */
  initial: NoticeView | null
  /** Kept up to date with whether the form has changes not saved, for the page to ask before dropping them. */
  dirtyRef: { current: boolean }
  /** The notice changed on the server, or a refusal says the list may be out of date: the list is read again. */
  onChanged: () => void
  onDeleted: () => void
  onClose: () => void
}) {
  const zone = useSchoolZone()
  const ids = {
    title: useId(),
    heading: useId(),
    body: useId(),
    bodyHint: useId(),
    starts: useId(),
    ends: useId(),
    published: useId(),
    publishedHint: useId(),
  }
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const [notice, setNotice] = useState(initial)
  // The notice as last taken from the server, for what is done between two renders.
  const latest = useRef(initial)
  const timeInput = (at: string | null | undefined) => (at == null ? '' : clockInput(at, zone))
  const [title, setTitle] = useState(initial?.title ?? '')
  const [kind, setKind] = useState<NoticeKind>(initial?.kind ?? 'general')
  const [starts, setStarts] = useState(timeInput(initial?.startsAt))
  const [ends, setEnds] = useState(timeInput(initial?.endsAt))
  const [body, setBody] = useState(initial?.body ?? '')
  const [published, setPublished] = useState(timeInput(initial?.publishedAt))
  const [sending, setSending] = useState<Action>()
  // Counts the presses stopped by the checks since the last save: the checks show from the first.
  const [tried, setTried] = useState(0)
  const [failure, setFailure] = useState<{ text: string; n: number }>()
  const [done, setDone] = useState<{ text: string; n: number }>()
  const [deleting, setDeleting] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const withdrawButton = useRef<HTMLButtonElement>(null)

  const status = notice?.status ?? null
  const maintenance = kind === 'maintenance'
  const wasOut = status === 'published' || status === 'withdrawn'
  const trimmed = title.trim()

  /**
   * A time field: one left as the notice has it is that very instant (a time the clock shows twice, when it is put
   * back, would otherwise be read as the first); any other is read on the school's clock.
   */
  const timeField = (label: string, input: string, saved: string | null | undefined) =>
    input !== '' && saved != null && input === timeInput(saved) ? { at: saved } : readTime(label, input, zone)
  const start = timeField('维护开始', starts, notice?.startsAt)
  const end = timeField('维护结束', ends, notice?.endsAt)
  const publication = timeField('发布时间', published, notice?.publishedAt)

  const dirty =
    trimmed !== (notice?.title ?? '') ||
    kind !== (notice?.kind ?? 'general') ||
    body !== (notice?.body ?? '') ||
    (maintenance && (starts !== timeInput(notice?.startsAt) || ends !== timeInput(notice?.endsAt))) ||
    (wasOut && published !== timeInput(notice?.publishedAt))
  useEffect(() => {
    dirtyRef.current = dirty
  })

  // Everything the server would refuse, in the order of the form.
  const problems: string[] = []
  if (!storable(title)) problems.push('标题里有存不了的字符（NUL 或半个字符），删掉再试。')
  else if (trimmed === '') problems.push('标题不能空着。')
  else if (length(trimmed) > MAX_TITLE) problems.push(`标题最多 ${MAX_TITLE} 字，现在 ${length(trimmed)} 字。`)
  if (maintenance) {
    if (starts === '') problems.push('维护公告要写开始时间。')
    if (start.problem !== undefined) problems.push(start.problem)
    if (end.problem !== undefined) problems.push(end.problem)
    if (start.at !== null && end.at !== null && end.at <= start.at) problems.push('维护结束要晚于开始。')
  }
  if (!storable(body)) problems.push('正文里有存不了的字符（NUL 或半个字符），删掉再试。')
  else if (length(body) > MAX_BODY) problems.push(`正文最多 ${MAX_BODY} 字，现在 ${length(body)} 字。`)
  if (wasOut) {
    if (published === '') problems.push('发布时间不能空着。')
    else if (publication.problem !== undefined) problems.push(publication.problem)
    else if (publication.at !== null && new Date(publication.at).getTime() > Date.now()) {
      problems.push('发布时间不能晚于现在。')
    }
  }

  /**
   * Takes the notice as the server now has it (null: it is gone). The form keeps what was written; only a publication
   * time left as it was follows the server's.
   */
  function take(next: NoticeView | null) {
    const before = timeInput(latest.current?.publishedAt)
    setPublished((input) => (input === before ? timeInput(next?.publishedAt) : input))
    latest.current = next
    setNotice(next)
  }

  /** After a refusal: the list is read again, and a notice whose state was not what the page thought is read anew. */
  async function resync(error: ApiError, id: number | undefined) {
    onChanged()
    if (id === undefined || (error.status !== 404 && error.status !== 409)) return
    try {
      const { notices } = await request<{ notices: NoticeView[] }>('GET', NOTICES_PATH)
      take(notices.find((one) => one.id === id) ?? null)
    } catch {
      // The list says it could not be read; the editor stays as it was.
    }
  }

  /** Saves what the form says: a new draft, or the whole notice replaced. */
  async function save(): Promise<NoticeView> {
    const content: NoticeContent = {
      title: trimmed,
      body,
      kind,
      ...(maintenance ? { startsAt: start.at, endsAt: end.at } : {}),
    }
    if (notice === null) return createNotice(content)
    // The publication time is sent only when it was changed: it corrects when the notice went out.
    const correction =
      wasOut && published !== timeInput(notice.publishedAt) && publication.at !== null
        ? { publishedAt: publication.at }
        : {}
    return editNotice(notice.id, { ...content, ...correction })
  }

  async function act(action: Action, confirmed = false) {
    setFailure(undefined)
    setDone(undefined)
    if (action === 'withdraw' && dirty && !confirmed) {
      setWithdrawing(true)
      return
    }
    if (action !== 'withdraw' && problems.length > 0) {
      setTried((n) => n + 1)
      return
    }
    setSending(action)
    const say = (text: string) => setDone((last) => ({ text, n: (last?.n ?? 0) + 1 }))
    const refuse = (text: string, error: ApiError, id: number | undefined) => {
      setFailure((last) => ({ text: `${text}${error.message}`, n: (last?.n ?? 0) + 1 }))
      void resync(error, id)
    }
    try {
      if (action === 'withdraw') {
        if (notice === null) return
        try {
          take(await withdrawNotice(notice.id))
          onChanged()
          say(`已撤下。网站上不再显示这条公告。${dirty ? '表单里的修改还没保存。' : ''}`)
        } catch (error) {
          refuse('没能撤下：', error as ApiError, notice.id)
        }
        return
      }
      let saved: NoticeView
      try {
        saved = await save()
      } catch (error) {
        refuse('没能保存：', error as ApiError, notice?.id)
        return
      }
      take(saved)
      setTried(0)
      onChanged()
      if (action === 'save') {
        say(saved.status === 'draft' ? '草稿已保存。' : '修改已保存。')
        return
      }
      // Published meanwhile (in another window, say): there is nothing to publish.
      if (saved.status === 'published') {
        say('已保存。这条公告已经是发布状态。')
        return
      }
      const again = saved.status === 'withdrawn'
      try {
        take(await publishNotice(saved.id))
        onChanged()
        say(again ? '已重新发布，发布时间还是第一次发布的时间。' : '已发布。')
      } catch (error) {
        refuse(again ? '修改已保存，但没能重新发布：' : '草稿已保存，但没能发布：', error as ApiError, saved.id)
      }
    } finally {
      setSending(undefined)
    }
  }

  const button = (action: Action, label: string, busy: string, primary = false) => (
    <Button
      ref={action === 'withdraw' ? withdrawButton : undefined}
      type={primary ? 'primary' : 'default'}
      onClick={() => act(action)}
      disabled={sending !== undefined}
    >
      {sending === action ? busy : label}
    </Button>
  )

  return (
    <section className="rounded-lg border border-gray-200 bg-white" aria-labelledby={ids.heading}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-6 py-4">
        <div className="flex items-center gap-3">
          <h2 id={ids.heading} ref={heading} tabIndex={-1} className="text-base font-semibold text-gray-900">
            {notice === null ? '写新公告' : '编辑公告'}
          </h2>
          <Badge tone={status === null ? 'gray' : STATUS_TONES[status]}>
            状态：{status === null ? '还没保存' : NOTICE_STATUS_NAMES[status]}
          </Badge>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-6 px-6">
        <div className="col-span-2 divide-y divide-gray-200">
          <FormSection title="标题和类型" about="标题会显示在网站的公告列表里。维护公告还要写维护的时间。它只是通知大家，不会让学校进入维护；到时候要在“开关”页点“开始维护”。">
            <div>
              <label className={LABEL} htmlFor={ids.title}>
                标题
              </label>
              <Input id={ids.title} className="mt-1" value={title} onChange={(event) => setTitle(event.target.value)} />
            </div>
            <fieldset>
              <legend className={LABEL}>类型</legend>
              <div className="mt-1">
                <RadioGroup
                  value={kind}
                  onChange={(event) => setKind(event.target.value as NoticeKind)}
                  options={(Object.keys(NOTICE_KIND_NAMES) as NoticeKind[]).map((key) => ({
                    value: key,
                    label: NOTICE_KIND_NAMES[key],
                  }))}
                />
              </div>
            </fieldset>
          </FormSection>
          {(maintenance || wasOut) && (
            <FormSection title="时间" about={`时间都按学校时区（${zone}）填写。`}>
              {maintenance && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={LABEL} htmlFor={ids.starts}>
                      维护开始
                    </label>
                    <Input
                      id={ids.starts}
                      type="datetime-local"
                      className="mt-1"
                      value={starts}
                      onChange={(event) => setStarts(event.target.value)}
                    />
                  </div>
                  <div>
                    <label className={LABEL} htmlFor={ids.ends}>
                      维护结束（可以不填）
                    </label>
                    <Input
                      id={ids.ends}
                      type="datetime-local"
                      className="mt-1"
                      value={ends}
                      onChange={(event) => setEnds(event.target.value)}
                    />
                  </div>
                </div>
              )}
              {wasOut && (
                <div>
                  <label className={LABEL} htmlFor={ids.published}>
                    发布时间
                  </label>
                  <Input
                    id={ids.published}
                    type="datetime-local"
                    className="mt-1"
                    aria-describedby={ids.publishedHint}
                    value={published}
                    onChange={(event) => setPublished(event.target.value)}
                  />
                  <p id={ids.publishedHint} className={HINT}>
                    第一次发布的时间，撤下再发布不变。补发的公告可以改早，不能晚于现在。
                  </p>
                </div>
              )}
            </FormSection>
          )}
          <FormSection title="正文" about={`最多 ${MAX_BODY} 字。右边的预览就是网站上的样子。`}>
            <div>
              <label className={LABEL} htmlFor={ids.body}>
                正文
              </label>
              <TextArea
                id={ids.body}
                className="mt-1"
                aria-describedby={ids.bodyHint}
                value={body}
                autoSize={{ minRows: 8, maxRows: 20 }}
                onChange={(event) => setBody(event.target.value)}
              />
              <p id={ids.bodyHint} className={HINT}>
                最多 {MAX_BODY} 字。空一行分段；行首写“- ”是列表；**加粗**；[文字](https://…) 是链接，只认 https://，地址里的 ) 要写成 %29。别的写法照原样显示。
              </p>
            </div>
          </FormSection>
        </div>
        <div className="py-6">
          <section className="sticky top-6 rounded-lg border border-gray-200 bg-gray-50 p-5" aria-label="预览">
            <p className="text-xs font-medium tracking-wide text-gray-600">预览</p>
            <h3 className="mt-2 text-lg font-semibold break-words text-gray-900">
              {trimmed === '' ? '（还没写标题）' : trimmed}
            </h3>
            {maintenance && start.at !== null && (
              <p className="mt-1 text-sm text-gray-600">
                维护时间：{dayMoment(start.at, zone)}
                {end.at === null ? ' 开始' : ` 到 ${dayMoment(end.at, zone)}`}
              </p>
            )}
            <div className="mt-3 text-sm leading-relaxed text-gray-800">
              <NoticeBody body={body} />
            </div>
          </section>
        </div>
      </div>
      <div className="px-6">
        {/* Keyed by the try, so each one that is stopped takes the focus anew. */}
        {tried > 0 && problems.length > 0 && <Problems key={`check-${tried}`} lines={problems} role="status" />}
        {failure !== undefined && <Problems key={`refusal-${failure.n}`} lines={[failure.text]} role="alert" />}
        {done !== undefined && <Done key={done.n} text={done.text} />}
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-end gap-2 rounded-b-lg border-t border-gray-200 bg-gray-50 px-6 py-4">
        <Button onClick={onClose} disabled={sending !== undefined}>
          关闭
        </Button>
        {status === 'draft' && (
          <Button ref={deleteButton} type="danger" onClick={() => setDeleting(true)} disabled={sending !== undefined}>
            删除草稿
          </Button>
        )}
        {(status === null || status === 'draft') && (
          <>
            {button('save', '保存草稿', '正在保存')}
            {button('publish', '发布', '正在发布', true)}
          </>
        )}
        {status === 'published' && (
          <>
            {button('withdraw', '撤下', '正在撤下')}
            {button('save', '保存修改', '正在保存', true)}
          </>
        )}
        {status === 'withdrawn' && (
          <>
            {button('save', '保存修改', '正在保存')}
            {button('publish', '重新发布', '正在发布', true)}
          </>
        )}
      </div>
      {withdrawing && (
        <Confirm
          title="有没保存的修改，先撤下吗？"
          confirm="撤下"
          busy="正在撤下"
          cancel="先不撤"
          onCancel={() => {
            setWithdrawing(false)
            withdrawButton.current?.focus()
          }}
          onConfirm={async () => {
            setWithdrawing(false)
            await act('withdraw', true)
          }}
        >
          <p>表单里改过的地方还没保存，撤下不会保存这些修改。它们留在表单里，撤下以后还可以保存。</p>
        </Confirm>
      )}
      {deleting && notice !== null && (
        <Confirm
          title={`删除草稿“${notice.title}”？`}
          danger
          confirm="删除"
          busy="正在删除"
          cancel="先不删"
          onCancel={() => {
            setDeleting(false)
            deleteButton.current?.focus()
          }}
          onConfirm={async () => {
            try {
              await deleteNotice(notice.id)
            } catch (error) {
              // The dialog says the refusal; the list and the editor follow the server meanwhile.
              void resync(error as ApiError, notice.id)
              throw error
            }
            setDeleting(false)
            onDeleted()
          }}
        >
          <p>草稿还没发布过，删掉就没有了，不能恢复。</p>
        </Confirm>
      )}
    </section>
  )
}

function NoticeList({ notices, onOpen }: { notices: NoticeView[]; onOpen: (notice: NoticeView) => void }) {
  const zone = useSchoolZone()
  return (
    <div className="mt-4 overflow-x-auto">
      <table className={TABLE}>
        <caption className="sr-only">公告</caption>
        <thead>
          <tr>
            {['标题', '类型', '状态', '发布时间'].map((cell) => (
              <th key={cell} scope="col" className={TH}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={TBODY}>
          {notices.map((notice) => (
            <tr key={notice.id} className="hover:bg-gray-50">
              <td className={`${TD} font-medium text-gray-900`}>
                <span className="flex flex-wrap items-center gap-2">
                  <Button type="link" className="text-left whitespace-normal" onClick={() => onOpen(notice)}>
                    {notice.title}
                  </Button>
                  {notice.updatedAt !== null && (
                    <Badge tone="blue">
                      <span title={`发布以后改过：${moment(notice.updatedAt, zone)}`}>已更新</span>
                      <span className="sr-only">（发布以后改过：{moment(notice.updatedAt, zone)}）</span>
                    </Badge>
                  )}
                </span>
              </td>
              <td className={TD}>{NOTICE_KIND_NAMES[notice.kind]}</td>
              <td className={TD}>
                <Badge tone={STATUS_TONES[notice.status]}>{NOTICE_STATUS_NAMES[notice.status]}</Badge>
              </td>
              <td className={`${TD} whitespace-nowrap tabular-nums`}>
                {notice.publishedAt === null ? '还没发布' : moment(notice.publishedAt, zone)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Notices() {
  const read = useLoad<{ notices: NoticeView[] }>(NOTICES_PATH)
  const titleId = useId()
  // `n` makes each opening a new editor, with the form as that notice has it.
  const [open, setOpen] = useState<{ notice: NoticeView | null; n: number }>()
  const [done, setDone] = useState<{ text: string; n: number }>()
  const writeNew = useRef<HTMLButtonElement>(null)
  const dirty = useRef(false)
  // What to do once the changes not saved may be dropped, and where the focus goes back to if they may not.
  const [leaving, setLeaving] = useState<{ go: () => void; back: HTMLElement | null }>()

  /** Does `go`, which closes the open editor; asks first when it has changes not saved. */
  function leave(go: () => void) {
    if (open !== undefined && dirty.current) {
      setLeaving({ go, back: document.activeElement instanceof HTMLElement ? document.activeElement : null })
    } else {
      go()
    }
  }

  function openEditor(notice: NoticeView | null) {
    leave(() => {
      setDone(undefined)
      dirty.current = false
      setOpen((last) => ({ notice, n: (last?.n ?? 0) + 1 }))
    })
  }

  let list
  if (read.data === undefined) {
    list =
      read.error !== undefined ? (
        <Failed what="公告" reason={read.error.message} retry={read.reload} />
      ) : (
        <Loading what="公告" />
      )
  } else if (read.data.notices.length === 0) {
    list = <Empty why="还没有公告。写一条，存成草稿，看过预览再发布。" />
  } else {
    list = <NoticeList notices={read.data.notices} onOpen={openEditor} />
  }

  return (
    <div className="space-y-6">
      <PageActions>
        <Button ref={writeNew} type="primary" onClick={() => openEditor(null)}>
          写新公告
        </Button>
      </PageActions>
      <Card title="全部公告" titleId={titleId} description="网站上只显示已发布的公告。发布过的不能删除，只能撤下。">
        {done !== undefined && <Done key={done.n} text={done.text} />}
        {list}
      </Card>
      {open !== undefined && (
        <NoticeEditor
          key={open.n}
          initial={open.notice}
          onChanged={read.reload}
          dirtyRef={dirty}
          onDeleted={() => {
            dirty.current = false
            setOpen(undefined)
            read.reload()
            setDone((last) => ({ text: '草稿已删除。', n: (last?.n ?? 0) + 1 }))
          }}
          onClose={() =>
            leave(() => {
              dirty.current = false
              setOpen(undefined)
              writeNew.current?.focus()
            })
          }
        />
      )}
      {leaving !== undefined && (
        <Confirm
          title="有没保存的修改，关掉就没了"
          confirm="不保存，关掉"
          busy="正在关掉"
          cancel="回去接着改"
          onCancel={() => {
            leaving.back?.focus()
            setLeaving(undefined)
          }}
          onConfirm={async () => {
            setLeaving(undefined)
            leaving.go()
          }}
        >
          <p>这条公告改过的地方还没保存。要留着的话，回去先保存。</p>
        </Confirm>
      )}
    </div>
  )
}
