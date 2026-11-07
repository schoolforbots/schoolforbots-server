import { Button } from 'antd'
import { Fragment, useId, type ReactNode } from 'react'
import type { LessonFlag } from '../api.js'

// The red pen of the review page, the one place the pages use red: a flagged word gets a wavy red line in the text,
// and every red mark of a part gets a note in red in the margin, with a button to call it a false positive. A part
// without a mark says so in grey, so an empty margin is never mistaken for one still loading.

/** What the margin says about a mark. An anti-trick rule is not printed: a reviewer needs only to know one hit. */
function noteFor(flag: LessonFlag): string {
  switch (flag.kind) {
    case 'word':
      return `词库命中“${flag.rule}”一词`
    case 'pattern':
      return '命中一条防骗规则'
    case 'privacy':
      return '可能含有隐私信息'
  }
}

const escaped = (word: string) => word.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')

/** Where the flagged words are in `text`, as they are written there (case ignored), overlaps merged. */
function wordRanges(text: string, flags: LessonFlag[]): [number, number][] {
  const ranges: [number, number][] = []
  for (const flag of flags) {
    if (flag.kind !== 'word' || flag.rule === '') continue
    for (const match of text.matchAll(new RegExp(escaped(flag.rule), 'giu'))) {
      ranges.push([match.index, match.index + match[0].length])
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([...range])
  }
  return merged
}

/**
 * `text` with each flagged word in it underlined in red. A word the check found only once spacing or look-alike
 * letters were taken out is not in the text as written; its note in the margin still names it.
 */
export function Marked({ text, flags }: { text: string; flags: LessonFlag[] }) {
  const ranges = wordRanges(text, flags)
  if (ranges.length === 0) return <>{text}</>
  const pieces: ReactNode[] = []
  let at = 0
  for (const [start, end] of ranges) {
    pieces.push(<Fragment key={`t${start}`}>{text.slice(at, start)}</Fragment>)
    pieces.push(
      <mark key={`m${start}`} className="pen-word">
        {text.slice(start, end)}
      </mark>,
    )
    at = end
  }
  pieces.push(<Fragment key="rest">{text.slice(at)}</Fragment>)
  return <>{pieces}</>
}

/** Called with the rule, and the button pressed (the focus moves on from it). */
type OnFalsePositive = (rule: string, button: HTMLElement) => void

function Note({
  flag,
  onFalsePositive,
  disabled,
}: {
  flag: LessonFlag
  onFalsePositive?: OnFalsePositive
  disabled: boolean
}) {
  const noteId = useId()
  return (
    <li className="pen-note">
      <p id={noteId}>{noteFor(flag)}</p>
      {onFalsePositive !== undefined && (
        <Button
          size="small"
          // The lesson editor hands the focus on from one 这是误伤 to the next by this.
          data-focus="false-positive"
          aria-describedby={noteId}
          disabled={disabled}
          onClick={(event) => onFalsePositive(flag.rule, event.currentTarget)}
        >
          这是误伤
        </Button>
      )}
    </li>
  )
}

/**
 * The margin beside one part of a lesson: a red note for each of its marks, each with 这是误伤 while the lesson can
 * still change (`onFalsePositive`; `disabled` while one is being sent), or 没有批注. `children` adds what else
 * belongs beside the part.
 */
export function Margin({
  flags,
  onFalsePositive,
  disabled = false,
  children,
}: {
  flags: LessonFlag[]
  onFalsePositive?: OnFalsePositive
  disabled?: boolean
  children?: ReactNode
}) {
  return (
    <div className="pen-margin">
      {flags.length === 0 ? (
        <p className="pen-none">没有批注</p>
      ) : (
        <ul className="pen-notes">
          {flags.map((flag) => (
            <Note key={flag.rule} flag={flag} onFalsePositive={onFalsePositive} disabled={disabled} />
          ))}
        </ul>
      )}
      {children}
    </div>
  )
}
