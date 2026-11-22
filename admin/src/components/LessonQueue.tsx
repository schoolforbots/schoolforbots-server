import { Badge, Button, PageActions } from '../ui.js'
import { useId, useRef, useState, type KeyboardEvent } from 'react'
import {
  aheadOfGeneration,
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
import { REFUSAL, slotTone } from './lesson/look.js'

// The left side of the review page: the lesson days from today on, oldest first, three divisions each, every one
// saying where its lesson stands. A slot is chosen with a click, or with ↑ and ↓ once the list has focus: the list is
// one stop for Tab, the chosen slot. A lesson still to make can be pasted in from its row (see `pastable`): in manual
// mode, after the model failed to make it, today's, or one on a day ahead of the model's. In the page's header: giving
// a day a topic. Both dialogs are opened from here, and the focus goes back to the button that opened one when it
// closes (a dialog taken away gives none back itself).

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
    <li className="pt-4 first:pt-0">
      <h3 id={dayId} className="px-3 pb-1 text-xs font-medium text-gray-500">
        {dayName(date)}
      </h3>
      <ul className="space-y-1" aria-labelledby={dayId}>
        {slots.map((slot) => {
          const key = slotKey(date, slot.division)
          const chosen = key === selected
          return (
            <li key={key}>
              {/* As the template's sidebar: the chosen one on grey, with a dark bar on its left (not colour alone). The
                  badge says where its lesson stands: green settled, red marks or a failure, yellow to review. */}
              <button
                type="button"
                className={
                  'flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-offset-[-2px] ' +
                  (chosen
                    ? 'bg-gray-100 text-gray-900 shadow-[inset_3px_0_0_var(--color-gray-900)]'
                    : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900')
                }
                data-slot={key}
                aria-current={chosen ? 'true' : undefined}
                tabIndex={key === stop ? 0 : -1}
                onClick={() => onSelect(key)}
              >
                <span>{slot.label}</span>{' '}
                <Badge tone={slotTone(slot)}>{slotStatus(slot, aheadOfGeneration(queue, date))}</Badge>
              </button>
              {slot.topic !== null && <p className="px-3 pt-0.5 pb-1 text-xs text-gray-500">题目：《{slot.topic}》</p>}
              {pastable(queue, date, slot) && (
                <div className="flex flex-wrap items-center gap-2 px-3 pt-1 pb-2">
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
  onPastedTooLate,
  onTopicGiven,
  reloadFailure,
  onRetry,
}: {
  queue: Queue
  selected: string | null | undefined
  onSelect: (key: string) => void
  /** A lesson pasted in from a row: the slot it fills, and the lesson. */
  onPasted: (key: string, lesson: LessonDetail) => void
  /** A lesson pasted in from a row was refused, the slot having got one meanwhile, and 刷新 was pressed. */
  onPastedTooLate: (key: string) => void
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
    <section
      className="sticky top-6 flex max-h-[calc(100vh-3rem)] flex-col rounded-lg border border-gray-200 bg-white"
      aria-labelledby={titleId}
    >
      {/* The page's own action, in the header (the template's "New report"). */}
      <PageActions>
        <Button ref={topicButton} type="primary" onClick={() => setTopicOpen(true)}>
          给某一天指定题目
        </Button>
      </PageActions>
      <div className="border-b border-gray-200 px-5 py-4">
        <h2 id={titleId} className="text-sm font-medium text-gray-900">
          这几天的课
        </h2>
      </div>
      {reloadFailure !== undefined && (
        <div className={`${REFUSAL} mx-3 flex-col items-start`} role="alert">
          <p>没能刷新这个列表，下面是上次读到的。{reloadFailure.message}</p>
          <Button size="small" onClick={onRetry}>
            重新读取
          </Button>
        </div>
      )}
      <ol ref={list} className="min-h-0 flex-1 overflow-y-auto p-3" onKeyDown={move}>
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
      {notice !== undefined && (
        <p className="border-t border-gray-200 px-5 py-3 text-sm text-gray-700" role="status">
          {notice}
        </p>
      )}
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
          onStale={() => {
            setPasting(undefined)
            onPastedTooLate(slotKey(pasting.date, pasting.slot.division))
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
