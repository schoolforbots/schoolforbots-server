import { Button } from 'antd'
import { useId, useRef } from 'react'
import { approve, type LessonDetail, type QueueSlot } from '../../api.js'
import { useFocusOnMount } from '../../focus.js'
import { sentence } from '../../labels.js'
import { Refusal, useAction, useEditing } from './Editing.js'

// Whether the lesson can still change and be approved: the notices at its top (a day begun, a new topic, a failed
// remake), and approving at its bottom, with why it is held when it is.

/**
 * The day's division has a topic the lesson was not made about: the server took the lesson back to review and is making
 * it again for the topic, so the content shown is the one being replaced.
 */
const beingRemade = (slot: QueueSlot, lesson: LessonDetail) => slot.topic !== null && slot.topic !== lesson.topic

/** The bottom of the lesson: approve it and go on to the next lesson to review. */
export function Approval({ slot, onNext }: { slot: QueueSlot; onNext: () => void }) {
  const { lesson, writing, isToday } = useEditing()
  const action = useAction()
  const button = useRef<HTMLButtonElement>(null)
  const reasonId = useId()
  const marks = lesson.flags.length

  if (lesson.approvedAt !== null) {
    return (
      <footer className="lesson-foot">
        <Button onClick={onNext}>审下一节</Button>
        <p className="foot-note">这节课已经通过。再改的话，要重新通过。</p>
      </footer>
    )
  }
  // Why it cannot be approved yet, if it cannot.
  const reasons: string[] = []
  if (marks > 0) reasons.push(`还有 ${marks} 处红笔标记：改掉，或者点“这是误伤”，才能通过。`)
  if (beingRemade(slot, lesson)) {
    reasons.push(
      isToday
        ? '今天的课不会再按新题目生成了，旧的内容也不能通过，这个学部今天上自习。'
        : '这节课正在按新题目重新生成，等新稿出来再审。',
    )
  }
  return (
    <footer className="lesson-foot">
      <Button
        ref={button}
        type="primary"
        // The last 这是误伤 hands the focus on to here (see `LessonEditor`).
        data-focus="approve"
        disabled={reasons.length > 0 || writing}
        aria-describedby={reasons.length > 0 ? reasonId : undefined}
        onClick={async () => {
          if (await action.run(() => approve(lesson))) onNext()
        }}
      >
        通过，审下一节
      </Button>
      {reasons.length > 0 && (
        // Takes the focus when the last 这是误伤 leaves 通过 still held for another reason.
        <p id={reasonId} className="foot-note" tabIndex={-1} data-focus="approval-held">
          {reasons.join('')}
        </p>
      )}
      <Refusal action={action} back={button} />
    </footer>
  )
}

/** A notice that takes the focus: the lesson became read-only under the reader's hands (a class began it). */
function Arrived({ text }: { text: string }) {
  const self = useFocusOnMount<HTMLParagraphElement>()
  return (
    <p ref={self} tabIndex={-1} role="alert">
      {text}
    </p>
  )
}

/** What the page knows about the lesson besides its content: a day begun, a new topic, a failed remake. */
export function Notices({ slot }: { slot: QueueSlot }) {
  const { lesson, editable, isToday } = useEditing()
  // Locked when it was opened, it says so quietly; locked while open (a refused change), it takes the focus that the
  // controls it removed had.
  const lockedFromStart = useRef(!editable)
  const notices: string[] = []
  let locked: string | undefined
  if (!editable) {
    locked =
      lesson.approvedAt !== null
        ? '这节课已经开课，不能再改。'
        : '这一天已经开课，这节课没赶在开门前通过，那天改上了自习。它不能再改了。'
  } else {
    if (slot.topic !== null && beingRemade(slot, lesson)) {
      notices.push(
        isToday
          ? `这一天指定了新题目《${slot.topic}》，可今天的课不会再按新题目生成了；这里是旧的内容。`
          : `这一天指定了新题目《${slot.topic}》，这节课正在按新题目重新生成；生成好以前，这里还是旧的内容。`,
      )
    }
    if (slot.generationFailed !== null) {
      const { attempts, lastError } = slot.generationFailed
      notices.push(
        `按新题目重新生成失败，试了 ${attempts} 次。最后一次的原因：${sentence(lastError)}` +
          (isToday ? '今天的课不会再重新生成了。' : '系统会接着重试。'),
      )
    }
  }
  if (locked === undefined && notices.length === 0) return null
  return (
    <div className="lesson-notices">
      {locked !== undefined && (lockedFromStart.current ? <p>{locked}</p> : <Arrived text={locked} />)}
      {notices.map((notice) => (
        <p key={notice}>{notice}</p>
      ))}
    </div>
  )
}
