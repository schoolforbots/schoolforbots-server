import { useEffect, useId, useRef, useState } from 'react'
import {
  aheadOfGeneration,
  lessonPath,
  nextToReview,
  pastable,
  queueSlots,
  slotKey,
  useLoad,
  type Division,
  type LessonDetail,
  type LessonQueue as Queue,
  type Loaded,
  type QueueSlot,
} from '../api.js'
import { LessonEditor } from '../components/LessonEditor.js'
import { LessonQueue } from '../components/LessonQueue.js'
import { Empty, Failed, Loading } from '../components/States.js'
import { FAILURE, slotTone } from '../components/lesson/look.js'
import { dayName, sentence, slotStatus } from '../labels.js'
import { Badge, Card, Tip } from '../ui.js'

// The review page (审课): the list of the days ahead on the left, the chosen lesson on the right. It opens on the first
// lesson awaiting review; approving one moves on to the next. The list is the layout's own (`queue`), so the count
// on the tab and the list say the same thing, and every change reads it again.

/**
 * The queue as `lesson` now stands in it, until the queue read again says so too: the list, the tab's count and the
 * next lesson to review follow a change at once.
 */
function withLesson(queue: Queue, lesson: LessonDetail): Queue {
  const status = lesson.approvedAt !== null ? 'approved' : lesson.flags.length > 0 ? 'flagged' : 'pending'
  return {
    ...queue,
    days: queue.days.map((day) =>
      day.date !== lesson.date
        ? day
        : {
            ...day,
            divisions: day.divisions.map((slot) =>
              slot.division !== lesson.division
                ? slot
                : { ...slot, status, flags: lesson.flags.length, lessonId: lesson.id, version: lesson.version },
            ),
          },
    ),
  }
}

/** The lesson of a slot, read, then kept as each change leaves it. */
function LessonPane({
  lessonId,
  slot,
  mode,
  today,
  callOns,
  onChanged,
  onNext,
  focused,
}: {
  lessonId: number
  slot: QueueSlot
  mode: Queue['mode']
  today: Queue['today']
  callOns: Queue['callOns']
  /** The lesson changed (as `lesson` says, when a change answered with it). */
  onChanged: (lesson?: LessonDetail) => void
  onNext: () => void
  /** Arrived at by approving the lesson before. */
  focused: boolean
}) {
  const lesson = useLoad<LessonDetail>(lessonPath(lessonId))
  if (lesson.data === undefined) {
    return lesson.error !== undefined ? (
      <Card>
        <Failed what="这节课" reason={lesson.error.message} retry={lesson.reload} />
      </Card>
    ) : (
      <Card>
        <Loading what="这节课" />
      </Card>
    )
  }
  return (
    <>
      {lesson.error !== undefined && (
        <Card className="mb-4">
          <Failed what="这节课的最新内容（下面是上次读到的）" reason={lesson.error.message} retry={lesson.reload} />
        </Card>
      )}
      <LessonEditor
        lesson={lesson.data}
        slot={slot}
        mode={mode}
        today={today}
        callOns={callOns}
        onChanged={(answer) => {
          lesson.set(answer)
          onChanged(answer)
        }}
        onRefresh={() => {
          lesson.reload()
          onChanged()
        }}
        onNext={onNext}
        focused={focused}
      />
    </>
  )
}

/** A slot whose lesson is not made yet: why, and what comes next. */
function MissingLesson({ date, slot, queue }: { date: string; slot: QueueSlot; queue: Queue }) {
  const titleId = useId()
  const failed = slot.generationFailed
  // Why, and what comes next: a fixed sentence for each case, in a tip beside "这节课还没有生成".
  let aside: string | undefined
  if (slot.locked) aside = '这一天已经开课，没有课的学部那天改上了自习。'
  else if (date === queue.today) {
    aside =
      '系统只给明天以后的上学日备课，今天的课不会再自动生成了。要今天上这节课，用左边这一行的“复制提示词”和“粘贴结果”补上，' +
      '赶在开门前审过；不然这个学部今天上自习。'
  } else if (queue.mode === 'manual') {
    aside = '用左边这一行的“复制提示词”把提示词交给大模型，再点“粘贴结果”，把回复整段贴回来。'
  } else if (aheadOfGeneration(queue, date)) {
    aside =
      '离上课还早：系统只给今天之后几天里的上学日自动备课（天数是学校配置里的 lessonGeneration.horizonDays，示例配置是 7 天），' +
      '等这一天进了这个范围才会生成这节课。想自己定内容，现在就可以用左边这一行的“复制提示词”和“粘贴结果”补上；' +
      '也可以先给这一天定个题目，到时按题目生成。'
  } else if (failed !== null) {
    aside = '系统会接着重试；等不及的话，用左边这一行的“复制提示词”和“粘贴结果”手动补上。'
  } else aside = '系统会自动生成这节课，生成好以后出现在这里等你审。'

  return (
    <section className="lift rounded-lg border border-gray-200 bg-white" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 px-6 py-5">
        <h2 id={titleId} className="text-lg font-bold text-gray-900">
          {dayName(date)} {slot.label}
        </h2>
        <Badge tone={slotTone(slot)}>{slotStatus(slot)}</Badge>
      </div>
      {/* HyperUI's empty state: what is not there, why, and what comes next. */}
      <div className="space-y-3 px-6 py-10 text-sm text-gray-700">
        <div className="flex items-center gap-2">
          <p className="text-base font-medium text-gray-900">这节课还没有生成。</p>
          {aside !== undefined && <Tip about="这节课">{aside}</Tip>}
        </div>
        {slot.topic !== null && <p>这一天的题目：《{slot.topic}》，生成时会用上。</p>}
        {failed !== null && (
          <p className={FAILURE}>
            生成失败，试了 {failed.attempts} 次。最后一次的原因：{sentence(failed.lastError)}
          </p>
        )}
      </div>
    </section>
  )
}

