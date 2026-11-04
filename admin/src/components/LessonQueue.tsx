import { Button } from 'antd'
import { useId, useRef, useState, type KeyboardEvent } from 'react'
import {
  pastable,
  queueSlots,
  slotKey,
  type ApiError,
  type Division,
  type LessonDetail,
  type LessonQueue as Queue,
  type QueueSlot,
} from '../api.js'
import { dayName, slotStatus } from '../labels.js'
import { CopyPrompt } from './CopyPrompt.js'
import { PasteDialog } from './PasteDialog.js'
import { TopicDialog } from './TopicDialog.js'

// The left side of the review page: the lesson days from today on, oldest first, three divisions each, every one
// saying where its lesson stands. A slot is chosen with a click, or with ↑ and ↓ once the list has focus: the list is
// one stop for Tab, the chosen slot. A lesson still to make can be pasted in from its row (see `pastable`): in manual
// mode, after the model failed to make it, or today's. At the bottom: giving a day a topic. Both dialogs are opened from here, and the focus
// goes back to the button that opened one when it closes (a dialog taken away gives none back itself).

const MOVES: Record<string, (at: number, last: number) => number> = {
  ArrowDown: (at, last) => Math.min(at + 1, last),
  ArrowUp: (at) => Math.max(at - 1, 0),
  Home: () => 0,
  End: (_, last) => last,
}

function DayList({
  date,
  slots,
  queue,
  selected,
  stop,
  onSelect,
  onPaste,
}: {
  date: string
  slots: QueueSlot[]
  queue: Queue
  selected: string | null | undefined
  /** The slot that is the list's Tab stop: the chosen one, or the first. */
  stop: string | undefined
  onSelect: (key: string) => void
  onPaste: (date: string, slot: QueueSlot, opener: HTMLElement) => void
}) {
  const dayId = useId()
  return (
    <li className="queue-day">
      <h3 id={dayId} className="queue-date">
        {dayName(date)}
      </h3>
      <ul className="queue-slots" aria-labelledby={dayId}>
        {slots.map((slot) => {
          const key = slotKey(date, slot.division)
          // Something is still to be done here: it reads darker than the slots that are settled.
          const todo = !slot.locked && slot.status !== 'approved'
          return (
            <li key={key} className={todo ? 'queue-slot slot-todo' : 'queue-slot'}>
              <button
                type="button"
                className="slot-button"
                data-slot={key}
                aria-current={key === selected ? 'true' : undefined}
                tabIndex={key === stop ? 0 : -1}
                onClick={() => onSelect(key)}
              >
                <span className="slot-name">{slot.label}</span> <span className="slot-status">{slotStatus(slot)}</span>
              </button>
              {slot.topic !== null && <p className="slot-topic">题目：《{slot.topic}》</p>}
              {pastable(queue, date, slot) && (
                <div className="slot-actions">
                  <CopyPrompt target={{ kind: 'generate', date, division: slot.division }} />
                  <Button size="small" onClick={(event) => onPaste(date, slot, event.currentTarget)}>
                    粘贴结果
                  </Button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </li>
  )
}

export function LessonQueue({
  queue,
  selected,
  onSelect,
  onPasted,
  onTopicGiven,
  reloadFailure,
  onRetry,
}: {
  queue: Queue
  selected: string | null | undefined
  onSelect: (key: string) => void
  /** A lesson pasted in from a row: the slot it fills, and the lesson. */
  onPasted: (key: string, lesson: LessonDetail) => void
  /** A topic was given to a day's division, or taken away. */
  onTopicGiven: (date: string, division: Division) => void
  /** Reading the list again failed: the list shown is the last one read. */
  reloadFailure?: ApiError
  onRetry: () => void
}) {
  const titleId = useId()
  const list = useRef<HTMLOListElement>(null)
  const topicButton = useRef<HTMLButtonElement>(null)
  const [pasting, setPasting] = useState<{ date: string; slot: QueueSlot; opener: HTMLElement }>()
  const [topicOpen, setTopicOpen] = useState(false)
  // What giving a topic did, said under the button once it is done.
  const [notice, setNotice] = useState<string>()
  const entries = queueSlots(queue)
  const keys = entries.map((entry) => entry.key)
  const chosen = entries.find((entry) => entry.key === selected)
  const stop = keys.find((key) => key === selected) ?? keys[0]

  function move(event: KeyboardEvent<HTMLOListElement>) {
    const from = (event.target as HTMLElement).dataset.slot
    const step = MOVES[event.key]
    if (from === undefined || step === undefined) return
    const to = keys[step(keys.indexOf(from), keys.length - 1)]
    if (to === undefined) return
    event.preventDefault()
    onSelect(to)
    list.current?.querySelector<HTMLElement>(`[data-slot="${to}"]`)?.focus()
  }

  return (
    <section className="panel queue" aria-labelledby={titleId}>
      <h2 id={titleId} className="panel-title">
        这几天的课
      </h2>
      {reloadFailure !== undefined && (
        <div className="queue-stale" role="alert">
          <p>没能刷新这个列表，下面是上次读到的。{reloadFailure.message}</p>
          <Button size="small" onClick={onRetry}>
            重新读取
          </Button>
        </div>
      )}
      <ol ref={list} className="queue-days" onKeyDown={move}>
        {queue.days.map((day) => (
          <DayList
            key={day.date}
            date={day.date}
            slots={day.divisions}
            queue={queue}
            selected={selected}
            stop={stop}
            onSelect={onSelect}
            onPaste={(date, slot, opener) => setPasting({ date, slot, opener })}
          />
        ))}
      </ol>
      <div className="queue-foot">
        <Button ref={topicButton} onClick={() => setTopicOpen(true)}>
          给某一天指定题目
        </Button>
        {notice !== undefined && (
          <p className="queue-notice" role="status">
            {notice}
          </p>
        )}
      </div>
      {pasting !== undefined && (
        <PasteDialog
          title={`粘贴结果：${dayName(pasting.date)}${pasting.slot.label}`}
          target={{ kind: 'generate', date: pasting.date, division: pasting.slot.division }}
          onClose={() => {
            pasting.opener.focus()
            setPasting(undefined)
          }}
          onPasted={(lesson) => {
            setPasting(undefined)
            onPasted(slotKey(pasting.date, pasting.slot.division), lesson)
          }}
        />
      )}
      {topicOpen && (
        <TopicDialog
          queue={queue}
          initial={chosen === undefined ? undefined : { date: chosen.date, division: chosen.slot.division }}
          onClose={() => {
            topicButton.current?.focus()
            setTopicOpen(false)
          }}
          onDone={(text, date, division) => {
            topicButton.current?.focus()
            setTopicOpen(false)
            setNotice(text)
            onTopicGiven(date, division)
          }}
        />
      )}
    </section>
  )
}
