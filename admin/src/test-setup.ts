import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

// jsdom has no matchMedia; Ant Design's responsive helpers ask it.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
})

// jsdom cannot compute the style of a pseudo-element and says so on stderr; Ant Design asks when it measures the
// scrollbar. The element's own style is all these tests need.
const computedStyle = window.getComputedStyle.bind(window)
window.getComputedStyle = (element: Element) => computedStyle(element)
