import { Button, Modal, TextArea } from '../ui.js'
import { useId, useRef, useState } from 'react'
import { getPrompt, type ApiError, type PromptTarget } from '../api.js'
import { LABEL, REFUSAL } from './lesson/look.js'

// 复制提示词: reads the prompt the server builds for a lesson or a rewrite and puts it on the clipboard. A browser that
// will not let the page write the clipboard gets the text in a read-only box to copy by hand.

type Stage =
  | { name: 'idle' }
  | { name: 'reading' }
  | { name: 'copied' }
  | { name: 'byHand'; text: string }
  | { name: 'failed'; reason: string }

/** `ready` is asked first and may refuse (a rewrite needs its reason before there is a prompt to copy). */
export function CopyPrompt({ target, ready }: { target: PromptTarget; ready?: () => boolean }) {
  const [stage, setStage] = useState<Stage>({ name: 'idle' })
  const boxId = useId()
  const box = useRef<HTMLTextAreaElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  function close() {
    setStage({ name: 'idle' })
    // Back to the button that opened it, at once, so the focus never rests on the page.
    button.current?.focus()
  }

  async function copy() {
    // Not disabled meanwhile: a disabled button would lose the focus, which the dialog below gives back to it.
    if (stage.name === 'reading' || (ready !== undefined && !ready())) return
    setStage({ name: 'reading' })
    let text: string
    try {
      ;({ text } = await getPrompt(target))
    } catch (error) {
      setStage({ name: 'failed', reason: `没能取到提示词：${(error as ApiError).message}` })
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      setStage({ name: 'copied' })
    } catch {
      // No clipboard here (an insecure page, or the browser said no): the text itself is the fallback.
      setStage({ name: 'byHand', text })
    }
  }

  return (
    <>
      <Button ref={button} size="small" onClick={copy}>
        复制提示词
      </Button>
      {stage.name === 'copied' && (
        <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800" role="status">
          已复制
        </span>
      )}
      {stage.name === 'failed' && (
        <p className={REFUSAL} role="alert">
          {stage.reason}
        </p>
      )}
      <Modal
        open={stage.name === 'byHand'}
        title="复制提示词"
        width="max-w-2xl"
        closable={false}
        destroyOnHidden
        // The text is there to be copied: focus it, selected, so Esc closes the dialog and a copy key copies it all.
        afterOpenChange={(opened) => opened && box.current?.focus()}
        onCancel={close}
        footer={<Button onClick={close}>关闭</Button>}
      >
        <p className="mb-4 text-gray-600">浏览器没让这一页写剪贴板。点进下面的框，全选以后自己复制。</p>
        <label className={`${LABEL} mb-1`} htmlFor={boxId}>
          提示词
        </label>
        <TextArea
          id={boxId}
          ref={box}
          readOnly
          value={stage.name === 'byHand' ? stage.text : ''}
          autoSize={{ minRows: 8, maxRows: 16 }}
          onFocus={(event) => event.currentTarget.select()}
        />
      </Modal>
    </>
  )
}
