import { Badge, Button, Card, Checkbox, Input, PageActions, RadioGroup, TABLE, TBODY, TD, TH, TextArea, type Tone } from '../ui.js'
import { useEffect, useId, useRef, useState } from 'react'
import {
  BROADCAST_CLASSES_PATH,
  BROADCASTS_PATH,
  createBroadcast,
  deleteBroadcast,
  editBroadcast,
  publishBroadcast,
  request,
  useLoad,
  withdrawBroadcast,
  type ApiError,
  type BroadcastClass,
  type BroadcastContent,
  type BroadcastImportance,
  type BroadcastView,
  type Division,
  type Slot,
} from '../api.js'
import { Confirm } from '../components/Confirm.js'
import { Empty, Failed, Loading } from '../components/States.js'
import { useFocusOnMount } from '../focus.js'
import {
  BROADCAST_IMPORTANCE_NAMES,
  BROADCAST_STATUS_NAMES,
  clockInput,
  DIVISION_NAMES,
  moment,
  SLOT_NAMES,
} from '../labels.js'
import { useSchoolZone } from '../zone.js'
import { Done, FormSection, LABEL, LabelWithTip, length, Problems, readTime, storable } from './Notices.js'

// 广播: the campus broadcast, short notes to the students in school that their plugins fetch and pass on to the owners.
// Drawn like the notices page: a table of every broadcast, newest first, and below it the one opened. A draft is
// written, saved and published; a published broadcast is never changed, only withdrawn, for good, since plugins may
// already have fetched it. What the page checks before sending is what the server checks; a refusal is still said in
// the server's words.

const MAX_TITLE = 40
const MAX_BODY = 1000

const DIVISIONS = Object.keys(DIVISION_NAMES) as Division[]
const SLOTS = Object.keys(SLOT_NAMES) as Slot[]

type Scope = 'school' | 'groups' | 'classes'
const SCOPE_NAMES: Record<Scope, string> = { school: '全校', groups: '按学部和时段', classes: '指定班级' }

/** The colour of a broadcast's status: a draft grey, out green, withdrawn yellow. */
const STATUS_TONES: Record<BroadcastView['status'], Tone> = { draft: 'gray', published: 'green', withdrawn: 'yellow' }

type Action = 'save' | 'publish' | 'withdraw'

const scopeOf = (b: BroadcastView | null): Scope =>
  b === null || (b.classes.length === 0 && b.divisions.length === 0 && b.slots.length === 0)
    ? 'school'
    : b.classes.length > 0
      ? 'classes'
      : 'groups'

/** Adds `value` to `list`, or takes it out, keeping the order of `all`. */
function toggled<T>(list: T[], value: T, on: boolean, all: readonly T[]): T[] {
  const next = on ? [...list, value] : list.filter((v) => v !== value)
  return all.filter((v) => next.includes(v))
}

