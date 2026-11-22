import { Button } from '../ui.js'
import type { ReactNode } from 'react'

// The three states every page has besides its data, after HyperUI's empty states: centred in the card, a quiet
// round mark, the words, and the one thing to do next. Each says what is going on and, where there is one, what to
// do next. No spinner: the page has no motion, and the words say it.

function Mark({ tone }: { tone: 'gray' | 'red' }) {
  return (
    <span
      aria-hidden="true"
      className={
        'grid size-10 place-content-center rounded-full ' +
        (tone === 'red' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500')
      }
    >
      <svg viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.5">
        {tone === 'red' ? (
          <path d="M10 6v5m0 3h.01M3.5 16h13L10 4 3.5 16Z" strokeLinejoin="round" strokeLinecap="round" />
        ) : (
          <path d="M3 6.5h14M3 6.5V15a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6.5M3 6.5 5 4h10l2 2.5M8 10h4" strokeLinejoin="round" strokeLinecap="round" />
        )}
      </svg>
    </span>
  )
}

/** While `what` is read: 正在读取学校数据. */
export function Loading({ what }: { what: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10 text-center" role="status">
      <p className="text-sm text-gray-600">正在读取{what}</p>
    </div>
  )
}

/** Nothing to show: `why` says the cause and what comes next; `action` is the one thing to do about it, if any. */
export function Empty({ why, action }: { why: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
      <Mark tone="gray" />
      <p className="max-w-md text-sm text-gray-600">{why}</p>
      {action}
    </div>
  )
}

/** `what` could not be read: says why, and offers to read it again. */
export function Failed({ what, reason, retry }: { what: string; reason: string; retry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10 text-center" role="alert">
      <Mark tone="red" />
      <p className="max-w-md text-sm text-gray-900">
        没能读取{what}。{reason}
      </p>
      <Button onClick={retry}>重新读取</Button>
    </div>
  )
}
