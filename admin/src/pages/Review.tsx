import { useEffect, useId, useRef, useState } from 'react'
import {
  lessonPath,
  nextToReview,
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
import { TopicDialog } from '../components/TopicDialog.js'
import { dayName, sentence } from '../labels.js'

// The review page (审课): the list of the days ahead on the left, the chosen lesson on the right. It opens on the first
// lesson awaiting review; approving one moves on to the next. The list is the layout's own (`queue`), so the count
// on the tab and the list say the same thing, and every change reads it again.

/** The lesson of a slot, read, then kept as each change leaves it. */
function LessonPane({
  lessonId,
  slot,
  mode,
  callOns,
  onChanged,
  onNext,
  focused,
}: {
  lessonId: number
  slot: QueueSlot
  mode: Queue['mode']
  callOns: Queue['callOns']
  onChanged: () => void
  onNext: () => void
  /** Arrived at by approving the lesson before. */
  focused: boolean
}) {
  const lesson = useLoad<LessonDetail>(lessonPath(lessonId))
  if (lesson.data === undefined) {
    return lesson.error !== undefined ? (
      <div className="panel">
        <Failed what="这节课" reason={lesson.error.message} retry={lesson.reload} />
      </div>
    ) : (
      <div className="panel">
        <Loading what="这节课" />
      </div>
    )
  }
  return (
    <>
      {lesson.error !== undefined && (
        <div className="panel">
          <Failed what="这节课的最新内容（下面是上次读到的）" reason={lesson.error.message} retry={lesson.reload} />
        </div>
      )}
      <LessonEditor
        lesson={lesson.data}
        slot={slot}
        mode={mode}
        callOns={callOns}
        onChanged={(answer) => {
          lesson.set(answer)
          onChanged()
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
function MissingLesson({ date, slot, mode }: { date: string; slot: QueueSlot; mode: Queue['mode'] }) {
  const titleId = useId()
  const failed = slot.generationFailed
  let next: string
  if (slot.locked) next = '这一天已经开课，没有课的学部那天改上了自习。'
  else if (mode === 'manual') {
    next = '用左边这一行的“复制提示词”把提示词交给大模型，再点“粘贴结果”，把回复整段贴回来。'
  } else if (failed !== null) {
    next = '系统会接着重试；等不及的话，用左边这一行的“复制提示词”和“粘贴结果”手动补上。'
  } else next = '系统会自动生成这节课，生成好以后出现在这里等你审。'

  return (
    <section className="panel lesson-missing" aria-labelledby={titleId}>
      <h2 id={titleId} className="panel-title">
        {dayName(date)} {slot.label}
      </h2>
      <p>这节课还没有生成。</p>
      {slot.topic !== null && <p>这一天的题目：《{slot.topic}》，生成时会用上。</p>}
      {failed !== null && (
        <p>
          生成失败，试了 {failed.attempts} 次。最后一次的原因：{sentence(failed.lastError)}
        </p>
      )}
      <p>{next}</p>
    </section>
  )
}

/** Nothing is waiting to be read: says so, and how many lessons are still to be made. */
function AllReviewed({ queue, focused }: { queue: Queue; focused: boolean }) {
  const toMake = queueSlots(queue).filter(({ slot }) => slot.status === 'missing' && !slot.locked).length
  const done = useRef<HTMLParagraphElement>(null)
  // Arrived at by approving the last lesson: the news takes the focus the approve button had.
  useEffect(() => void (focused && done.current?.focus()), [])
  return (
    <div className="panel">
      <div className="state">
        <p ref={done} tabIndex={-1} className="state-text">
          这几天要审的课都审完了。
        </p>
        {toMake > 0 && (
          <p className="state-text">
            {queue.mode === 'manual'
              ? `还有 ${toMake} 节课没生成：用左边那一行的“复制提示词”和“粘贴结果”补上。`
              : `还有 ${toMake} 节课没生成，系统生成好以后，会出现在左边等你审。`}
          </p>
        )}
      </div>
    </div>
  )
}

export function Review({ queue }: { queue: Loaded<Queue> }) {
  // undefined: not chosen yet (the page picks the first lesson to review); null: nothing chosen.
  const [selected, setSelected] = useState<string | null>()
  const [pasted, setPasted] = useState<{ key: string; lessonId: number }>()
  const [topicOpen, setTopicOpen] = useState(false)
  const [notice, setNotice] = useState<string>()
  // Bumped to read the open lesson again after something outside it changed it (a topic).
  const [reread, setReread] = useState(0)
  // Approving moved the page on: what it moved to takes the focus. Choosing from the list leaves it in the list.
  const [arrived, setArrived] = useState(false)
  const data = queue.data

  // Not chosen yet, or the chosen slot left the list (its day went by): start from the first lesson to review.
  if (data !== undefined && selected !== null && !queueSlots(data).some((entry) => entry.key === selected)) {
    setSelected(nextToReview(data, null))
  }

  if (data === undefined) {
    return (
      <div className="panel">
        {queue.error !== undefined ? (
          <Failed what="这几天的课" reason={queue.error.message} retry={queue.reload} />
        ) : (
          <Loading what="这几天的课" />
        )}
      </div>
    )
  }
  if (data.days.length === 0) {
    return (
      <div className="panel">
        <Empty why="接下来几天都不上课（周末、放假，或者还没开学），没有要审的课。有上学日以后，这里会列出每天三个学部的课。" />
      </div>
    )
  }

  const chosen = queueSlots(data).find((entry) => entry.key === selected)
  // A lesson just pasted in is shown before the list read again knows it.
  const lessonId =
    chosen?.slot.lessonId ?? (pasted !== undefined && pasted.key === chosen?.key ? pasted.lessonId : null)

  let main
  if (chosen === undefined) main = <AllReviewed queue={data} focused={arrived} />
  else if (lessonId === null) main = <MissingLesson date={chosen.date} slot={chosen.slot} mode={data.mode} />
  else {
    main = (
      <LessonPane
        key={`${lessonId}/${reread}`}
        lessonId={lessonId}
        slot={chosen.slot}
        mode={data.mode}
        callOns={data.callOns}
        onChanged={queue.reload}
        onNext={() => {
          setSelected(nextToReview(data, chosen.key))
          setArrived(true)
        }}
        focused={arrived}
      />
    )
  }

  return (
    <div className="review">
      <LessonQueue
        queue={data}
        selected={selected}
        onSelect={(key) => {
          setSelected(key)
          setArrived(false)
        }}
        onPasted={(key, lesson) => {
          setPasted({ key, lessonId: lesson.id })
          setSelected(key)
          // The row's buttons go with the missing lesson: the lesson's title takes the focus.
          setArrived(true)
          queue.reload()
        }}
        onTopic={() => setTopicOpen(true)}
        notice={notice}
        reloadFailure={queue.error}
        onRetry={queue.reload}
      />
      <div className="review-main">{main}</div>
      {topicOpen && (
        <TopicDialog
          queue={data}
          initial={chosen === undefined ? undefined : { date: chosen.date, division: chosen.slot.division }}
          onClose={() => setTopicOpen(false)}
          onDone={(text: string, date: string, division: Division) => {
            setTopicOpen(false)
            setNotice(text)
            // In manual mode a new topic takes the lesson away: a lesson pasted before is gone.
            setPasted(undefined)
            queue.reload()
            if (chosen?.key === slotKey(date, division)) setReread((n) => n + 1)
          }}
        />
      )}
    </div>
  )
}
