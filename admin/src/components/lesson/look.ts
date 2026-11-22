import type { QueueSlot } from '../../api.js'
import type { Tone } from '../../ui.js'

// The Tailwind classes the review page's parts share, after HyperUI's form layouts, alerts and badges.

/** A field's label. */
export const LABEL = 'block text-sm font-medium text-gray-700'
/** The line under a label that says how to fill it in. */
export const HINT = 'mt-1 text-xs text-gray-600'
/** A refusal or a missing reason, said where the change was asked for: framed, in words, not in red. */
export const REFUSAL =
  'mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900'
/** What the page knows about a lesson that holds it up (HyperUI's alert, in yellow). */
export const NOTICE = 'rounded-md border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800'
/** A failure the page reports (a lesson that could not be made): the alert in red. */
export const FAILURE = 'rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800'
/** A quiet notice: the lesson is read-only. */
export const QUIET_NOTICE = 'rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700'
/** A box a change is made in, under what it changes. */
export const BOX = 'mt-3 rounded-lg border border-gray-200 bg-gray-50 p-4'
/** The row of buttons at the bottom of a box. */
export const BOX_ACTIONS = 'mt-3 flex flex-wrap items-center gap-2'

/** The colour of a slot's status badge: green settled, red marks or a failure, yellow to review, grey otherwise. */
export function slotTone(slot: QueueSlot): Tone {
  if (slot.locked) return 'gray'
  switch (slot.status) {
    case 'approved':
      return 'green'
    case 'flagged':
      return 'red'
    case 'pending':
      return 'yellow'
    case 'missing':
      return slot.generationFailed !== null ? 'red' : 'gray'
  }
}
