import { Button } from 'antd'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import {
  markFalsePositive,
  type CallOnKind,
  type LessonDetail,
  type LessonPart,
  type QueueSlot,
  type RewriteTarget,
} from '../../api.js'
import { dayName } from '../../labels.js'
import { Margin, Marked } from '../RedPen.js'
import { Notices } from './Approval.js'
import { EditBox, ReasonBox, Restore } from './Boxes.js'
import { isEditOf, isRewriteOf, Refusal, useAction, useEditing, useOpener } from './Editing.js'

// The parts of the lesson, in reading order: the head with the title, then each segment with its text and gist, and the
// call-on questions. Each part has its margin, and the buttons that open the box changing it.

const CALL_ON_NAMES: Record<CallOnKind, string> = { review: '复习题', extension: '引申题' }

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
  const { lesson, editable, writing, box, open, falsePositiveIndex, markedWrong } = useEditing()
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
    const at = falsePositiveIndex(button)
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

export function Segment({ index, text, gist }: { index: number; text: string; gist: string }) {
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

export function CallOn({ kind, after, question }: { kind: CallOnKind; after: number; question: string }) {
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

const LESSON_TARGET: RewriteTarget = { kind: 'rewrite_lesson' }

/** The top of the lesson: where and what it is, what the page knows about it, its title, the whole-lesson rewrite. */
export function Head({ slot, focused }: { slot: QueueSlot; focused: boolean }) {
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
