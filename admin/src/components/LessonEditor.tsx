import { Button, Input, type GetRef } from 'antd'
import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  approve,
  editPart,
  markFalsePositive,
  restore,
  rewrite,
  type ApiError,
  type CallOnKind,
  type LessonDetail,
  type LessonPart,
  type LessonQueue,
  type PromptTarget,
  type QueueSlot,
  type RewriteTarget,
} from '../api.js'
import { useFocusOnMount } from '../focus.js'
import { dayName, sentence } from '../labels.js'
import { CopyPrompt } from './CopyPrompt.js'
import { PasteDialog } from './PasteDialog.js'
import { Margin, Marked } from './RedPen.js'

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

type Box = { what: 'edit'; part: LessonPart } | { what: 'rewrite'; target: RewriteTarget } | null
type TextAreaRef = GetRef<typeof Input.TextArea>

interface Editing {
  lesson: LessonDetail
  mode: LessonQueue['mode']
  /** False once a class of the division has begun the day. */
  editable: boolean
  box: Box
  /** A change to the lesson is under way: every other one waits for it. */
  writing: boolean
  setWriting: (writing: boolean) => void
  /** A red mark was called a false positive by the `at`-th 这是误伤 of the lesson: the focus moves on from there. */
  markedWrong: (at: number) => void
  /** The box that closed last, so the button that opened it takes the focus back; `n` counts the closings. */
  closed: { box: Box; n: number }
  open: (box: Box) => void
  /** Gives the focus to the button that opens `box`, as if it had just closed. */
  refocus: (box: Box) => void
  onChanged: (lesson: LessonDetail) => void
  onRefresh: () => void
}

const EditingContext = createContext<Editing | null>(null)

function useEditing(): Editing {
  const editing = useContext(EditingContext)
  if (editing === null) throw new Error('A part of the lesson editor was rendered outside it')
  return editing
}

const CALL_ON_NAMES: Record<CallOnKind, string> = { review: '复习题', extension: '引申题' }

const samePart = (a: LessonPart, b: LessonPart) =>
  a.part === b.part && ('index' in a ? a.index : null) === ('index' in b ? b.index : null)

const sameTarget = (a: RewriteTarget, b: RewriteTarget) =>
  a.kind === b.kind &&
  ('segmentIndex' in a ? a.segmentIndex : null) === ('segmentIndex' in b ? b.segmentIndex : null) &&
  ('callOn' in a ? a.callOn : null) === ('callOn' in b ? b.callOn : null)

const isEditOf = (box: Box, part: LessonPart) => box?.what === 'edit' && samePart(box.part, part)
const isRewriteOf = (box: Box, target: RewriteTarget) => box?.what === 'rewrite' && sameTarget(box.target, target)

