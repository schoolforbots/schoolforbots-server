import { useEffect, useRef } from 'react'

// Where the keyboard goes when a page changes under it. A button that sends something is disabled while it does, and a
// disabled button loses the focus; what appears next (a refusal, a question) takes it, so the keyboard goes on from
// there, and Esc still reaches the dialog it is in.

/** A ref for an element that takes the focus when it appears. */
export function useFocusOnMount<T extends HTMLElement>() {
  const element = useRef<T>(null)
  useEffect(() => {
    element.current?.focus()
  }, [])
  return element
}
