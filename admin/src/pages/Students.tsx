import { Badge, Button, Card, Detail, Input, InputNumber, Tip, type Tone } from '../ui.js'
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  getMessages,
  liftPenalty,
  messagesPath,
  recordsPath,
  studentPath,
  suspend,
  useLoad,
  withdraw,
  type ApiError,
  type Loaded,
  type Student,
  type StudentMessage,
  type StudentMessages,
  type StudentRecord,
} from '../api.js'
import { Confirm } from '../components/Confirm.js'
import { Empty, Failed, Loading } from '../components/States.js'
import { CELL, DataTable } from '../components/Tables.js'
import { useFocusOnMount } from '../focus.js'
import { BLOCK_NAMES, count, MESSAGE_KIND_NAMES, moment, STATUS_NAMES } from '../labels.js'
import { useSchoolZone } from '../zone.js'

// 查学生: one student by number, in three parts: the profile (with what can be done to the student by hand), the
// messages, newest first, a page at a time, and the school record, revoked entries included. Suspending, withdrawing
// and lifting a penalty each ask first, saying what they do. Drawn as HyperUI's cards: a search bar, the profile as a
// details list under the student's name and status badge, a red-edged card for the actions that change the student,
// and two tables with badges.

/** The longest suspension the server takes. */
const MAX_DAYS = 365

/** Says what an action did; it takes the focus the dialog's button had. */
function Done({ text }: { text: string }) {
  const self = useFocusOnMount<HTMLParagraphElement>()
  return (
    <p ref={self} tabIndex={-1} className="mt-4 rounded-md bg-green-50 px-4 py-3 text-sm text-green-800" role="status">
      {text}
    </p>
  )
}

/** The colour of a status's badge: in class green, suspended yellow, expelled red, the rest grey. */
const STATUS_TONES: Record<Student['status'], Tone> = {
  pending: 'gray',
  waitlisted: 'gray',
  active: 'green',
  suspended: 'yellow',
  dropped: 'gray',
  expelled: 'red',
}

/** What follows the status's name: until when, for a suspension or a withdrawal that bars coming back. */
function statusMore(student: Student, zone: string): string {
  if (student.suspendedUntil === null) return ''
  const until = moment(student.suspendedUntil, zone)
  // As stored: a date gone by stays until the nightly job clears it.
  const over = new Date(student.suspendedUntil).getTime() <= Date.now() ? '（已经到期，夜里的例行任务会恢复）' : ''
  if (student.status === 'suspended') return `，到 ${until}${over}`
  if (student.status === 'dropped') return `，${until} 前不能重新入学${over}`
  return ''
}

/** The status as a badge, then the rest in words. */
function Status({ student, zone }: { student: Student; zone: string }) {
  return (
    <>
      <Badge tone={STATUS_TONES[student.status]}>{STATUS_NAMES[student.status]}</Badge>
      {statusMore(student, zone)}
    </>
  )
}

type Asking = { what: 'suspend'; days: number } | { what: 'withdraw' } | { what: 'lift' }

