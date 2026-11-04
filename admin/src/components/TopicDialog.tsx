import { Button, Input, Modal, Radio } from 'antd'
import { useId, useState, type ReactNode } from 'react'
import {
  putTopic,
  TOPICS_PATH,
  useLoad,
  type ApiError,
  type Division,
  type GivenTopic,
  type LessonQueue,
  type Loaded,
  type QueueSlot,
} from '../api.js'
import { useFocusOnMount } from '../focus.js'
import { addDays, DIVISION_NAMES, shortDayName } from '../labels.js'

// 给某一天指定题目: a topic for one division on any school day after today, however far ahead (a festival months away,
// say). The server says why a day will not do (a weekend, a break). A lesson already approved is made again for a new
// topic, so that is asked first. Under the form, the topics given for the days after today: one picked there comes up
// in the form, to change or take away.

const DIVISIONS = Object.keys(DIVISION_NAMES) as Division[]

/**
 * A sentence that takes the focus when it appears: the question before an approved lesson is made again, or the
 * server's refusal. Either way the button pressed is gone or disabled, and Esc still has to reach the dialog.
 */
function Said({ children, className }: { children: ReactNode; className: string }) {
  const self = useFocusOnMount<HTMLParagraphElement>()
  return (
    <p ref={self} tabIndex={-1} className={className} role="alert">
      {children}
    </p>
  )
}

/** The topics given for the days after today, each one a button that brings it up in the form. */
function GivenTopics({
  given,
  today,
  chosen,
  onPick,
}: {
  given: Loaded<{ topics: GivenTopic[] }>
  today: string
  chosen: { date: string; division: Division }
  onPick: (topic: GivenTopic) => void
}) {
  const titleId = useId()
  const later = given.data?.topics.filter((t) => t.date > today) ?? []
  let body: ReactNode
  if (given.data === undefined && given.error !== undefined) {
    body = (
      <div className="topic-list-state" role="alert">
        <p>没能读取已经指定的题目。{given.error.message}</p>
        <Button size="small" onClick={given.reload}>
          重新读取
        </Button>
      </div>
    )
  } else if (given.data === undefined) {
    body = (
      <p className="topic-list-state" role="status">
        正在读取已经指定的题目
      </p>
    )
  } else if (later.length === 0) {
    body = <p className="topic-list-state">明天以后还没有指定题目。</p>
  } else {
    body = (
      <ul className="topic-list" aria-labelledby={titleId}>
        {later.map((t) => (
          <li key={`${t.date}/${t.division}`}>
            <Button
              size="small"
              type="text"
              aria-pressed={t.date === chosen.date && t.division === chosen.division}
              onClick={() => onPick(t)}
            >
              {shortDayName(t.date)} {DIVISION_NAMES[t.division]}《{t.topic}》
            </Button>
          </li>
        ))}
      </ul>
    )
  }
  return (
    <section className="topic-given" aria-labelledby={titleId}>
      <h3 id={titleId} className="field-label">
        已经指定的题目
      </h3>
      {later.length > 0 && <p className="field-hint">点一个，它会出现在上面，可以改，也可以取消。</p>}
      {body}
    </section>
  )
}

