import { Button, Input, Radio } from 'antd'
import { useId, useRef, useState } from 'react'
import {
  createNotice,
  deleteNotice,
  editNotice,
  NOTICES_PATH,
  publishNotice,
  useLoad,
  withdrawNotice,
  type ApiError,
  type NoticeContent,
  type NoticeKind,
  type NoticeView,
} from '../api.js'
import { Confirm } from '../components/Confirm.js'
import { Empty, Failed, Loading } from '../components/States.js'
import { DataTable } from '../components/Tables.js'
import { useFocusOnMount } from '../focus.js'
import { clockInput, dayMoment, instantOf, moment, NOTICE_KIND_NAMES, NOTICE_STATUS_NAMES } from '../labels.js'
import { NoticeBody } from '../notice-markdown.js'
import { useSchoolZone } from '../zone.js'

// 公告: the notices the website shows. The list has every one, newest first as the server orders them; one is opened
// to edit it, below the list. A notice is written as a draft, published, withdrawn and published again; only a
// draft can be deleted, so one that was ever out stays on record. Times are entered and shown on the school's clock
// and sent in UTC. What the page checks before sending is what the server checks; a refusal is still said in the
// server's words.

const MAX_TITLE = 60
const MAX_BODY = 4000

/** Says what an action did; it takes the focus the button that did it had. */
function Done({ text }: { text: string }) {
  const self = useFocusOnMount<HTMLParagraphElement>()
  return (
    <p ref={self} tabIndex={-1} className="action-done" role="status">
      {text}
    </p>
  )
}

