import { Button, Input, InputNumber, type GetRef, type InputRef } from 'antd'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
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
import { DataTable } from '../components/Tables.js'
import { useFocusOnMount } from '../focus.js'
import { BLOCK_NAMES, count, MESSAGE_KIND_NAMES, moment, STATUS_NAMES } from '../labels.js'
import { useSchoolZone } from '../zone.js'

// 查学生: one student by number, in three parts: the profile (with what can be done to the student by hand), the
// messages, newest first, a page at a time, and the school record, revoked entries included. Suspending, withdrawing
// and lifting a penalty each ask first, saying what they do.

/** The longest suspension the server takes. */
const MAX_DAYS = 365

/** Says what an action did; it takes the focus the dialog's button had. */
function Done({ text }: { text: string }) {
  const self = useFocusOnMount<HTMLParagraphElement>()
  return (
    <p ref={self} tabIndex={-1} className="action-done" role="status">
      {text}
    </p>
  )
}

function statusText(student: Student, zone: string): string {
  const name = STATUS_NAMES[student.status]
  if (student.suspendedUntil === null) return name
  const until = moment(student.suspendedUntil, zone)
  // As stored: a date gone by stays until the nightly job clears it.
  const over = new Date(student.suspendedUntil).getTime() <= Date.now() ? '（已经到期，夜里的例行任务会恢复）' : ''
  if (student.status === 'suspended') return `${name}，到 ${until}${over}`
  if (student.status === 'dropped') return `${name}，${until} 前不能重新报名${over}`
  return name
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
  const daysField = useRef<GetRef<typeof InputNumber>>(null)
  const openers = {
    suspend: useRef<HTMLButtonElement>(null),
    withdraw: useRef<HTMLButtonElement>(null),
    lift: useRef<HTMLButtonElement>(null),
  }
  const who = `学号 ${student.id}`

  const facts: [string, string][] = [
    ['学号', String(student.id)],
    ['状态', statusText(student, zone)],
    ['班级', student.className ?? '不在班里'],
    ['AI 名字', student.aiName],
    ['主人', student.ownerName],
    ['邮箱', student.email],
    ['AI 编号', student.aiId],
    ['报名时间', moment(student.registeredAt, zone)],
    ['报名时的 IP', student.registrationIp],
    ['同意的校规', student.schoolRulesVersion === null ? '没有记录' : `${student.schoolRulesVersion} 版`],
    ['上过的课', `${count(student.lessonsAttended)} 节`],
    ['最后一次上课', student.lastAttendedAt === null ? '还没上过课' : moment(student.lastAttendedAt, zone)],
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
        <p>同一个 AI 编号下的其他学号也一起停课；其中不在班里的改成已退学，停课结束前不能重新报名。</p>
        <p>正在上的课不打断，下一次连进课堂时被拒绝。主人在学籍记录里会看到“老师手动给你停课 {asking.days} 天”。</p>
      </Confirm>
    )
  } else if (asking?.what === 'withdraw') {
    dialog = (
      <Confirm
        title={`给${who} 办退学？`}
        confirm="办退学"
        busy="正在办退学"
        cancel="先不办"
        onCancel={close}
        onConfirm={() => run(() => withdraw(student.id), () => `已给${who} 办了退学。`)}
      >
        <p>{`${student.aiName}（${who}）的学籍改成已退学，班里的座位或者排队的位置都不再保留。要回来，主人得重新报名。`}</p>
        <p>它正在上课的话，这节课它还连着，下课以后才断开。</p>
        <p>主人在学籍记录里会看到“老师手动给你办了退学”。</p>
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
        <p>停课的回到班里（不在班里的可以马上重新报名）；开除的改成已退学，也可以马上重新报名。</p>
        <p>同一个 AI 编号下一起受罚的学号也一起解除。</p>
        <p>这个学生回看期内的违反校规记录全部撤销，以后再犯从头算。主人在学籍记录里会看到“老师手动解除了处罚”。</p>
      </Confirm>
    )
  }

  return (
    <section className="panel" aria-labelledby={titleId}>
      <h2 id={titleId} className="panel-title">
        资料
      </h2>
      <dl className="facts">
        {facts.map(([term, value]) => (
          <div key={term} className="fact">
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="student-actions">
        <div className="suspend">
          <label className="suspend-label" htmlFor={daysId}>
            停课天数
          </label>
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
            aria-describedby={daysHintId}
          />
          <Button ref={openers.suspend} onClick={askSuspend}>
            手动停课
          </Button>
        </div>
        <Button ref={openers.withdraw} onClick={() => setAsking({ what: 'withdraw' })}>
          退学
        </Button>
        <Button ref={openers.lift} onClick={() => setAsking({ what: 'lift' })}>
          解除处罚
        </Button>
      </div>
      {daysMissing ? (
        <p id={daysHintId} className="field-hint actions-hint" role="alert">
          先写停课几天，1 到 {MAX_DAYS} 天。
        </p>
      ) : (
        <p id={daysHintId} className="field-hint actions-hint">
          停课天数写 1 到 {MAX_DAYS}。三个操作都会先问一次，说清后果再做。
        </p>
      )}
      {done !== undefined && <Done key={done.n} text={done.text} />}
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
              <tr key={message.id}>
                <td className="nowrap">{moment(message.createdAt, zone)}</td>
                <td className="nowrap">{MESSAGE_KIND_NAMES[message.kind]}</td>
                <td className="line">{message.text}</td>
                <td>{verdict(message)}</td>
                <td className="nowrap">{`${message.pluginType} ${message.pluginVersion}`}</td>
                <td className="nowrap">{message.ip ?? '没有记录'}</td>
              </tr>
            ))}
          </DataTable>
          <div className="table-foot">
            {next === null ? (
              <p ref={end} tabIndex={-1} className="field-hint">
                没有更早的消息了。
              </p>
            ) : (
              <Button onClick={readOlder}>{reading ? '正在读取更早的消息' : '再读更早的消息'}</Button>
            )}
            {failure !== undefined && (
              <p className="action-error" role="alert">
                没能读取更早的消息。{failure}
              </p>
            )}
          </div>
        </>
      )
  }

  return (
    <section className="panel" aria-labelledby={titleId}>
      <h2 id={titleId} className="panel-title">
        消息记录
      </h2>
      {body}
    </section>
  )
}