/** Nothing is waiting to be read: says so, and how many lessons are still to be made. */
function AllReviewed({ queue, focused }: { queue: Queue; focused: boolean }) {
  const missing = queueSlots(queue).filter(({ slot }) => slot.status === 'missing' && !slot.locked)
  // The ones on days ahead of the model's, which may be pasted in but need not be (in api mode); the ones to paste in
  // by hand; and the ones the model is still to make.
  const early = queue.mode === 'api' ? missing.filter(({ date }) => aheadOfGeneration(queue, date)).length : 0
  const toPaste = missing.filter(({ date, slot }) => pastable(queue, date, slot)).length - early
  const toWait = missing.length - toPaste - early
  const done = useRef<HTMLParagraphElement>(null)
  // Arrived at by approving the last lesson: the news takes the focus the approve button had.
  useEffect(() => void (focused && done.current?.focus()), [])
  return (
    // HyperUI's empty state, centred in the card.
    <div className="flex flex-col items-center gap-3 lift rounded-lg border border-gray-200 bg-white px-6 py-16 text-center">
      <span aria-hidden="true" className="grid size-12 place-content-center rounded-full bg-green-100 text-green-700">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className="size-6">
          <path d="m4.5 10.5 3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <p ref={done} tabIndex={-1} className="text-lg font-semibold text-gray-900">
        这几天要审的课都审完了。
      </p>
      {toPaste > 0 && (
        <p className="text-sm text-gray-600">{`还有 ${toPaste} 节课要手动补上：用左边那一行的“复制提示词”和“粘贴结果”。`}</p>
      )}
      {early > 0 && (
        <p className="text-sm text-gray-600">{`还有 ${early} 节课离上课还早，系统到时会自动生成；想自己定内容，可以先用左边那一行的“复制提示词”和“粘贴结果”补上。`}</p>
      )}
      {toWait > 0 && (
        <p className="text-sm text-gray-600">{`还有 ${toWait} 节课没生成，系统生成好以后，会出现在左边等你审。`}</p>
      )}
    </div>
  )
}

export function Review({ queue }: { queue: Loaded<Queue> }) {
  // undefined: not chosen yet (the page picks the first lesson to review); null: nothing chosen.
  const [selected, setSelected] = useState<string | null>()
  // Bumped to read the open lesson again after something outside it changed it (a topic).
  const [reread, setReread] = useState(0)
  // Where approving (or pasting) moved the page to: that lesson's title, or the all-reviewed sentence (null), takes
  // the focus when it shows. Anything chosen otherwise leaves the focus where it is.
  const [arrived, setArrived] = useState<string | null>()
  const data = queue.data

  /** After a change: the queue follows the lesson at once, then is read again. */
  function changed(lesson?: LessonDetail) {
    if (lesson !== undefined && data !== undefined) queue.set(withLesson(data, lesson))
    queue.reload()
  }

  // Nothing chosen (not yet, or all was reviewed) or the chosen slot left the list (its day went by): open the first
  // lesson to review, if there is one now. A lesson given a new topic, for one, is back to review.
  if (data !== undefined && !queueSlots(data).some((entry) => entry.key === selected)) {
    const first = nextToReview(data, null)
    if (first !== selected) setSelected(first)
  }

  if (data === undefined) {
    return (
      <Card>
        {queue.error !== undefined ? (
          <Failed what="这几天的课" reason={queue.error.message} retry={queue.reload} />
        ) : (
          <Loading what="这几天的课" />
        )}
      </Card>
    )
  }
  if (data.days.length === 0) {
    return (
      <Card>
        <Empty why="接下来几天都不上课（周末、放假，或者还没开学），没有要审的课。有上学日以后，这里会列出每天三个学部的课。" />
      </Card>
    )
  }

  const chosen = queueSlots(data).find((entry) => entry.key === selected)
  const lessonId = chosen?.slot.lessonId ?? null

  let main
  if (chosen === undefined) main = <AllReviewed queue={data} focused={arrived === null} />
  else if (lessonId === null) main = <MissingLesson date={chosen.date} slot={chosen.slot} queue={data} />
  else {
    main = (
      <LessonPane
        key={`${lessonId}/${reread}`}
        lessonId={lessonId}
        slot={chosen.slot}
        mode={data.mode}
        today={data.today}
        callOns={data.callOns}
        onChanged={changed}
        onNext={() => {
          const next = nextToReview(data, chosen.key)
          setSelected(next)
          setArrived(next)
        }}
        focused={arrived === chosen.key}
      />
    )
  }

  return (
    <div className="grid grid-cols-[300px_minmax(0,1fr)] items-start gap-6">
      <LessonQueue
        queue={data}
        selected={selected}
        onSelect={(key) => {
          setSelected(key)
          setArrived(undefined)
        }}
        onPasted={(key, lesson) => {
          changed(lesson)
          setSelected(key)
          // The row's buttons go with the missing lesson: the lesson's title takes the focus.
          setArrived(key)
        }}
        onPastedTooLate={(key) => {
          // The slot got a lesson meanwhile (made by the model, or pasted in elsewhere): the list read again shows it,
          // and its title takes the focus, as a lesson pasted in here would.
          queue.reload()
          setSelected(key)
          setArrived(key)
        }}
        onTopicGiven={(date: string, division: Division) => {
          // The focus is back on the topic button; the lesson read again does not take it.
          setArrived(undefined)
          queue.reload()
          if (chosen?.key === slotKey(date, division)) setReread((n) => n + 1)
        }}
        reloadFailure={queue.error}
        onRetry={queue.reload}
      />
      <div className="min-w-0">{main}</div>
    </div>
  )
}