export function TopicDialog({
  queue,
  initial,
  onClose,
  onDone,
}: {
  queue: LessonQueue
  /** The day and division to start from, when it is one that can be given a topic. */
  initial?: { date: string; division: Division }
  onClose: () => void
  /** `notice` says what was done, in a sentence. */
  onDone: (notice: string, date: string, division: Division) => void
}) {
  const tomorrow = addDays(queue.today, 1)
  const start =
    initial !== undefined && initial.date > queue.today
      ? initial
      : { date: queue.days.find((day) => day.date > queue.today)?.date ?? tomorrow, division: 'primary' as const }
  const [date, setDate] = useState(start.date)
  const [division, setDivision] = useState<Division>(start.division)
  // Read here for the list under the form, and for the days past the queue's, which have no slot to say their topic.
  const given = useLoad<{ topics: GivenTopic[] }>(TOPICS_PATH)
  const slotOf = (on: string, of: Division): QueueSlot | undefined =>
    queue.days.find((day) => day.date === on)?.divisions.find((slot) => slot.division === of)
  const givenOf = (on: string, of: Division): string | null =>
    given.data?.topics.find((t) => t.date === on && t.division === of)?.topic ?? slotOf(on, of)?.topic ?? null
  const [topic, setTopic] = useState(givenOf(date, division) ?? '')
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  const [refusal, setRefusal] = useState<{ reason: string; n: number }>()
  const ids = { date: useId(), topic: useId(), now: useId() }

  const slot = slotOf(date, division)
  const now = givenOf(date, division)
  const label = slot?.label ?? DIVISION_NAMES[division]

  /** Another day or division: its own topic, if it has one, is the one to change. */
  function choose(nextDate: string, nextDivision: Division) {
    setDate(nextDate)
    setDivision(nextDivision)
    setTopic(givenOf(nextDate, nextDivision) ?? '')
    setConfirming(false)
    setRefusal(undefined)
  }

  async function send(value: string | null) {
    if (date === '') {
      setRefusal((last) => ({ reason: '先选一个日期。', n: (last?.n ?? 0) + 1 }))
      return
    }
    setSending(true)
    setRefusal(undefined)
    try {
      const { result } = await putTopic(date, division, value)
      const day = shortDayName(date)
      const notice =
        value === null
          ? `已取消 ${day} ${label}的题目。`
          : `已给 ${day} ${label}指定题目《${value.trim()}》。` +
            (result === 'regenerating' ? '这节课已经回到待审，正在按新题目重新生成，新稿出来以后再审。' : '')
      onDone(notice, date, division)
    } catch (error) {
      setRefusal((last) => ({ reason: (error as ApiError).message, n: (last?.n ?? 0) + 1 }))
      setSending(false)
      setConfirming(false)
    }
  }

  function give() {
    // An approved lesson made again goes back to review: say so before it happens.
    const remakes = slot?.status === 'approved' && topic.trim() !== (slot.topic ?? '')
    if (remakes && !confirming) setConfirming(true)
    else void send(topic)
  }

  const manual = queue.mode === 'manual'
  const footer = confirming ? (
    <>
      <Button onClick={() => setConfirming(false)} disabled={sending}>
        先不改
      </Button>
      <Button type="primary" onClick={give} disabled={sending}>
        按新题目重写
      </Button>
    </>
  ) : (
    <>
      <Button onClick={onClose}>关闭</Button>
      {now !== null && (
        <Button onClick={() => void send(null)} disabled={sending}>
          取消题目
        </Button>
      )}
      <Button type="primary" onClick={give} disabled={sending}>
        指定这个题目
      </Button>
    </>
  )

  return (
    <Modal open title="给某一天指定题目" closable={false} destroyOnHidden onCancel={onClose} footer={footer}>
      <div className="topic-form">
        <p className="dialog-hint">
          只给选中的学部定题目，其余学部照常上那天的科目。今天的课已经定了，可以选明天以后的任何一个上学日，几个月以后的也行。
        </p>
        <label className="field-label" htmlFor={ids.date}>
          日期
        </label>
        <Input
          id={ids.date}
          type="date"
          className="date-input"
          value={date}
          min={tomorrow}
          onChange={(event) => choose(event.target.value, division)}
        />
        <fieldset className="field-set">
          <legend className="field-label">学部</legend>
          <Radio.Group
            value={division}
            onChange={(event) => choose(date, event.target.value as Division)}
            options={DIVISIONS.map((key) => ({ value: key, label: slotOf(date, key)?.label ?? DIVISION_NAMES[key] }))}
          />
        </fieldset>
        <label className="field-label" htmlFor={ids.topic}>
          题目
        </label>
        <Input
          id={ids.topic}
          value={topic}
          maxLength={60}
          showCount
          aria-describedby={ids.now}
          onChange={(event) => {
            setTopic(event.target.value)
            setConfirming(false)
          }}
        />
        <p id={ids.now} className="field-hint">
          {now !== null ? `现在的题目：《${now}》。` : '这一天这个学部还没有指定题目。'}
          {slot !== undefined &&
            slot.status !== 'missing' &&
            slot.status !== 'approved' &&
            (manual
              ? '这节课已经生成了，换了题目会撤掉，要按新题目重新复制提示词、粘贴结果。'
              : '这节课已经生成了，换了题目会按新题目重新生成。')}
          {now !== null && slot !== undefined && slot.status !== 'missing' && '取消题目不会撤掉已经做好的课。'}
        </p>
        {confirming && (
          <Said className="topic-confirm">
            {shortDayName(date)} {label}的课已经通过了。这节课会按新题目重写，需要重新审。
            {manual && '现在是手动粘贴：它会撤掉，要重新复制提示词、粘贴结果。'}
          </Said>
        )}
        {refusal !== undefined && (
          <Said key={refusal.n} className="action-error">
            {refusal.reason}
          </Said>
        )}
        <GivenTopics given={given} today={queue.today} chosen={{ date, division }} onPick={(t) => choose(t.date, t.division)} />
      </div>
    </Modal>
  )
}
