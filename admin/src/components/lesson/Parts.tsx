import { Badge, Button } from '../../ui.js'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import {
  confirmCallOn,
  markFalsePositive,
  type CallOnKind,
  type LessonDetail,
  type LessonPart,
  type QueueSlot,
  type RewriteTarget,
} from '../../api.js'
import { dayName, slotStatus } from '../../labels.js'
import { NOTICE, slotTone } from './look.js'
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
    <div
      ref={group}
      tabIndex={-1}
      className="grid grid-cols-[minmax(0,1fr)_240px] gap-6 py-3 focus-visible:outline-offset-4"
      role="group"
      aria-labelledby={labelId}
    >
      <div className="min-w-0">
        <p id={labelId} className="text-xs font-medium text-gray-500">
          {label}
        </p>
        {editing ? (
          <EditBox part={part} text={text} labelId={labelId} />
        ) : (
          <>
            <Text
              ref={title ? heading : undefined}
              tabIndex={title ? -1 : undefined}
              className={
                title
                  ? 'mt-1 text-xl font-semibold text-gray-900 focus-visible:outline-offset-4'
                  : 'mt-1 text-[15px] leading-[1.9] text-gray-900'
              }
            >
              <Marked text={text} flags={flags} />
            </Text>
            {editable && (
              <Button
                ref={opener}
                type="text"
                size="small"
                className="mt-1 -ml-3"
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
    <div className="flex items-center gap-3">
      <h3 id={id} className="text-sm font-semibold text-gray-900">
        {name}
      </h3>
      {note !== undefined && <Badge tone="indigo">{note}</Badge>}
      {children !== undefined && children !== false && <div className="ml-auto">{children}</div>}
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
    <section className="px-6 pt-5 pb-2" aria-labelledby={id}>
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
  const { lesson, editable, writing, box, open, refocus } = useEditing()
  const id = useId()
  const target: RewriteTarget = { kind: 'rewrite_call_on', callOn: kind }
  const opener = useOpener((closedBox) => isRewriteOf(closedBox, target))
  const check = useAction()

  async function confirm() {
    // The 没问题 goes with the reminder: the focus goes to the button that rewrites this question.
    if (await check.run(() => confirmCallOn(lesson, kind))) refocus({ what: 'rewrite', target })
  }
  return (
    // The questions the class is called on to answer, set apart from the segments on a faint indigo.
    <section className="bg-indigo-50/40 px-6 pt-5 pb-2" aria-labelledby={id}>
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
      {lesson.callOnChecks.includes(kind) && (
        <div className="mt-3">
          <p className={`${NOTICE} flex flex-wrap items-center justify-between gap-2`}>
            <span>出题范围里的段落改过，请再看一眼</span>
            {editable && (
              <Button size="small" disabled={writing} onClick={() => void confirm()}>
                没问题
              </Button>
            )}
          </p>
          <Refusal action={check} back={opener} />
        </div>
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
    <header className="px-6 pt-5 pb-4">
      {/* Where and what the lesson is, as the template's badges; the text reads as one line too. */}
      <p className="flex flex-wrap items-center gap-2 text-sm text-gray-600">
        <span className="font-medium text-gray-900">{dayName(lesson.date)}</span> <Badge>{slot.label}</Badge>{' '}
        <Badge>{content.subject}</Badge> <Badge tone="indigo">第 {lesson.version} 版</Badge>{' '}
        <Badge tone={slotTone(slot)}>{slotStatus(slot)}</Badge>
      </p>
      <Notices slot={slot} />
      <PartView part={{ part: 'title' }} label="标题" text={content.title} title focused={focused} />
      {editable && (
        <div className="flex flex-wrap items-start gap-4 pb-1">
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
