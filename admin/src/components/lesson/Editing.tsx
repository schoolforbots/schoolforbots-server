import { Button } from 'antd'
import { createContext, useContext, useEffect, useRef, useState, type RefObject } from 'react'
import type { ApiError, LessonDetail, LessonPart, LessonQueue, RewriteTarget } from '../../api.js'
import { useFocusOnMount } from '../../focus.js'

// What every part of the lesson editor shares (see `LessonEditor`): the lesson, the one box open, whether a change is
// under way, and where the focus goes back to. Then one change asked of the server from one place on the page, and
// why it was refused, said in that place.

export type Box = { what: 'edit'; part: LessonPart } | { what: 'rewrite'; target: RewriteTarget } | null

export interface Editing {
  lesson: LessonDetail
  mode: LessonQueue['mode']
  /** False once a class of the division has begun the day. */
  editable: boolean
  box: Box
  /** A change to the lesson is under way: every other one waits for it. */
  writing: boolean
  setWriting: (writing: boolean) => void
  /** Where `button` is among the lesson's 这是误伤, in reading order. */
  falsePositiveIndex: (button: HTMLElement) => number
  /** A red mark was called a false positive by the `at`-th 这是误伤 of the lesson: the focus moves on from there. */
  markedWrong: (at: number) => void
  /** The box that closed last, so the button that opened it takes the focus back; `n` counts the closings. */
  closed: { box: Box; n: number }
  open: (box: Box) => void
  /** Gives the focus to the button that opens `box`, as if it had just closed. */
  refocus: (box: Box) => void
  onChanged: (lesson: LessonDetail) => void
  onRefresh: () => void
  /** The lesson is today's: the model does not make it again any more, for a new topic or anything else. */
  isToday: boolean
}

export const EditingContext = createContext<Editing | null>(null)

export function useEditing(): Editing {
  const editing = useContext(EditingContext)
  if (editing === null) throw new Error('A part of the lesson editor was rendered outside it')
  return editing
}

const samePart = (a: LessonPart, b: LessonPart) =>
  a.part === b.part && ('index' in a ? a.index : null) === ('index' in b ? b.index : null)

const sameTarget = (a: RewriteTarget, b: RewriteTarget) =>
  a.kind === b.kind &&
  ('segmentIndex' in a ? a.segmentIndex : null) === ('segmentIndex' in b ? b.segmentIndex : null) &&
  ('callOn' in a ? a.callOn : null) === ('callOn' in b ? b.callOn : null)

export const isEditOf = (box: Box, part: LessonPart) => box?.what === 'edit' && samePart(box.part, part)
export const isRewriteOf = (box: Box, target: RewriteTarget) =>
  box?.what === 'rewrite' && sameTarget(box.target, target)

/** The button that opened a box: it takes the focus back when the box closes, so the keyboard goes on from there. */
export function useOpener(closedHere: (box: Box) => boolean) {
  const { closed } = useEditing()
  const button = useRef<HTMLButtonElement>(null)
  const here = closedHere(closed.box)
  useEffect(() => {
    if (here) button.current?.focus()
  }, [here, closed.n])
  return button
}

/**
 * One change asked of the server from one place on the page: whether it is under way, and why it was refused. While
 * it is under way, the lesson is being written (`writing`), and the page starts no other change.
 */
export function useAction() {
  const { onChanged, onRefresh, setWriting } = useEditing()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError>()

  /** Sends the change; true when the server took it. */
  async function run(change: () => Promise<LessonDetail>): Promise<boolean> {
    setBusy(true)
    setWriting(true)
    setError(undefined)
    try {
      const lesson = await change()
      setBusy(false)
      setWriting(false)
      onChanged(lesson)
      return true
    } catch (failure) {
      setError(failure as ApiError)
      setBusy(false)
      setWriting(false)
      // A class began the lesson meanwhile: read it again, and the page stops offering changes. Approving found red
      // marks the word list has gained since: read it again, and they are there to fix.
      const code = (failure as ApiError).code
      if (code === 'lesson_locked' || code === 'lesson_has_flags') onRefresh()
      return false
    }
  }

  return { busy, error, run, clear: () => setError(undefined) }
}

type Action = ReturnType<typeof useAction>

type Focusable = { focus: () => void }

/**
 * Why a change was refused, as the server says it; for a lesson changed elsewhere, the way to read it again, after
 * which the focus goes `back` to where the change was being made. The refusal takes the focus when it appears: the
 * button that sent the change was disabled meanwhile and lost it.
 */
export function Refusal({ action, back }: { action: Action; back?: RefObject<Focusable | null> }) {
  if (action.error === undefined) return null
  return <Refused error={action.error} clear={action.clear} back={back} />
}

function Refused({ error, clear, back }: { error: ApiError; clear: () => void; back?: RefObject<Focusable | null> }) {
  const { onRefresh } = useEditing()
  const self = useFocusOnMount<HTMLDivElement>()
  return (
    <div ref={self} tabIndex={-1} className="action-error" role="alert">
      <p>{error.message}</p>
      {error.code === 'stale_version' && (
        <Button
          size="small"
          onClick={() => {
            clear()
            onRefresh()
            back?.current?.focus()
          }}
        >
          刷新
        </Button>
      )}
    </div>
  )
}