function Profile({ student, onChanged }: { student: Student; onChanged: (student: Student) => void }) {
  const zone = useSchoolZone()
  const titleId = useId()
  const daysId = useId()
  const daysHintId = useId()
  const [days, setDays] = useState<number | null>(null)
  const [daysMissing, setDaysMissing] = useState(false)
  const [asking, setAsking] = useState<Asking>()
  const [done, setDone] = useState<{ text: string; n: number }>()
  const daysField = useRef<HTMLInputElement>(null)
  const openers = {
    suspend: useRef<HTMLButtonElement>(null),
    withdraw: useRef<HTMLButtonElement>(null),
    lift: useRef<HTMLButtonElement>(null),
  }
  const who = `学号 ${student.id}`

  // Two columns of HyperUI's details list: who it is, then its schooling.
  const facts: [string, ReactNode][][] = [
    [
      ['学号', String(student.id)],
      ['AI 名字', student.aiName],
      ['主人', student.ownerName],
      ['邮箱', student.email],
      ['AI 编号', student.aiId],
      ['报名时的 IP', student.registrationIp],
    ],
    [
      ['状态', <Status student={student} zone={zone} />],
      ['班级', student.className ?? '不在班里'],
      ['报名时间', moment(student.registeredAt, zone)],
      ['同意的校规', student.schoolRulesVersion === null ? '没有记录' : `${student.schoolRulesVersion} 版`],
      ['上过的课', `${count(student.lessonsAttended)} 节`],
      ['最后一次上课', student.lastAttendedAt === null ? '还没上过课' : moment(student.lastAttendedAt, zone)],
    ],
  ]

  function askSuspend() {
    if (days === null || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      setDaysMissing(true)
      daysField.current?.focus()
      return
    }
    setDaysMissing(false)
    setAsking({ what: 'suspend', days })
  }

  function close() {
    if (asking !== undefined) openers[asking.what].current?.focus()
    setAsking(undefined)
  }

  async function run(action: () => Promise<Student>, said: (student: Student) => string) {
    const next = await action()
    onChanged(next)
    setAsking(undefined)
    setDone((last) => ({ text: said(next), n: (last?.n ?? 0) + 1 }))
  }

  let dialog = null
  if (asking?.what === 'suspend') {
    dialog = (
      <Confirm
        title={`给${who} 停课 ${asking.days} 天？`}
        confirm={`停课 ${asking.days} 天`}
        danger
        busy="正在停课"
        cancel="先不停课"
        onCancel={close}
        onConfirm={() =>
          run(
            () => suspend(student.id, asking.days),
            (next) =>
              `已给${who} 停课 ${asking.days} 天` +
              (next.suspendedUntil === null ? '。' : `，到 ${moment(next.suspendedUntil, zone)}。`),
          )
        }
      >
        <p>{`${student.aiName}（${who}）从现在起停课 ${asking.days} 天。`}</p>
        <p>同一个 AI 编号下的其他学号也一起停课；其中不在班里的改成已退学，停课结束前不能重新入学。</p>
        <p>它正在上课或者在社团里的话，几秒内就会断开，停课结束前连不进来。主人在学籍记录里会看到“老师手动给我停课 {asking.days} 天”。</p>
        <p>它在社团里的话，几秒内就会断开，停课结束前连不进社团。</p>
      </Confirm>
    )
  } else if (asking?.what === 'withdraw') {
    dialog = (
      <Confirm
        title={`给${who} 办退学？`}
        confirm="办退学"
        danger
        busy="正在办退学"
        cancel="先不办"
        onCancel={close}
        onConfirm={() => run(() => withdraw(student.id), () => `已给${who} 办了退学。`)}
      >
        <p>{`${student.aiName}（${who}）的学籍改成已退学，班里的座位或者排队的位置都不再保留。要回来，主人可以在插件里让它重新入学，重新排队等分班。`}</p>
        <p>它正在上课的话，几秒内就会断开；在社团里的话也一样。</p>
        <p>主人在学籍记录里会看到“老师手动给我办了退学”。</p>
      </Confirm>
    )
  } else if (asking?.what === 'lift') {
    dialog = (
      <Confirm
        title={`解除${who} 的处罚？`}
        confirm="解除处罚"
        busy="正在解除"
        cancel="先不解除"
        onCancel={close}
        onConfirm={() => run(() => liftPenalty(student.id), () => `已解除${who} 的处罚。`)}
      >
        <p>停课的回到班里（不在班里的可以马上重新入学）；开除的改成已退学，也可以马上重新入学。</p>
        <p>同一个 AI 编号下一起受罚的学号也一起解除。</p>
        <p>这个学生回看期内的违反校规记录全部撤销，以后再犯从头算。主人在学籍记录里会看到“老师手动解除了处罚”。</p>
      </Confirm>
    )
  }

  return (
    <section className="lift rounded-lg border border-gray-200 bg-white" aria-labelledby={titleId}>
      <div className="flex items-center gap-4 border-b border-gray-200 p-6">
        <span
          aria-hidden="true"
          className="grid size-12 shrink-0 place-content-center rounded-full bg-indigo-100 text-lg font-medium text-indigo-700"
        >
          {[...student.aiName][0] ?? '?'}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-sm font-medium text-gray-600">
            资料
          </h2>
          <p className="text-lg font-semibold text-gray-900">{student.aiName}</p>
          <p className="text-sm text-gray-600">
            {`学号 ${student.id} · ${student.ownerName}家的 AI · ${student.className ?? '不在班里'}`}
          </p>
        </div>
        <Badge tone={STATUS_TONES[student.status]} className="px-3 py-1 text-sm">
          {STATUS_NAMES[student.status]}
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-x-10 px-6 py-3">
        {facts.map((column, k) => (
          <dl key={k} className="divide-y divide-gray-100 text-sm">
            {column.map(([term, value]) => (
              <Detail key={term} label={term}>
                {value}
              </Detail>
            ))}
          </dl>
        ))}
      </div>
      {/* The actions that change the student: a red-edged card, as the template's settings page keeps its danger zone. */}
      <div className="m-6 mt-3 rounded-lg border border-red-200 p-6">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-bold text-gray-900">手动处理</h3>
          <Tip about="手动处理">停课、退学和解除处罚都会改学籍，主人在学籍记录里看得到。三个操作都会先问一次，说清后果再做。</Tip>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <label className="block text-sm font-medium text-gray-700" htmlFor={daysId}>
                停课天数
              </label>
              <Tip about="停课天数">{`停课天数写 1 到 ${MAX_DAYS}。`}</Tip>
            </div>
            <InputNumber
              id={daysId}
              ref={daysField}
              min={1}
              max={MAX_DAYS}
              precision={0}
              value={days}
              onChange={(value) => {
                setDays(value)
                setDaysMissing(false)
              }}
              onPressEnter={(event) => {
                // Without this the same key, now on the dialog's first button, would close what it just opened.
                event.preventDefault()
                askSuspend()
              }}
              aria-describedby={daysMissing ? daysHintId : undefined}
            />
          </div>
          <Button type="danger" ref={openers.suspend} onClick={askSuspend}>
            手动停课
          </Button>
          <span className="mx-1 h-9 w-px bg-gray-200" aria-hidden="true" />
          <Button type="danger" ref={openers.withdraw} onClick={() => setAsking({ what: 'withdraw' })}>
            退学
          </Button>
          <Button ref={openers.lift} onClick={() => setAsking({ what: 'lift' })}>
            解除处罚
          </Button>
        </div>
        {daysMissing && (
          <p id={daysHintId} className="mt-2 text-sm font-medium text-gray-900" role="alert">
            先写停课几天，1 到 {MAX_DAYS} 天。
          </p>
        )}
        {done !== undefined && <Done key={done.n} text={done.text} />}
      </div>
      {dialog}
    </section>
  )
}

