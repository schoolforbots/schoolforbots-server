import { Button, Input, type GetRef } from 'antd'
import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { editPart, restore, rewrite, type LessonPart, type PromptTarget, type RewriteTarget } from '../../api.js'
import { CopyPrompt } from '../CopyPrompt.js'
import { PasteDialog } from '../PasteDialog.js'
import { Refusal, useAction, useEditing } from './Editing.js'

// The boxes a change to the lesson is made in, opened under what they change: 改字 for one part, a reason for a
// rewrite, and after a rewrite, the way back to the version before it.

type TextAreaRef = GetRef<typeof Input.TextArea>

/** Esc closes a box, unless what it sent is still under way. */
const closeOnEscape = (busy: boolean, close: () => void) => (event: KeyboardEvent) => {
  if (event.key !== 'Escape' || busy) return
  event.stopPropagation()
  close()
}

export function EditBox({ part, text, labelId }: { part: LessonPart; text: string; labelId: string }) {
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
export function ReasonBox({ target, what }: { target: RewriteTarget; what: string }) {
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
export function Restore({ what, target }: { what: string; target: RewriteTarget }) {
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