function BroadcastEditor({
  initial,
  classes,
  dirtyRef,
  onChanged,
  onDeleted,
  onClose,
}: {
  /** Null for a new broadcast. */
  initial: BroadcastView | null
  /** The classes that can be picked; undefined while they are read. */
  classes: BroadcastClass[] | undefined
  dirtyRef: { current: boolean }
  onChanged: () => void
  onDeleted: () => void
  onClose: () => void
}) {
  const zone = useSchoolZone()
  const ids = { title: useId(), heading: useId(), body: useId(), expires: useId() }
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const [broadcast, setBroadcast] = useState(initial)
  const timeInput = (at: string | null | undefined) => (at == null ? '' : clockInput(at, zone))
  const [title, setTitle] = useState(initial?.title ?? '')
  const [body, setBody] = useState(initial?.body ?? '')
  const [importance, setImportance] = useState<BroadcastImportance>(initial?.importance ?? 'normal')
  const [scope, setScope] = useState<Scope>(scopeOf(initial))
  const [divisions, setDivisions] = useState<Division[]>(initial?.divisions ?? [])
  const [slots, setSlots] = useState<Slot[]>(initial?.slots ?? [])
  const [classIds, setClassIds] = useState<number[]>(initial?.classes.map((c) => c.id) ?? [])
  const [expires, setExpires] = useState(timeInput(initial?.expiresAt))
  const [sending, setSending] = useState<Action>()
  const [tried, setTried] = useState(0)
  const [failure, setFailure] = useState<{ text: string; n: number }>()
  const [done, setDone] = useState<{ text: string; n: number }>()
  const [deleting, setDeleting] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const withdrawButton = useRef<HTMLButtonElement>(null)

  const status = broadcast?.status ?? null
  const editable = status === null || status === 'draft'
  const trimmed = title.trim()
  const expiry =
    expires !== '' && broadcast?.expiresAt != null && expires === timeInput(broadcast.expiresAt)
      ? { at: broadcast.expiresAt }
      : readTime('截止时间', expires, zone)

  // The classes picked, as they are known: those of the broadcast, and those in the list.
  const known = new Map<number, BroadcastClass>([...(initial?.classes ?? []), ...(classes ?? [])].map((c) => [c.id, c]))
  const pickedClasses = classIds.flatMap((id) => known.get(id) ?? [])

  const sameList = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((v, i) => v === b[i])
  const dirty =
    editable &&
    (trimmed !== (broadcast?.title ?? '') ||
      body !== (broadcast?.body ?? '') ||
      importance !== (broadcast?.importance ?? 'normal') ||
      scope !== scopeOf(broadcast) ||
      !sameList(divisions, broadcast?.divisions ?? []) ||
      !sameList(slots, broadcast?.slots ?? []) ||
      !sameList(classIds, broadcast?.classes.map((c) => c.id) ?? []) ||
      expires !== timeInput(broadcast?.expiresAt))
  useEffect(() => {
    dirtyRef.current = dirty
  })

  // Everything the server would refuse, in the order of the form.
  const problems: string[] = []
  if (!storable(title)) problems.push('标题里有存不了的字符（NUL 或半个字符），删掉再试。')
  else if (trimmed === '') problems.push('标题不能空着。')
  else if (length(trimmed) > MAX_TITLE) problems.push(`标题最多 ${MAX_TITLE} 字，现在 ${length(trimmed)} 字。`)
  if (!storable(body)) problems.push('正文里有存不了的字符（NUL 或半个字符），删掉再试。')
  else if (length(body) > MAX_BODY) problems.push(`正文最多 ${MAX_BODY} 字，现在 ${length(body)} 字。`)
  if (scope === 'groups' && divisions.length === 0 && slots.length === 0) problems.push('按学部和时段发，至少勾一个学部或时段。')
  if (scope === 'classes' && pickedClasses.length === 0) problems.push('指定班级，至少勾一个班。')
  if (expiry.problem !== undefined) problems.push(expiry.problem)

  const content = (): BroadcastContent => ({
    title: trimmed,
    body,
    importance,
    divisions: scope === 'groups' ? divisions : [],
    slots: scope === 'groups' ? slots : [],
    classes: scope === 'classes' ? pickedClasses.map(({ division, slot, classNo }) => ({ division, slot, classNo })) : [],
    expiresAt: expiry.at,
  })

  /** After a refusal: the list is read again, and a broadcast whose state was not what the page thought is read anew. */
  async function resync(error: ApiError, id: number | undefined) {
    onChanged()
    if (id === undefined || (error.status !== 404 && error.status !== 409)) return
    try {
      const { broadcasts } = await request<{ broadcasts: BroadcastView[] }>('GET', BROADCASTS_PATH)
      setBroadcast(broadcasts.find((one) => one.id === id) ?? null)
    } catch {
      // The list says it could not be read; the editor stays as it was.
    }
  }

  async function act(action: Action) {
    setFailure(undefined)
    setDone(undefined)
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
        if (broadcast === null) return
        try {
          setBroadcast(await withdrawBroadcast(broadcast.id))
          onChanged()
          say('已撤回。插件不会再拿到这条广播；已经转告过的收不回来。')
        } catch (error) {
          refuse('没能撤回：', error as ApiError, broadcast.id)
        }
        return
      }
      let saved: BroadcastView
      try {
        saved = broadcast === null ? await createBroadcast(content()) : await editBroadcast(broadcast.id, content())
      } catch (error) {
        refuse('没能保存：', error as ApiError, broadcast?.id)
        return
      }
      setBroadcast(saved)
      setTried(0)
      onChanged()
      if (action === 'save') {
        say('草稿已保存。')
        return
      }
      try {
        setBroadcast(await publishBroadcast(saved.id))
        onChanged()
        say('已发布。插件下次来问时就会拿到。')
      } catch (error) {
        refuse('草稿已保存，但没能发布：', error as ApiError, saved.id)
      }
    } finally {
      setSending(undefined)
    }
  }

  const button = (action: Action, label: string, busy: string, primary = false) => (
    <Button
      ref={action === 'withdraw' ? withdrawButton : undefined}
      type={primary ? 'primary' : 'default'}
      onClick={() => (action === 'withdraw' ? setWithdrawing(true) : act(action))}
      disabled={sending !== undefined}
    >
      {sending === action ? busy : label}
    </Button>
  )

  return (
    <section className="lift rounded-lg border border-gray-200 bg-white" aria-labelledby={ids.heading}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-6 py-4">
        <div className="flex items-center gap-3">
          <h2 id={ids.heading} ref={heading} tabIndex={-1} className="text-lg font-bold text-gray-900">
            {broadcast === null ? '写新广播' : editable ? '编辑广播' : '广播'}
          </h2>
          <Badge tone={status === null ? 'gray' : STATUS_TONES[status]}>
            状态：{status === null ? '还没保存' : BROADCAST_STATUS_NAMES[status]}
          </Badge>
        </div>
      </div>
      {editable ? (
        <div className="divide-y divide-gray-200 px-6">
          <FormSection title="标题和正文" about="插件拿到广播以后，让 AI 转告机器人的主人。都是纯文字，不认 Markdown。">
            <div>
              <label className={LABEL} htmlFor={ids.title}>
                标题
              </label>
              <Input id={ids.title} className="mt-1" value={title} onChange={(event) => setTitle(event.target.value)} />
            </div>
            <div>
              <LabelWithTip htmlFor={ids.body} label="正文" tip={`最多 ${MAX_BODY} 字，可以不写。`} />
              <TextArea
                id={ids.body}
                className="mt-1"
                value={body}
                autoSize={{ minRows: 4, maxRows: 12 }}
                onChange={(event) => setBody(event.target.value)}
              />
            </div>
          </FormSection>
          <FormSection title="重要程度" about="重要的广播，插件要想办法让机器人的主人知道；普通的，插件自己决定要不要转告。">
            <fieldset>
              <legend className="sr-only">重要程度</legend>
              <RadioGroup
                value={importance}
                onChange={(event) => setImportance(event.target.value)}
                options={(Object.keys(BROADCAST_IMPORTANCE_NAMES) as BroadcastImportance[]).map((key) => ({
                  value: key,
                  label: BROADCAST_IMPORTANCE_NAMES[key],
                }))}
              />
            </fieldset>
          </FormSection>
          <FormSection
            title="发给谁"
            about="按学部和时段发时，勾的学部和时段同时满足才收到；只勾学部就是这些学部的所有时段。还在等分班的学生收不到发给班级的广播。"
          >
            <fieldset>
              <legend className="sr-only">发给谁</legend>
              <RadioGroup
                value={scope}
                onChange={(event) => setScope(event.target.value)}
                options={(Object.keys(SCOPE_NAMES) as Scope[]).map((key) => ({ value: key, label: SCOPE_NAMES[key] }))}
              />
            </fieldset>
            {scope === 'groups' && (
              <div className="space-y-3">
                <fieldset>
                  <legend className={LABEL}>学部</legend>
                  <div className="mt-1 flex flex-wrap gap-4">
                    {DIVISIONS.map((d) => (
                      <Checkbox
                        key={d}
                        checked={divisions.includes(d)}
                        onChange={(event) => setDivisions((list) => toggled(list, d, event.target.checked, DIVISIONS))}
                      >
                        {DIVISION_NAMES[d]}
                      </Checkbox>
                    ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend className={LABEL}>时段</legend>
                  <div className="mt-1 flex flex-wrap gap-4">
                    {SLOTS.map((s) => (
                      <Checkbox
                        key={s}
                        checked={slots.includes(s)}
                        onChange={(event) => setSlots((list) => toggled(list, s, event.target.checked, SLOTS))}
                      >
                        {SLOT_NAMES[s]}
                      </Checkbox>
                    ))}
                  </div>
                </fieldset>
              </div>
            )}
            {scope === 'classes' && (
              <fieldset>
                <legend className={LABEL}>班级</legend>
                {classes === undefined ? (
                  <p className="mt-1 text-sm text-gray-600">正在读取班级……</p>
                ) : classes.length === 0 ? (
                  <p className="mt-1 text-sm text-gray-600">还没有班级。</p>
                ) : (
                  <div className="mt-1 grid grid-cols-3 gap-2">
                    {classes.map((c) => (
                      <Checkbox
                        key={c.id}
                        checked={classIds.includes(c.id)}
                        onChange={(event) =>
                          setClassIds((list) =>
                            toggled(
                              list,
                              c.id,
                              event.target.checked,
                              classes.map((one) => one.id),
                            ),
                          )
                        }
                      >
                        {c.name}
                      </Checkbox>
                    ))}
                  </div>
                )}
              </fieldset>
            )}
          </FormSection>
          <FormSection title="截止时间" note={`按学校时区（${zone}）填写。`} about="过了截止时间，插件就拿不到这条广播了。不填的话，发布 30 天后不再给出。">
            <div>
              <label className={LABEL} htmlFor={ids.expires}>
                截止时间（可以不填）
              </label>
              <Input
                id={ids.expires}
                type="datetime-local"
                className="mt-1"
                value={expires}
                onChange={(event) => setExpires(event.target.value)}
              />
            </div>
          </FormSection>
        </div>
      ) : (
        broadcast !== null && (
          <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-3 px-6 py-6 text-sm">
            <dt className="font-medium text-gray-700">标题</dt>
            <dd className="break-words text-gray-900">{broadcast.title}</dd>
            <dt className="font-medium text-gray-700">正文</dt>
            <dd className="whitespace-pre-wrap break-words text-gray-900">{broadcast.body === '' ? '（没有正文）' : broadcast.body}</dd>
            <dt className="font-medium text-gray-700">重要程度</dt>
            <dd className="text-gray-900">{BROADCAST_IMPORTANCE_NAMES[broadcast.importance]}</dd>
            <dt className="font-medium text-gray-700">发给谁</dt>
            <dd className="text-gray-900">{broadcast.audience}</dd>
            <dt className="font-medium text-gray-700">发布时间</dt>
            <dd className="tabular-nums text-gray-900">{broadcast.publishedAt === null ? '—' : moment(broadcast.publishedAt, zone)}</dd>
            <dt className="font-medium text-gray-700">截止时间</dt>
            <dd className="tabular-nums text-gray-900">
              {broadcast.expiresAt === null ? '没有，发布 30 天后不再给出' : moment(broadcast.expiresAt, zone)}
            </dd>
            {broadcast.withdrawnAt !== null && (
              <>
                <dt className="font-medium text-gray-700">撤回时间</dt>
                <dd className="tabular-nums text-gray-900">{moment(broadcast.withdrawnAt, zone)}</dd>
              </>
            )}
          </dl>
        )
      )}
      <div className="px-6">
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
        {editable && (
          <>
            {button('save', '保存草稿', '正在保存')}
            {button('publish', '发布', '正在发布', true)}
          </>
        )}
        {status === 'published' && button('withdraw', '撤回', '正在撤回')}
      </div>
      {withdrawing && broadcast !== null && (
        <Confirm
          title={`撤回广播“${broadcast.title}”？`}
          danger
          confirm="撤回"
          busy="正在撤回"
          cancel="先不撤"
          onCancel={() => {
            setWithdrawing(false)
            withdrawButton.current?.focus()
          }}
          onConfirm={async () => {
            setWithdrawing(false)
            await act('withdraw')
          }}
        >
          <p>撤回以后插件不会再拿到这条广播，也不能再发布。已经拿到、转告过的收不回来。</p>
        </Confirm>
      )}
      {deleting && broadcast !== null && (
        <Confirm
          title={`删除草稿“${broadcast.title}”？`}
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
              await deleteBroadcast(broadcast.id)
            } catch (error) {
              void resync(error as ApiError, broadcast.id)
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

function BroadcastList({ broadcasts, onOpen }: { broadcasts: BroadcastView[]; onOpen: (b: BroadcastView) => void }) {
  const zone = useSchoolZone()
  return (
    <div className="mt-4 overflow-x-auto">
      <table className={TABLE}>
        <caption className="sr-only">广播</caption>
        <thead>
          <tr>
            {['标题', '发给谁', '重要程度', '状态', '发布时间'].map((cell) => (
              <th key={cell} scope="col" className={TH}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={TBODY}>
          {broadcasts.map((b) => (
            <tr key={b.id} className="hover:bg-gray-50">
              <td className={`${TD} font-medium text-gray-900`}>
                <span className="flex flex-wrap items-center gap-2">
                  <Button type="link" className="text-left whitespace-normal" onClick={() => onOpen(b)}>
                    {b.title}
                  </Button>
                  {b.noticeId !== null && <Badge tone="blue">随公告发出</Badge>}
                </span>
              </td>
              <td className={TD}>{b.audience}</td>
              <td className={TD}>
                {b.importance === 'important' ? <Badge tone="red">重要</Badge> : BROADCAST_IMPORTANCE_NAMES[b.importance]}
              </td>
              <td className={TD}>
                <Badge tone={STATUS_TONES[b.status]}>{BROADCAST_STATUS_NAMES[b.status]}</Badge>
              </td>
              <td className={`${TD} whitespace-nowrap tabular-nums`}>
                {b.publishedAt === null ? '还没发布' : moment(b.publishedAt, zone)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Broadcasts() {
  const read = useLoad<{ broadcasts: BroadcastView[] }>(BROADCASTS_PATH)
  const classes = useLoad<{ classes: BroadcastClass[] }>(BROADCAST_CLASSES_PATH)
  const titleId = useId()
  const [open, setOpen] = useState<{ broadcast: BroadcastView | null; n: number }>()
  const [done, setDone] = useState<{ text: string; n: number }>()
  const writeNew = useRef<HTMLButtonElement>(null)
  const dirty = useRef(false)
  const [leaving, setLeaving] = useState<{ go: () => void; back: HTMLElement | null }>()

  function leave(go: () => void) {
    if (open !== undefined && dirty.current) {
      setLeaving({ go, back: document.activeElement instanceof HTMLElement ? document.activeElement : null })
    } else {
      go()
    }
  }

  function openEditor(broadcast: BroadcastView | null) {
    leave(() => {
      setDone(undefined)
      dirty.current = false
      setOpen((last) => ({ broadcast, n: (last?.n ?? 0) + 1 }))
    })
  }

  let list
  if (read.data === undefined) {
    list = read.error !== undefined ? <Failed what="广播" reason={read.error.message} retry={read.reload} /> : <Loading what="广播" />
  } else if (read.data.broadcasts.length === 0) {
    list = <Empty why="还没有广播。写一条，选好发给谁，存成草稿再发布。" />
  } else {
    list = <BroadcastList broadcasts={read.data.broadcasts} onOpen={openEditor} />
  }

  return (
    <div className="space-y-6">
      <PageActions>
        <Button ref={writeNew} type="primary" onClick={() => openEditor(null)}>
          写新广播
        </Button>
      </PageActions>
      <Card
        title="全部广播"
        titleId={titleId}
        description="广播只发给在校的学生，插件拿到以后转告机器人的主人；公告是给所有人看的，在网站上显示。发布过的广播不能改、不能删，只能撤回。"
      >
        {done !== undefined && <Done key={done.n} text={done.text} />}
        {list}
      </Card>
      {open !== undefined && (
        <BroadcastEditor
          key={open.n}
          initial={open.broadcast}
          classes={classes.data?.classes}
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
          <p>这条广播改过的地方还没保存。要留着的话，回去先保存。</p>
        </Confirm>
      )}
    </div>
  )
}