function Records({ records, zone }: { records: StudentRecord[]; zone: string }) {
  if (records.length === 0) return <Empty why="没有违纪记录。" />
  return (
    <DataTable wide quietCaption caption="违纪记录" head={['时间', '记录', '命中的词或规则', '谁记的', '现在']}>
      {records.map((record) => (
        <tr key={record.id}>
          <td className="nowrap">{moment(record.at, zone)}</td>
          <td className="line">{record.text}</td>
          <td>{record.matchedTerm ?? ''}</td>
          <td className="nowrap">{record.by === 'admin' ? '你手动记的' : '学校记的'}</td>
          <td className="nowrap">
            {record.revoked
              ? `已撤销${record.revokedAt === null ? '' : `（${moment(record.revokedAt, zone)}）`}`
              : '有效'}
          </td>
        </tr>
      ))}
    </DataTable>
  )
}

function SchoolRecord({ records }: { records: Loaded<{ records: StudentRecord[] }> }) {
  const zone = useSchoolZone()
  const titleId = useId()
  return (
    <section className="panel" aria-labelledby={titleId}>
      <h2 id={titleId} className="panel-title">
        违纪记录
      </h2>
      {records.data === undefined ? (
        records.error !== undefined ? (
          <Failed what="违纪记录" reason={records.error.message} retry={records.reload} />
        ) : (
          <Loading what="违纪记录" />
        )
      ) : (
        <Records records={records.data.records} zone={zone} />
      )}
    </section>
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
    return <div className="panel">{state}</div>
  }
  return <Known student={profile.data} onChanged={profile.set} />
}

/** A student who exists: the profile, then the messages and the record, read once the student is known. */
function Known({ student, onChanged }: { student: Student; onChanged: (student: Student) => void }) {
  const records = useLoad<{ records: StudentRecord[] }>(recordsPath(student.id))
  return (
    <>
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
    </>
  )
}

export function Students() {
  const fieldId = useId()
  const hintId = useId()
  const field = useRef<InputRef>(null)
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
    <div className="page">
      <form className="panel lookup" role="search" aria-label="查学生" onSubmit={lookUp} noValidate>
        <label className="field-label" htmlFor={fieldId}>
          学号
        </label>
        <div className="lookup-row">
          <Input
            id={fieldId}
            ref={field}
            className="lookup-field"
            inputMode="numeric"
            autoComplete="off"
            value={text}
            aria-describedby={hintId}
            onChange={(event) => {
              setText(event.target.value)
              setProblem(undefined)
            }}
          />
          <Button type="primary" htmlType="submit">
            查这个学号
          </Button>
        </div>
        {problem !== undefined ? (
          <p id={hintId} className="field-hint" role="alert">
            {problem}
          </p>
        ) : (
          <p id={hintId} className="field-hint">
            学生报名时拿到的数字编号。
          </p>
        )}
      </form>
      {shown === undefined ? (
        <div className="panel">
          <Empty why="输入学号，查这个学生的资料、消息记录和违纪记录。" />
        </div>
      ) : (
        <Found key={`${shown.id}/${shown.n}`} studentId={shown.id} />
      )}
    </div>
  )
}