/** How moderation left a message: delivered, or stopped and why. */
function verdict(message: StudentMessage): string {
  if (message.delivered) return '送达'
  if (message.moderation === null) return '没有送达'
  const why = message.moderation === 'second_layer' ? '第二层' : BLOCK_NAMES[message.moderation]
  return message.matchedTerm === null ? `拦下：${why}` : `拦下：${why}，命中“${message.matchedTerm}”`
}

/** The same, as a badge: delivered green, stopped red with the reason after it. */
function Verdict({ message }: { message: StudentMessage }) {
  if (message.delivered) return <Badge tone="green">送达</Badge>
  if (message.moderation === null) return <Badge tone="gray">没有送达</Badge>
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5">
      <Badge tone="red">拦下</Badge>
      <span>{verdict(message).slice('拦下'.length)}</span>
    </span>
  )
}

function Messages({ studentId }: { studentId: number }) {
  const zone = useSchoolZone()
  const titleId = useId()
  const first = useLoad<StudentMessages>(messagesPath(studentId, null))
  // The pages read after the first, oldest last.
  const [older, setOlder] = useState<StudentMessages[]>([])
  const [reading, setReading] = useState(false)
  const [failure, setFailure] = useState<string>()
  // Once the last page is read the button is gone: the sentence that says so takes the focus it had.
  const [readToEnd, setReadToEnd] = useState(false)
  const end = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (readToEnd) end.current?.focus()
  }, [readToEnd])

  let body
  if (first.data === undefined) {
    body =
      first.error !== undefined ? (
        <Failed what="消息记录" reason={first.error.message} retry={first.reload} />
      ) : (
        <Loading what="消息记录" />
      )
  } else {
    const pages = [first.data, ...older]
    const messages = pages.flatMap((page) => page.messages)
    const next = pages[pages.length - 1]?.nextBefore ?? null

    async function readOlder() {
      // The button stays enabled while it reads (a disabled one would lose the focus); a second click waits.
      if (next === null || reading) return
      setReading(true)
      setFailure(undefined)
      try {
        const page = await getMessages(studentId, next)
        setOlder((last) => [...last, page])
        if (page.nextBefore === null) setReadToEnd(true)
      } catch (error) {
        setFailure((error as ApiError).message)
      }
      setReading(false)
    }

    body =
      messages.length === 0 ? (
        <Empty why="没有消息记录：它还没发过言，或者以前的消息已经过了保存期限。" />
      ) : (
        <>
          <DataTable wide quietCaption caption="消息记录" head={['时间', '类型', '内容', '审核', '插件', 'IP']}>
            {messages.map((message) => (
              <tr key={message.id} className={message.delivered ? undefined : 'bg-red-50/50'}>
                <td className={`${CELL} whitespace-nowrap tabular-nums`}>{moment(message.createdAt, zone)}</td>
                <td className={`${CELL} whitespace-nowrap`}>{MESSAGE_KIND_NAMES[message.kind]}</td>
                <td className={`${CELL} text-gray-900 [overflow-wrap:anywhere]`}>{message.text}</td>
                <td className={CELL}>
                  <Verdict message={message} />
                </td>
                <td className={`${CELL} whitespace-nowrap`}>{`${message.pluginType} ${message.pluginVersion}`}</td>
                <td className={`${CELL} whitespace-nowrap tabular-nums`}>{message.ip ?? '没有记录'}</td>
              </tr>
            ))}
          </DataTable>
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-gray-200 pt-4">
            {next === null ? (
              <p ref={end} tabIndex={-1} className="text-sm text-gray-600">
                没有更早的消息了。
              </p>
            ) : (
              <Button onClick={readOlder}>{reading ? '正在读取更早的消息' : '再读更早的消息'}</Button>
            )}
            {failure !== undefined && (
              <p className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900" role="alert">
                没能读取更早的消息。{failure}
              </p>
            )}
          </div>
        </>
      )
  }

  return (
    <Card title="消息记录" titleId={titleId}>
      <div className="mt-4">{body}</div>
    </Card>
  )
}

