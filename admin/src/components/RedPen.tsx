import { Button } from 'antd'
import { Fragment, useId, type ReactNode } from 'react'
import type { LessonFlag } from '../api.js'

// The red pen of the review page, the one place the pages use red: a flagged word gets a wavy red line in the text,
// and every red mark of a part gets a note in red in the margin, with a button to call it a false positive. A part
// without a mark says so in grey, so an empty margin is never mistaken for one still loading.

/** The rule privacy hits are marked under (they name no rule of their own). */
const PRIVACY_RULE = '隐私信息'

/**
 * A rule written as a pattern, not a word: it has characters a word does not. The pattern itself is not shown; it
 * would tell nothing a reviewer needs and only teach how the check works.
 */
const isPattern = (rule: string) => /[\\^$.*+?()[\]{}|]/.test(rule)

/** What the margin says about a mark. */
function noteFor(rule: string): string {
  if (rule === PRIVACY_RULE) return '可能含有隐私信息'
  if (isPattern(rule)) return '命中一条防骗规则'
  return `词库命中“${rule}”一词`
}

/** Where the flagged words are in `text`, as they are written there (case ignored), overlaps merged. */
function wordRanges(text: string, flags: LessonFlag[]): [number, number][] {
  const ranges: [number, number][] = []
  for (const { rule } of flags) {
    if (rule === PRIVACY_RULE || isPattern(rule) || rule === '') continue
    // A word has none of a pattern's characters, so it reads as itself.
    for (const match of text.matchAll(new RegExp(rule, 'giu'))) {
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

function Note({
  rule,
  onFalsePositive,
  disabled,
}: {
  rule: string
  onFalsePositive?: (rule: string) => void
  disabled: boolean
}) {
  const noteId = useId()
  return (
    <li className="pen-note">
      <p id={noteId}>{noteFor(rule)}</p>
      {onFalsePositive !== undefined && (
        <Button size="small" aria-describedby={noteId} disabled={disabled} onClick={() => onFalsePositive(rule)}>
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
  onFalsePositive?: (rule: string) => void
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
            <Note key={flag.rule} rule={flag.rule} onFalsePositive={onFalsePositive} disabled={disabled} />
          ))}
        </ul>
      )}
      {children}
    </div>
  )
}
