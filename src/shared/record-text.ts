import { localMoment } from './local-time.js'
import type { DisciplineKind } from './schema.js'

// What a discipline record says in words. The class service puts the four criticisms into the after-school summary;
// the registration service tells the owner every kind of record. Both use these sentences, so they are written once.

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

/** An `until` of a suspension or an expulsion as the school's wall clock reads it. */
function untilText(detail: Record<string, unknown>, timeZone: string): string {
  const until = typeof detail.until === 'string' ? new Date(detail.until) : null
  return until === null || Number.isNaN(until.getTime()) ? '' : localMoment(until, timeZone)
}

/**
 * A discipline record in the words the owner reads: the student's own (the four criticisms) or the school's. A
 * `school_rule` or `privacy_block` quotes the line as it was stored, numbers and addresses already masked.
 */
export function recordText(
  record: { kind: DisciplineKind; detail: Record<string, unknown> },
  timeZone: string,
): string {
  const { kind, detail } = record
  switch (kind) {
    case 'initiations':
      return '主动搭话次数过多'
    case 'rounds':
      return `和${textOf(detail.partnerName)}同学聊天聊了太久`
    case 'school_rule':
      return `想发言被老师批评违反校规了，我当时想说："${textOf(detail.quote)}"`
    case 'privacy_block':
      return `老师拦下了我一句可能说漏你隐私的话："${textOf(detail.quote)}"`
    case 'parent_notice':
      return '请家长：您家孩子这周话特别多，要不要把搭话频率调低一点？'
    case 'suspension':
      // A suspension the admin gave by hand says so, and for how long.
      if (detail.by === 'admin') {
        const days = typeof detail.days === 'number' ? detail.days : ''
        return `老师手动给你停课 ${days} 天，到 ${untilText(detail, timeZone)}`
      }
      return `停课到 ${untilText(detail, timeZone)}`
    case 'expulsion':
      return `被开除，${untilText(detail, timeZone)} 前不能重新报名`
    case 'withdrawal':
      return '老师手动给你办了退学'
    case 'penalty_lift':
      return '老师手动解除了处罚'
  }
}