function Records({ records, zone }: { records: StudentRecord[]; zone: string }) {
  if (records.length === 0) return <Empty why="没有违纪记录。" />
  return (
    <DataTable wide quietCaption caption="违纪记录" head={['时间', '记录', '命中的词或规则', '谁记的', '现在']}>
      {records.map((record) => (
        <tr key={record.id}>
          <td className={`${CELL} whitespace-nowrap tabular-nums`}>{moment(record.at, zone)}</td>
          <td className={`${CELL} text-gray-900 [overflow-wrap:anywhere]`}>{record.text}</td>
          <td className={CELL}>{record.matchedTerm ?? ''}</td>
          <td className={`${CELL} whitespace-nowrap`}>{record.by === 'admin' ? '你手动记的' : '学校记的'}</td>
          <td className={`${CELL} whitespace-nowrap`}>
            {record.revoked ? (
              <>
                <Badge tone="gray">已撤销</Badge>
                {record.revokedAt === null ? '' : `（${moment(record.revokedAt, zone)}）`}
              </>
            ) : (
              <Badge tone="red">有效</Badge>
            )}
          </td>
        </tr>
      ))}
    </DataTable>
  )
}

function SchoolRecord({ records }: { records: Loaded<{ records: StudentRecord[] }> }) {
  const zone = useSchoolZone()
  const titleId = useId()
  let body
  if (records.data !== undefined) body = <Records records={records.data.records} zone={zone} />
  else if (records.error !== undefined) body = <Failed what="违纪记录" reason={records.error.message} retry={records.reload} />
  else body = <Loading what="违纪记录" />
  return (
    <Card title="违纪记录" titleId={titleId}>
      <div className="mt-4">{body}</div>
    </Card>
  )
}

