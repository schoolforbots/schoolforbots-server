import { Button, Input, Modal } from 'antd'
import { useId, useRef, useState } from 'react'
import { paste, type ApiError, type LessonDetail, type PromptTarget } from '../api.js'
import { useFocusOnMount } from '../focus.js'

// 粘贴结果: the reply a model gave to a copied prompt, pasted back in whole. The server finds the lesson in it and checks
// it; when it will not do, its reason goes right under the box, and what was pasted stays there to fix.

/** The server's reason, under the box; it takes the focus (the button that sent the reply was disabled meanwhile). */
function Refused({ reason }: { reason: string }) {
  const self = useFocusOnMount<HTMLParagraphElement>()
  return (
    <p ref={self} tabIndex={-1} className="action-error" role="alert">
      {reason}
    </p>
  )
}

export function PasteDialog({
  title,
  target,
  onClose,
  onPasted,
}: {
  title: string
  /** A rewrite names the version of the lesson it was made from. */
  target: PromptTarget & { baseVersion?: number }
  onClose: () => void
  onPasted: (lesson: LessonDetail) => void
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [refusal, setRefusal] = useState<{ reason: string; n: number }>()
  const [blank, setBlank] = useState(false)
  const boxId = useId()
  const hintId = useId()
  const box = useRef<HTMLTextAreaElement>(null)
  const making = target.kind === 'generate'

  async function send() {
    if (text.trim() === '') {
      setBlank(true)
      box.current?.focus()
      return
    }
    setSending(true)
    setBlank(false)
    try {
      onPasted(await paste(target, text))
    } catch (error) {
      setRefusal((last) => ({ reason: (error as ApiError).message, n: (last?.n ?? 0) + 1 }))
      setSending(false)
    }
  }

  return (
    <Modal
      open
      title={title}
      closable={false}
      maskClosable={false}
      destroyOnHidden
      // The box is the reason the dialog is open: start there.
      afterOpenChange={(opened) => opened && box.current?.focus()}
      onCancel={onClose}
      footer={
        <>
          <Button onClick={onClose}>关闭</Button>
          <Button type="primary" onClick={send} disabled={sending}>
            {making ? '存成待审的课' : '换上重写的内容'}
          </Button>
        </>
      }
    >
      <p id={hintId} className="dialog-hint">
        把大模型的回复整段贴进来，前后夹着别的话也没关系：系统会从里面找出课程，检查格式、过一遍词库，
        {making ? '然后存成待审的课。' : '然后换下这节课里要重写的部分，再回到待审。'}
      </p>
      <label className="field-label" htmlFor={boxId}>
        大模型的回复
      </label>
      <Input.TextArea
        id={boxId}
        ref={(field) => {
          box.current = field?.resizableTextArea?.textArea ?? null
        }}
        aria-describedby={hintId}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          setBlank(false)
        }}
        autoSize={{ minRows: 10, maxRows: 18 }}
      />
      {blank && (
        <p className="action-error" role="alert">
          先把大模型的回复贴进来。
        </p>
      )}
      {/* Keyed by the try, so each refusal takes the focus anew. */}
      {refusal !== undefined && !blank && <Refused key={refusal.n} reason={refusal.reason} />}
    </Modal>
  )
}