/** What stops the notice from being sent, or the server's refusal; it takes the focus when it appears. */
function Problems({ lines }: { lines: string[] }) {
  const self = useFocusOnMount<HTMLDivElement>()
  return (
    <div ref={self} tabIndex={-1} className="action-error" role="alert">
      {lines.length === 1 ? (
        <p>{lines[0]}</p>
      ) : (
        <ul className="notice-problems">
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
  const at = instantOf(input, zone)
  if (at === null) return { at: null, problem: `${label}的时间不对，学校时区里没有这个时间。` }
  const year = new Date(at).getUTCFullYear()
  if (year < 2000 || year > 9999) return { at: null, problem: `${label}要在 2000 年到 9999 年之间。` }
  return { at }
}

type Action = 'save' | 'publish' | 'withdraw'

function NoticeEditor({
  initial,
  onChanged,
  onDeleted,
  onClose,
}: {
  /** Null for a new notice. */
  initial: NoticeView | null
  /** The notice changed on the server: the list is read again. */
  onChanged: () => void
  onDeleted: () => void
  onClose: () => void
}) {
  const zone = useSchoolZone()
  const ids = {
    title: useId(),
    heading: useId(),
    name: useId(),
    body: useId(),
    bodyHint: useId(),
    starts: useId(),
    ends: useId(),
    published: useId(),
    publishedHint: useId(),
  }
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const [notice, setNotice] = useState(initial)
  const timeInput = (at: string | null) => (at === null ? '' : clockInput(at, zone))
  const [title, setTitle] = useState(initial?.title ?? '')
  const [kind, setKind] = useState<NoticeKind>(initial?.kind ?? 'general')
  const [starts, setStarts] = useState(timeInput(initial?.startsAt ?? null))
  const [ends, setEnds] = useState(timeInput(initial?.endsAt ?? null))
  const [body, setBody] = useState(initial?.body ?? '')
  const [published, setPublished] = useState(timeInput(initial?.publishedAt ?? null))
  const [sending, setSending] = useState<Action>()
  const [tried, setTried] = useState(0)
  const [failure, setFailure] = useState<{ text: string; n: number }>()
  const [done, setDone] = useState<{ text: string; n: number }>()
  const [deleting, setDeleting] = useState(false)
  const deleteButton = useRef<HTMLButtonElement>(null)

  const status = notice?.status ?? null
  const maintenance = kind === 'maintenance'
  const wasOut = status === 'published' || status === 'withdrawn'

  // Everything the server would refuse, in the order of the form.
  const problems: string[] = []
  const trimmed = title.trim()
  if (!storable(title)) problems.push('标题里有存不了的字符（NUL 或半个字符），删掉再试。')
  else if (trimmed === '') problems.push('标题不能空着。')
  else if (length(trimmed) > MAX_TITLE) problems.push(`标题最多 ${MAX_TITLE} 字，现在 ${length(trimmed)} 字。`)
  const start = readTime('维护开始', starts, zone)
  const end = readTime('维护结束', ends, zone)
  if (maintenance) {
    if (starts === '') problems.push('维护公告要写开始时间。')
    if (start.problem !== undefined) problems.push(start.problem)
    if (end.problem !== undefined) problems.push(end.problem)
    if (start.at !== null && end.at !== null && end.at <= start.at) problems.push('维护结束要晚于开始。')
  }
  if (!storable(body)) problems.push('正文里有存不了的字符（NUL 或半个字符），删掉再试。')
  else if (length(body) > MAX_BODY) problems.push(`正文最多 ${MAX_BODY} 字，现在 ${length(body)} 字。`)
  const publication = readTime('发布时间', published, zone)
  if (wasOut) {
    if (published === '') problems.push('发布时间不能空着。')
    else if (publication.problem !== undefined) problems.push(publication.problem)
    else if (publication.at !== null && new Date(publication.at).getTime() > Date.now()) {
      problems.push('发布时间不能晚于现在。')
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

  async function act(action: Action) {
    setFailure(undefined)
    setDone(undefined)
    if (action !== 'withdraw' && problems.length > 0) {
      setTried((n) => n + 1)
      return
    }
    setSending(action)
    // The notice as the server now has it; its publication time is the one it was given there.
    const took = (next: NoticeView) => {
      setNotice(next)
      setPublished(timeInput(next.publishedAt))
      onChanged()
    }
    const say = (text: string) => setDone((last) => ({ text, n: (last?.n ?? 0) + 1 }))
    const refuse = (text: string) => setFailure((last) => ({ text, n: (last?.n ?? 0) + 1 }))
    try {
      if (action === 'withdraw' && notice !== null) {
        took(await withdrawNotice(notice.id))
        say('已撤下。网站上不再显示这条公告。')
        return
      }
      let saved: NoticeView
      try {
        saved = await save()
      } catch (error) {
        refuse(`没能保存：${(error as ApiError).message}`)
        return
      }
      took(saved)
      if (action === 'save') {
        say(saved.status === 'draft' ? '草稿已保存。' : '修改已保存。')
        return
      }
      const again = saved.status === 'withdrawn'
      try {
        took(await publishNotice(saved.id))
        say(again ? '已重新发布，发布时间还是第一次发布的时间。' : '已发布。')
      } catch (error) {
        const reason = (error as ApiError).message
        refuse(again ? `修改已保存，但没能重新发布：${reason}` : `草稿已保存，但没能发布：${reason}`)
      }
    } catch (error) {
      // Saving and publishing say their own failures above: what reaches here is the withdrawal's.
      refuse(`没能撤下：${(error as ApiError).message}`)
    } finally {
      setSending(undefined)
    }
  }

  const button = (action: Action, label: string, busy: string, primary = false) => (
    <Button type={primary ? 'primary' : 'default'} onClick={() => act(action)} disabled={sending !== undefined}>
      {sending === action ? busy : label}
    </Button>
  )

  return (
    <section className="panel notice-editor" aria-labelledby={ids.heading}>
      <h2 id={ids.heading} ref={heading} tabIndex={-1} className="panel-title">
        {notice === null ? '写新公告' : '编辑公告'}
      </h2>
      <p className="notice-status">状态：{status === null ? '还没保存' : NOTICE_STATUS_NAMES[status]}</p>
      <div className="notice-form">
        <div className="notice-fields">
          <label className="field-label" htmlFor={ids.title}>
            标题
          </label>
          <Input id={ids.title} value={title} onChange={(event) => setTitle(event.target.value)} />
          <fieldset className="field-set">
            <legend className="field-label">类型</legend>
            <Radio.Group
              value={kind}
              onChange={(event) => setKind(event.target.value as NoticeKind)}
              options={(Object.keys(NOTICE_KIND_NAMES) as NoticeKind[]).map((key) => ({
                value: key,
                label: NOTICE_KIND_NAMES[key],
              }))}
            />
          </fieldset>
          {(maintenance || wasOut) && <p className="field-hint">时间都按学校时区（{zone}）填写。</p>}
          {maintenance && (
            <>
              <label className="field-label" htmlFor={ids.starts}>
                维护开始
              </label>
              <Input
                id={ids.starts}
                type="datetime-local"
                className="date-input"
                value={starts}
                onChange={(event) => setStarts(event.target.value)}
              />
              <label className="field-label" htmlFor={ids.ends}>
                维护结束（可以不填）
              </label>
              <Input
                id={ids.ends}
                type="datetime-local"
                className="date-input"
                value={ends}
                onChange={(event) => setEnds(event.target.value)}
              />
            </>
          )}
          <label className="field-label" htmlFor={ids.body}>
            正文
          </label>
          <p id={ids.bodyHint} className="field-hint">
            最多 {MAX_BODY} 字。空一行分段；行首写“- ”是列表；**加粗**；[文字](https://…) 是链接，只认 https://。别的写法照原样显示。
          </p>
          <Input.TextArea
            id={ids.body}
            aria-describedby={ids.bodyHint}
            value={body}
            autoSize={{ minRows: 6, maxRows: 20 }}
            onChange={(event) => setBody(event.target.value)}
          />
          {wasOut && (
            <>
              <label className="field-label" htmlFor={ids.published}>
                发布时间
              </label>
              <p id={ids.publishedHint} className="field-hint">
                第一次发布的时间，撤下再发布不变。补发的公告可以改早，不能晚于现在。
              </p>
              <Input
                id={ids.published}
                type="datetime-local"
                className="date-input"
                aria-describedby={ids.publishedHint}
                value={published}
                onChange={(event) => setPublished(event.target.value)}
              />
            </>
          )}
        </div>
        <section className="notice-preview" aria-label="预览">
          <p className="field-label">预览</p>
          <h3 className="notice-preview-title">{trimmed === '' ? '（还没写标题）' : trimmed}</h3>
          {maintenance && start.at !== null && (
            <p className="notice-window">
              维护时间：{dayMoment(start.at, zone)}
              {end.at === null ? ' 开始' : ` 到 ${dayMoment(end.at, zone)}`}
            </p>
          )}
          <NoticeBody body={body} />
        </section>
      </div>
      {/* Keyed by the try, so each one that is stopped takes the focus anew. */}
      {tried > 0 && problems.length > 0 && <Problems key={`check-${tried}`} lines={problems} />}
      {failure !== undefined && <Problems key={`refusal-${failure.n}`} lines={[failure.text]} />}
      {done !== undefined && <Done key={done.n} text={done.text} />}
      <div className="box-actions">
        {(status === null || status === 'draft') && (
          <>
            {button('save', '保存草稿', '正在保存')}
            {button('publish', '发布', '正在发布', true)}
          </>
        )}
        {status === 'published' && (
          <>
            {button('save', '保存修改', '正在保存', true)}
            {button('withdraw', '撤下', '正在撤下')}
          </>
        )}
        {status === 'withdrawn' && (
          <>
            {button('save', '保存修改', '正在保存')}
            {button('publish', '重新发布', '正在发布', true)}
          </>
        )}
        {status === 'draft' && (
          <Button ref={deleteButton} onClick={() => setDeleting(true)} disabled={sending !== undefined}>
            删除草稿
          </Button>
        )}
        <Button onClick={onClose} disabled={sending !== undefined}>
          关闭
        </Button>
      </div>
      {deleting && notice !== null && (
        <Confirm
          title={`删除草稿“${notice.title}”？`}
          confirm="删除"
          busy="正在删除"
          cancel="先不删"
          onCancel={() => {
            setDeleting(false)
            deleteButton.current?.focus()
          }}
          onConfirm={async () => {
            await deleteNotice(notice.id)
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
    <DataTable caption="公告" quietCaption wide head={['标题', '类型', '状态', '发布时间']}>
      {notices.map((notice) => (
        <tr key={notice.id}>
          <td>
            <Button type="link" className="notice-open" onClick={() => onOpen(notice)}>
              {notice.title}
            </Button>
            {notice.updatedAt !== null && (
              <span className="notice-updated" title={`发布以后改过：${moment(notice.updatedAt, zone)}`}>
                已更新
              </span>
            )}
          </td>
          <td>{NOTICE_KIND_NAMES[notice.kind]}</td>
          <td>{NOTICE_STATUS_NAMES[notice.status]}</td>
          <td>{notice.publishedAt === null ? '还没发布' : moment(notice.publishedAt, zone)}</td>
        </tr>
      ))}
    </DataTable>
  )
}

export function Notices() {
  const read = useLoad<{ notices: NoticeView[] }>(NOTICES_PATH)
  const titleId = useId()
  // `n` makes each opening a new editor, with the form as that notice has it.
  const [open, setOpen] = useState<{ notice: NoticeView | null; n: number }>()
  const [done, setDone] = useState<{ text: string; n: number }>()
  const writeNew = useRef<HTMLButtonElement>(null)

  function openEditor(notice: NoticeView | null) {
    setDone(undefined)
    setOpen((last) => ({ notice, n: (last?.n ?? 0) + 1 }))
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
    <div className="page notices">
      <section className="panel" aria-labelledby={titleId}>
        <div className="panel-head">
          <h2 id={titleId} className="panel-title">
            公告
          </h2>
          <Button ref={writeNew} onClick={() => openEditor(null)}>
            写新公告
          </Button>
        </div>
        <p className="field-hint">网站上只显示已发布的公告。发布过的不能删除，只能撤下。</p>
        {done !== undefined && <Done key={done.n} text={done.text} />}
        {list}
      </section>
      {open !== undefined && (
        <NoticeEditor
          key={open.n}
          initial={open.notice}
          onChanged={read.reload}
          onDeleted={() => {
            setOpen(undefined)
            read.reload()
            setDone((last) => ({ text: '草稿已删除。', n: (last?.n ?? 0) + 1 }))
          }}
          onClose={() => {
            setOpen(undefined)
            writeNew.current?.focus()
          }}
        />
      )}
    </div>
  )
}
