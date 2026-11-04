import { Button } from 'antd'
import type { ReactNode } from 'react'

// The three states every page has besides its data. Each says what is going on and, where there is one, what to do
// next. No spinner: the page has no motion, and the words say it.

/** While `what` is read: 正在读取学校数据. */
export function Loading({ what }: { what: string }) {
  return (
    <div className="state" role="status">
      <p className="state-text">正在读取{what}</p>
    </div>
  )
}

/** Nothing to show: `why` says the cause and what comes next; `action` is the one thing to do about it, if any. */
export function Empty({ why, action }: { why: string; action?: ReactNode }) {
  return (
    <div className="state">
      <p className="state-text">{why}</p>
      {action}
    </div>
  )
}

/** `what` could not be read: says why, and offers to read it again. */
export function Failed({ what, reason, retry }: { what: string; reason: string; retry: () => void }) {
  return (
    <div className="state" role="alert">
      <p className="state-text">
        没能读取{what}。{reason}
      </p>
      <Button onClick={retry}>重新读取</Button>
    </div>
  )
}