/** The button that opened a box: it takes the focus back when the box closes, so the keyboard goes on from there. */
function useOpener(closedHere: (box: Box) => boolean) {
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
function useAction() {
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
function Refusal({ action, back }: { action: Action; back?: RefObject<Focusable | null> }) {
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

/** Esc closes a box, unless what it sent is still under way. */
const closeOnEscape = (busy: boolean, close: () => void) => (event: KeyboardEvent) => {
  if (event.key !== 'Escape' || busy) return
  event.stopPropagation()
  close()
}

function EditBox({ part, text, labelId }: { part: LessonPart; text: string; labelId: string }) {
  const { lesson, writing, open } = useEditing()
  const [draft, setDraft] = useState(text)
  const action = useAction()
  const field = useRef<TextAreaRef>(null)

  async function save() {
    if (await action.run(() => editPart(lesson, part, draft))) open(null)
  }

  return (
    <div className="edit-box" onKeyDown={closeOnEscape(writing, () => open(null))}>
      <Input.TextArea
        ref={field}
        aria-labelledby={labelId}
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        autoSize={{ minRows: 2, maxRows: 12 }}
      />
      <div className="box-actions">
        <Button type="primary" size="small" onClick={save} disabled={writing}>
          保存改动
        </Button>
        <Button size="small" onClick={() => open(null)} disabled={writing}>
          不改了
        </Button>
      </div>
      <Refusal action={action} back={field} />
    </div>
  )
}

/** A rewrite: the reason it is for (required), then the model, or the prompt to copy and the reply to paste. */
function ReasonBox({ target, what }: { target: RewriteTarget; what: string }) {
  const { lesson, mode, writing, open, onChanged } = useEditing()
  const [reason, setReason] = useState('')
  const [unsaid, setUnsaid] = useState(false)
  const [pasting, setPasting] = useState(false)
  const action = useAction()
  const field = useRef<TextAreaRef>(null)
  const pasteButton = useRef<HTMLButtonElement>(null)
  const fieldId = useId()
  const hintId = useId()
  // The model out of reach says to paste by hand instead: the way to do it comes up right here.
  const byHand = mode === 'manual' || action.error?.code === 'llm_unavailable'
  const prompt: PromptTarget = {
    kind: target.kind,
    date: lesson.date,
    division: lesson.division,
    lessonId: lesson.id,
    segmentIndex: 'segmentIndex' in target ? target.segmentIndex : undefined,
    callOn: 'callOn' in target ? target.callOn : undefined,
    reason: reason.trim(),
  }

  /** Whether the reason is written; if not, says so and puts the cursor where it goes. */
  function ready(): boolean {
    const said = reason.trim() !== ''
    setUnsaid(!said)
    if (!said) field.current?.focus()
    return said
  }

  async function send() {
    if (ready() && (await action.run(() => rewrite(lesson, target, reason.trim())))) open(null)
  }

  return (
    <div className="reason-box" onKeyDown={closeOnEscape(writing, () => open(null))}>
      <label className="field-label" htmlFor={fieldId}>
        重写的理由
      </label>
      <p id={hintId} className="field-hint">
        说清楚哪里不合适、想改成什么样，大模型照着重写。理由会存下来，每周复盘时用。
      </p>
      <Input.TextArea
        ref={field}
        id={fieldId}
        aria-describedby={hintId}
        autoFocus
        maxLength={1000}
        showCount
        disabled={action.busy}
        value={reason}
        onChange={(event) => {
          setReason(event.target.value)
          setUnsaid(false)
        }}
        autoSize={{ minRows: 3, maxRows: 8 }}
      />
      {unsaid && (
        <p className="action-error" role="alert">
          先写重写的理由：哪里不合适，想改成什么样。
        </p>
      )}
      <div className="box-actions">
        {mode === 'api' && (
          <Button type="primary" size="small" onClick={send} disabled={writing}>
            {action.busy ? '正在重写' : '请大模型重写'}
          </Button>
        )}
        {byHand && (
          <>
            <CopyPrompt target={prompt} ready={ready} />
            <Button ref={pasteButton} size="small" onClick={() => ready() && setPasting(true)} disabled={writing}>
              粘贴结果
            </Button>
          </>
        )}
        <Button size="small" onClick={() => open(null)} disabled={writing}>
          不重写了
        </Button>
      </div>
      {action.busy && (
        <p className="field-hint" role="status">
          大模型正在重写，可能要一分钟以上，别关这一页。
        </p>
      )}
      <Refusal action={action} back={field} />
      {pasting && (
        <PasteDialog
          title={`粘贴结果：${what}`}
          target={{ ...prompt, baseVersion: lesson.version }}
          onClose={() => {
            // The dialog goes away with this box's state, so it gives no focus back itself.
            pasteButton.current?.focus()
            setPasting(false)
          }}
          onPasted={(answer) => {
            setPasting(false)
            onChanged(answer)
            open(null)
          }}
        />
      )}
    </div>
  )
}

/**
 * After a rewrite: what it was for, and the way back to the version before it. Once back, this goes away, and the
 * focus goes to the button that rewrites the same thing (`target`).
 */
function Restore({ what, target }: { what: string; target: RewriteTarget }) {
  const { lesson, writing, refocus } = useEditing()
  const action = useAction()
  const button = useRef<HTMLButtonElement>(null)
  const [latest, before] = lesson.versions
  if (latest === undefined || before === undefined) return null

  async function goBack(to: number) {
    if (await action.run(() => restore(lesson, to))) refocus({ what: 'rewrite', target })
  }

  return (
    <div className="restore">
      <p>{what}刚重写过。</p>
      {latest.reason !== null && <p className="restore-reason">理由：{latest.reason}</p>}
      <Button ref={button} size="small" onClick={() => void goBack(before.version)} disabled={writing}>
        换回上一版
      </Button>
      <Refusal action={action} back={button} />
    </div>
  )
}

/** The latest saved version is a rewrite of `kind` (of segment `index`, for a segment). */
function rewroteLast(lesson: LessonDetail, kind: RewriteTarget['kind'], index?: number): boolean {
  const latest = lesson.versions[0]
  return latest?.change === kind && (index === undefined || latest.segmentIndex === index)
}

/** One part of the lesson: its label, its text with the red pen's marks (or the box editing it), and its margin. */
function PartView({
  part,
  label,
  text,
  title = false,
  focused = false,
  aside,
}: {
  part: LessonPart
  label: string
  text: string
  /** The lesson's title: its text is the page's heading. */
  title?: boolean
  /** Takes the focus when it first shows (the title of a lesson arrived at by approving the one before). */
  focused?: boolean
  /** More for the margin. */
  aside?: ReactNode
}) {
  const { lesson, editable, writing, box, open, markedWrong } = useEditing()
  const labelId = useId()
  const group = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const opener = useOpener((closedBox) => isEditOf(closedBox, part))
  // Once, when the part first shows: the focus then moves on with the reader.
  useEffect(() => void (focused && heading.current?.focus()), [])
  const falsePositive = useAction()
  const index = 'index' in part ? part.index : null
  const flags = lesson.flags.filter((flag) => flag.part === part.part && flag.index === index)
  const editing = editable && isEditOf(box, part)
  const Text = title ? 'h2' : 'p'

  async function markWrong(rule: string, button: HTMLElement) {
    // Where the button was among the lesson's 这是误伤, before it goes away with its mark.
    const at = [...(button.closest('.lesson')?.querySelectorAll('.false-positive') ?? [])].indexOf(button)
    if (await falsePositive.run(() => markFalsePositive(lesson, rule))) markedWrong(at)
  }

  return (
    // The group takes the focus back after 刷新 read the lesson again: its marks may have changed meanwhile.
    <div ref={group} tabIndex={-1} className="part" role="group" aria-labelledby={labelId}>
      <div className="part-body">
        <p id={labelId} className="part-label">
          {label}
        </p>
        {editing ? (
          <EditBox part={part} text={text} labelId={labelId} />
        ) : (
          <>
            <Text
              ref={title ? heading : undefined}
              tabIndex={title ? -1 : undefined}
              className={title ? 'lesson-title' : 'part-text'}
            >
              <Marked text={text} flags={flags} />
            </Text>
            {editable && (
              <Button
                ref={opener}
                type="link"
                size="small"
                className="part-edit"
                disabled={writing}
                onClick={() => open({ what: 'edit', part })}
              >
                改字
              </Button>
            )}
          </>
        )}
      </div>
      <Margin
        flags={flags}
        disabled={writing}
        onFalsePositive={editable ? (rule, button) => void markWrong(rule, button) : undefined}
      >
        <Refusal action={falsePositive} back={group} />
        {aside}
      </Margin>
    </div>
  )
}

function SectionHead({ id, name, note, children }: { id: string; name: string; note?: string; children?: ReactNode }) {
  return (
    <div className="section-head">
      <h3 id={id} className="section-title">
        {name}
      </h3>
      {note !== undefined && <span className="section-note">{note}</span>}
      {children}
    </div>
  )
}

function Segment({ index, text, gist }: { index: number; text: string; gist: string }) {
  const { lesson, editable, writing, box, open } = useEditing()
  const id = useId()
  const target: RewriteTarget = { kind: 'rewrite_segment', segmentIndex: index }
  const opener = useOpener((closedBox) => isRewriteOf(closedBox, target))
  const name = `第 ${index + 1} 段`
  return (
    <section className="lesson-section" aria-labelledby={id}>
      <SectionHead id={id} name={name}>
        {editable && (
          <Button ref={opener} size="small" disabled={writing} onClick={() => open({ what: 'rewrite', target })}>
            重写这段
          </Button>
        )}
      </SectionHead>
      {editable && isRewriteOf(box, target) && (
        <ReasonBox target={target} what={`重写${name}`} />
      )}
      <PartView
        part={{ part: 'segment', index }}
        label="正文"
        text={text}
        aside={editable && rewroteLast(lesson, 'rewrite_segment', index) && <Restore what="这段" target={target} />}
      />
      <PartView part={{ part: 'gist', index }} label="要点" text={gist} />
    </section>
  )
}

function CallOn({ kind, after, question }: { kind: CallOnKind; after: number; question: string }) {
  const { editable, writing, box, open } = useEditing()
  const id = useId()
  const target: RewriteTarget = { kind: 'rewrite_call_on', callOn: kind }
  const opener = useOpener((closedBox) => isRewriteOf(closedBox, target))
  return (
    <section className="lesson-section call-on" aria-labelledby={id}>
      <SectionHead id={id} name={CALL_ON_NAMES[kind]} note={`第 ${after} 段讲完后点名问`}>
        {editable && (
          <Button ref={opener} size="small" disabled={writing} onClick={() => open({ what: 'rewrite', target })}>
            重写这道题
          </Button>
        )}
      </SectionHead>
      {editable && isRewriteOf(box, target) && (
        <ReasonBox target={target} what={`重写${CALL_ON_NAMES[kind]}`} />
      )}
      <PartView part={{ part: kind }} label="题目" text={question} />
    </section>
  )
}

/**
 * The day's division has a topic the lesson was not made about: the server took the lesson back to review and is making
 * it again for the topic, so the content shown is the one being replaced.
 */
const beingRemade = (slot: QueueSlot, lesson: LessonDetail) => slot.topic !== null && slot.topic !== lesson.topic

/** The bottom of the lesson: approve it and go on to the next lesson to review. */
function Approval({ slot, onNext }: { slot: QueueSlot; onNext: () => void }) {
  const { lesson, writing } = useEditing()
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
  if (beingRemade(slot, lesson)) reasons.push('这节课正在按新题目重新生成，等新稿出来再审。')
  return (
    <footer className="lesson-foot">
      <Button
        ref={button}
        type="primary"
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
        <p id={reasonId} className="foot-note" tabIndex={-1}>
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
function Notices({ slot }: { slot: QueueSlot }) {
  const { lesson, editable } = useEditing()
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
      notices.push(`这一天指定了新题目《${slot.topic}》，这节课正在按新题目重新生成；生成好以前，这里还是旧的内容。`)
    }
    if (slot.generationFailed !== null) {
      const { attempts, lastError } = slot.generationFailed
      notices.push(`按新题目重新生成失败，试了 ${attempts} 次。最后一次的原因：${sentence(lastError)}系统会接着重试。`)
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

const LESSON_TARGET: RewriteTarget = { kind: 'rewrite_lesson' }

/** The top of the lesson: where and what it is, what the page knows about it, its title, the whole-lesson rewrite. */
function Head({ slot, focused }: { slot: QueueSlot; focused: boolean }) {
  const { lesson, editable, writing, box, open } = useEditing()
  const opener = useOpener((closedBox) => isRewriteOf(closedBox, LESSON_TARGET))
  const { content } = lesson
  return (
    <header className="lesson-head">
      <p className="lesson-meta">
        {dayName(lesson.date)} {slot.label} · {content.subject} · 第 {lesson.version} 版
      </p>
      <Notices slot={slot} />
      <PartView part={{ part: 'title' }} label="标题" text={content.title} title focused={focused} />
      {editable && (
        <div className="lesson-actions">
          <Button
            ref={opener}
            size="small"
            disabled={writing}
            onClick={() => open({ what: 'rewrite', target: LESSON_TARGET })}
          >
            整节课重写
          </Button>
          {rewroteLast(lesson, 'rewrite_lesson') && <Restore what="整节课" target={LESSON_TARGET} />}
          {/* Which question was rewritten is not kept: the way back lives here, by the rewrite of the lesson. */}
          {rewroteLast(lesson, 'rewrite_call_on') && <Restore what="点名题" target={LESSON_TARGET} />}
        </div>
      )}
      {editable && isRewriteOf(box, LESSON_TARGET) && <ReasonBox target={LESSON_TARGET} what="重写整节课" />}
    </header>
  )
}

export function LessonEditor({
  lesson,
  slot,
  mode,
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
  // After a 这是误伤, the focus goes to the next one in reading order (its own and any other of the same rule are gone),
  // or, when none are left, to approving; or, when approving is held for another reason, to that reason.
  useEffect(() => {
    if (marked === undefined) return
    const rest = [...(article.current?.querySelectorAll<HTMLButtonElement>('.false-positive') ?? [])]
    const next =
      rest[Math.min(marked.at, rest.length - 1)] ??
      article.current?.querySelector<HTMLButtonElement>('.lesson-foot button:not(:disabled)') ??
      article.current?.querySelector<HTMLElement>('.lesson-foot .foot-note')
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
    markedWrong,
    box,
    closed,
    open,
    refocus,
    onChanged,
    onRefresh,
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
