import { Button, Input, Modal, Radio } from 'antd'
import { useId, useState, type ReactNode } from 'react'
import { putTopic, type ApiError, type Division, type LessonQueue, type QueueSlot } from '../api.js'
import { useFocusOnMount } from '../focus.js'
import { DIVISION_NAMES, localDay, shortDayName } from '../labels.js'

// 给某一天指定题目: a topic for one division on one lesson day after today. The days to choose from are the queue's; a
// lesson already approved is made again for a new topic, so that is asked first.

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

/** The lesson days of the queue after today, by this computer's clock: today's lessons are settled already. */
function laterDays(queue: LessonQueue) {
  const today = localDay(new Date().toISOString())
  return queue.days.filter((day) => day.date > today)
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
  const days = laterDays(queue)
  const start = days.some((day) => day.date === initial?.date) ? initial : undefined
  const [date, setDate] = useState(start?.date ?? days[0]?.date)
  const [division, setDivision] = useState<Division>(start?.division ?? 'primary')
  const slotOf = (on: string | undefined, of: Division): QueueSlot | undefined =>
    days.find((day) => day.date === on)?.divisions.find((slot) => slot.division === of)
  const [topic, setTopic] = useState(slotOf(date, division)?.topic ?? '')
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  const [refusal, setRefusal] = useState<{ reason: string; n: number }>()
  const ids = { topic: useId(), now: useId() }

  const slot = slotOf(date, division)
  const label = slot?.label ?? DIVISION_NAMES[division]

  /** Another day or division: its own topic, if it has one, is the one to change. */
  function choose(nextDate: string | undefined, nextDivision: Division) {
    setDate(nextDate)
    setDivision(nextDivision)
    setTopic(slotOf(nextDate, nextDivision)?.topic ?? '')
    setConfirming(false)
    setRefusal(undefined)
  }

  async function send(value: string | null) {
    if (date === undefined) return
    setSending(true)
    setRefusal(undefined)
    try {
      const { result } = await putTopic(date, division, value)
      const day = shortDayName(date)
      const notice =
        value === null
          ? `已取消 ${day} ${label}的题目。`
          : `已给 ${day} ${label}指定题目《${value.trim()}》。` +
            (result === 'regenerating' ? '这节课正在按新题目重新生成，生成好以后回到待审。' : '')
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
  const footer =
    days.length === 0 ? (
      <Button onClick={onClose}>关闭</Button>
    ) : confirming ? (
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
        {slot?.topic != null && (
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
      {days.length === 0 ? (
        <p>列表里没有今天以后的上学日。今天的课已经定了，只能给明天以后的上学日指定题目。</p>
      ) : (
        <div className="topic-form">
          <p className="dialog-hint">只给选中的学部定题目，其余学部照常上那天的科目。今天的课已经定了，所以从明天以后的上学日里选。</p>
          <fieldset className="field-set">
            <legend className="field-label">
              日期
            </legend>
            <Radio.Group
              value={date}
              onChange={(event) => choose(event.target.value as string, division)}
              options={days.map((day) => ({ value: day.date, label: shortDayName(day.date) }))}
            />
          </fieldset>
          <fieldset className="field-set">
            <legend className="field-label">
              学部
            </legend>
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
            {slot?.topic != null ? `现在的题目：《${slot.topic}》。` : '这一天这个学部还没有指定题目。'}
            {slot !== undefined && slot.status !== 'missing' && slot.status !== 'approved' &&
              (manual
                ? '这节课已经生成了，换了题目会撤掉，要按新题目重新复制提示词、粘贴结果。'
                : '这节课已经生成了，换了题目会按新题目重新生成。')}
          </p>
          {confirming && (
            <Said className="topic-confirm">
              {shortDayName(date ?? '')} {label}的课已经通过了。这节课会按新题目重写，需要重新审。
              {manual && '现在是手动粘贴：它会撤掉，要重新复制提示词、粘贴结果。'}
            </Said>
          )}
          {refusal !== undefined && (
            <Said key={refusal.n} className="action-error">
              {refusal.reason}
            </Said>
          )}
        </div>
      )}
    </Modal>
  )
}