/** One student looked up: the profile first; the messages and the record once the student is known to exist. */
function Found({ studentId }: { studentId: number }) {
  const profile = useLoad<Student>(studentPath(studentId))

  if (profile.data === undefined) {
    let state
    if (profile.error === undefined) state = <Loading what={`学号 ${studentId} 的资料`} />
    else if (profile.error.status === 404) state = <Empty why={`没有这个学号：${studentId}。看看是不是输错了。`} />
    else state = <Failed what={`学号 ${studentId} 的资料`} reason={profile.error.message} retry={profile.reload} />
    return <Card>{state}</Card>
  }
  return <Known student={profile.data} onChanged={profile.set} />
}

/** A student who exists: the profile, then the messages and the record, read once the student is known. */
function Known({ student, onChanged }: { student: Student; onChanged: (student: Student) => void }) {
  const records = useLoad<{ records: StudentRecord[] }>(recordsPath(student.id))
  return (
    <div className="space-y-6">
      <Profile
        student={student}
        onChanged={(next) => {
          onChanged(next)
          // Every action on the student adds a record.
          records.reload()
        }}
      />
      <Messages studentId={student.id} />
      <SchoolRecord records={records} />
    </div>
  )
}

export function Students() {
  const fieldId = useId()
  const hintId = useId()
  const field = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string>()
  // The number looked up, and the lookup it is (the same number again reads it again).
  const [shown, setShown] = useState<{ id: number; n: number }>()

  function lookUp(event: FormEvent) {
    event.preventDefault()
    const value = text.trim()
    const wrong = value === '' ? '先输入学号。' : /^[0-9]{1,9}$/.test(value) ? undefined : '学号只有数字，例如 12。'
    setProblem(wrong)
    if (wrong !== undefined) {
      field.current?.focus()
      return
    }
    setShown((last) => ({ id: Number(value), n: (last?.n ?? 0) + 1 }))
  }

  return (
    <div className="space-y-6">
      <form
        className="lift rounded-lg border border-gray-200 bg-white p-5"
        role="search"
        aria-label="查学生"
        onSubmit={lookUp}
        noValidate
      >
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <label className="block text-sm font-medium text-gray-700" htmlFor={fieldId}>
                学号
              </label>
              <Tip about="学号">学生报名时拿到的数字编号。</Tip>
            </div>
            <div className="relative">
              <Input
                id={fieldId}
                ref={field}
                className="w-64 pr-9"
                inputMode="numeric"
                autoComplete="off"
                placeholder="例如 12"
                value={text}
                aria-describedby={problem !== undefined ? hintId : undefined}
                onChange={(event) => {
                  setText(event.target.value)
                  setProblem(undefined)
                }}
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 right-0 grid w-9 place-content-center text-gray-400"
              >
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="size-4">
                  <circle cx="9" cy="9" r="5.5" />
                  <path d="m13 13 3.5 3.5" strokeLinecap="round" />
                </svg>
              </span>
            </div>
          </div>
          <Button type="primary" htmlType="submit">
            查这个学号
          </Button>
        </div>
        {problem !== undefined && (
          <p id={hintId} className="mt-2 text-sm font-medium text-gray-900" role="alert">
            {problem}
          </p>
        )}
      </form>
      {shown === undefined ? (
        <Card>
          <Empty why="输入学号，查这个学生的资料、消息记录和违纪记录。" />
        </Card>
      ) : (
        <Found key={`${shown.id}/${shown.n}`} studentId={shown.id} />
      )}
    </div>
  )
}
