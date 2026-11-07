import { Fragment, useEffect, useRef, useState } from 'react'
import type { CallOnKind, LessonDetail, LessonQueue, QueueSlot } from '../api.js'
import { Approval } from './lesson/Approval.js'
import { EditingContext, type Box, type Editing } from './lesson/Editing.js'
import { CallOn, Head, Segment } from './lesson/Parts.js'

// The right side of the review page: one lesson, read like a corrected exercise book. The title, then each segment's
// text and gist, with the two call-on questions after the segments the school's settings put them after; beside
// every part a margin with the red pen's notes. Every part can be edited by hand (改字); a segment, a call-on
// question or the whole lesson can be rewritten for a reason, by the model (api mode) or by copying the prompt and
// pasting the reply (manual mode, or when the model is out of reach). At the bottom: approve and go on.
//
// Every change is sent with the version the page shows; the server answers with the lesson as it is afterwards. One
// change is under way at a time: while one is (a rewrite can take minutes), nothing else that changes the lesson can
// be started and no other box opened, so no change is made from a version about to be replaced and no box waiting for
// an answer is swept away. One box (an edit or a rewrite) is open at a time. A refusal is said where the change was
// asked for.
//
// The parts are in `lesson/`: what they share (`Editing`), the boxes changes are made in (`Boxes`), the parts in reading
// order (`Parts`), and approving with the notices about it (`Approval`).

// Where the focus goes on to after a 这是误伤 is found by `data-focus` marks made for it (on 这是误伤 in the red pen's
// margin, and on approving and why it is held), never by style classes, which a restyle may rename.
const FALSE_POSITIVES = '[data-focus="false-positive"]'
const APPROVE = '[data-focus="approve"]:not(:disabled)'
const APPROVAL_HELD = '[data-focus="approval-held"]'

export function LessonEditor({
  lesson,
  slot,
  mode,
  today,
  callOns,
  onChanged,
  onRefresh,
  onNext,
  focused = false,
}: {
  lesson: LessonDetail
  /** The queue's slot of the lesson: the division's name, the topic of the day and a failed remake. */
  slot: QueueSlot
  mode: LessonQueue['mode']
  /** The school's today, as the queue says it. */
  today: LessonQueue['today']
  callOns: LessonQueue['callOns']
  /** The lesson as a change left it. */
  onChanged: (lesson: LessonDetail) => void
  /** Read the lesson again. */
  onRefresh: () => void
  /** Go on to the next lesson to review. */
  onNext: () => void
  /** The lesson was arrived at from the one before (approved) or just pasted in: its title takes the focus. */
  focused?: boolean
}) {
  const [box, setBox] = useState<Box>(null)
  const [writing, setWriting] = useState(false)
  const [closed, setClosed] = useState<{ box: Box; n: number }>({ box: null, n: 0 })
  const article = useRef<HTMLElement>(null)
  const [marked, setMarked] = useState<{ at: number; n: number }>()
  const falsePositives = () => [...(article.current?.querySelectorAll<HTMLElement>(FALSE_POSITIVES) ?? [])]
  // After a 这是误伤, the focus goes to the next one in reading order (its own and any other of the same rule are gone),
  // or, when none are left, to approving; or, when approving is held for another reason, to that reason.
  useEffect(() => {
    if (marked === undefined) return
    const rest = falsePositives()
    const next =
      rest[Math.min(marked.at, rest.length - 1)] ??
      article.current?.querySelector<HTMLButtonElement>(APPROVE) ??
      article.current?.querySelector<HTMLElement>(APPROVAL_HELD)
    next?.focus()
  }, [marked])
  const markedWrong = (at: number) => setMarked((last) => ({ at, n: (last?.n ?? 0) + 1 }))
  const refocus = (opener: Box) => setClosed(({ n }) => ({ box: opener, n: n + 1 }))
  const open = (next: Box) => {
    refocus(next === null ? box : null)
    setBox(next)
  }
  const editable = !lesson.locked
  const segments = lesson.content.segments
  const questions = lesson.content.callOnQuestions
  // Each question comes after the segment the settings name; one named past the end comes last.
  const afterSegment = (kind: CallOnKind) =>
    Math.min(callOns.find((callOn) => callOn.kind === kind)?.afterSegment ?? segments.length, segments.length)
  const callOnsAfter = (count: number): CallOnKind[] =>
    questions === null ? [] : (['review', 'extension'] as const).filter((kind) => afterSegment(kind) === count)

  const editing: Editing = {
    lesson,
    mode,
    editable,
    writing,
    setWriting,
    falsePositiveIndex: (button) => falsePositives().indexOf(button),
    markedWrong,
    box,
    closed,
    open,
    refocus,
    onChanged,
    onRefresh,
    isToday: lesson.date === today,
  }

  return (
    <EditingContext value={editing}>
      <article ref={article} className="panel lesson">
        <Head slot={slot} focused={focused} />
        {segments.map((segment, index) => (
          <Fragment key={index}>
            <Segment index={index} text={segment.text} gist={segment.gist} />
            {questions !== null &&
              callOnsAfter(index + 1).map((kind) => (
                <CallOn key={kind} kind={kind} after={afterSegment(kind)} question={questions[kind]} />
              ))}
          </Fragment>
        ))}
        {editable && <Approval slot={slot} onNext={onNext} />}
      </article>
    </EditingContext>
  )
}
