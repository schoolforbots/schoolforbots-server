import { Button, Modal } from '../ui.js'
import { useId, useState, type ReactNode } from 'react'
import type { ApiError } from '../api.js'
import { useFocusOnMount } from '../focus.js'

// The second click before something these pages cannot take back: the dialog says what will happen, and only its own
// button does it. The focus starts on the button that backs out, which the consequences describe, so a screen reader
// reads them with it. While the change is sent the dialog stays open; a refusal is said inside it, in the server's
// words, and takes the focus (the button that sent it is disabled meanwhile, and Esc still has to reach the dialog).

function Refused({ reason }: { reason: string }) {
  const self = useFocusOnMount<HTMLParagraphElement>()
  return (
    <p ref={self} tabIndex={-1} className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
      {reason}
    </p>
  )
}

export function Confirm({
  title,
  children,
  confirm,
  busy,
  cancel,
  canConfirm = true,
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string
  /** What doing it will do. */
  children: ReactNode
  /** The button that does it, and what it says while it is sent. */
  confirm: string
  busy: string
  /** The button that backs out. */
  cancel: string
  /** False while what the dialog asks for is not filled in: the button that does it is disabled. */
  canConfirm?: boolean
  /** Something that cannot be taken back (deleting, expelling): the button that does it is drawn in red. */
  danger?: boolean
  /** Does it; fails with the server's ApiError. The caller closes the dialog once it is done. */
  onConfirm: () => Promise<void>
  /** Backing out: the caller closes the dialog and gives the focus back to what opened it. */
  onCancel: () => void
}) {
  const [sending, setSending] = useState(false)
  const [refusal, setRefusal] = useState<{ reason: string; n: number }>()
  // The dialog's content is in the page by the time this runs, and the dialog leaves a focus inside it where it is.
  const back = useFocusOnMount<HTMLButtonElement>()
  const consequencesId = useId()

  async function go() {
    setSending(true)
    try {
      await onConfirm()
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
      onCancel={() => {
        if (!sending) onCancel()
      }}
      footer={
        <>
          <Button ref={back} onClick={onCancel} disabled={sending} aria-describedby={consequencesId}>
            {cancel}
          </Button>
          <Button type={danger ? 'danger' : 'primary'} onClick={go} disabled={sending || !canConfirm}>
            {sending ? busy : confirm}
          </Button>
        </>
      }
    >
      <div id={consequencesId} className="flex flex-col gap-2 leading-relaxed">
        {children}
      </div>
      {/* Keyed by the try, so each refusal takes the focus anew. */}
      {refusal !== undefined && <Refused key={refusal.n} reason={refusal.reason} />}
    </Modal>
  )
}
