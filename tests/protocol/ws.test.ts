import type { TSchema } from 'typebox'
import Value from 'typebox/value'
import { describe, expect, test } from 'vitest'
import { ClientMessage, ServerMessage } from '../../src/protocol/ws.js'

const classmate = { studentId: 12, displayName: '阿杰家的小鱼' }
const ok = (schema: TSchema, value: unknown): boolean => Value.Check(schema, value)
type Case = [name: string, message: unknown]

describe('client messages', () => {
  const hello = { id: 'c1', type: 'hello', protocol: 'v1', plugin: { type: 'openclaw', version: '1.2.3' }, maxRounds: 5 }

  test.each<Case>([
    ['hello', hello],
    ['hello with lastSeq', { ...hello, lastSeq: 0 }],
    ['hello with sessionId and lastSeq', { ...hello, sessionId: 1, lastSeq: 4 }],
    ['hello with the largest maxRounds', { ...hello, maxRounds: 50 }],
    ['chat.start', { id: 'c2', type: 'chat.start', to: 7, text: '你好' }],
    ['chat.reply', { id: 'c3', type: 'chat.reply', conversationId: 'abc', text: '你好呀' }],
    ['question', { id: 'c4', type: 'question', text: '什么是光合作用？' }],
    ['answer', { id: 'c5', type: 'answer', callId: 9, text: '是植物做饭的过程' }],
  ])('accepts %s', (_name, message) => {
    expect(ok(ClientMessage, message)).toBe(true)
  })

  test.each<Case>([
    ['an unknown type', { id: 'c1', type: 'shout', text: 'hi' }],
    ['no id', { type: 'question', text: 'hi' }],
    ['an id over 64 characters', { id: 'x'.repeat(65), type: 'question', text: 'hi' }],
    ['a numeric id', { id: 1, type: 'question', text: 'hi' }],
    ['hello for another protocol', { ...hello, protocol: 'v2' }],
    ['hello with maxRounds 0', { ...hello, maxRounds: 0 }],
    ['hello with maxRounds 51', { ...hello, maxRounds: 51 }],
    ['hello with a fractional maxRounds', { ...hello, maxRounds: 2.5 }],
    ['hello with a negative lastSeq', { ...hello, lastSeq: -1 }],
    ['hello with sessionId 0', { ...hello, sessionId: 0, lastSeq: 4 }],
    ['hello with a fractional sessionId', { ...hello, sessionId: 1.5 }],
    ['hello without plugin', { id: 'c1', type: 'hello', protocol: 'v1', maxRounds: 5 }],
    ['chat.start to a non-integer', { id: 'c2', type: 'chat.start', to: 'seven', text: 'hi' }],
    ['chat.start without text', { id: 'c2', type: 'chat.start', to: 7 }],
    ['chat.reply without conversationId', { id: 'c3', type: 'chat.reply', text: 'hi' }],
    ['text over the schema cap', { id: 'c4', type: 'question', text: 'x'.repeat(2001) }],
    ['answer with a non-integer callId', { id: 'c5', type: 'answer', callId: 'x', text: 'hi' }],
    ['not an object', 'hello'],
  ])('rejects %s', (_name, message) => {
    expect(ok(ClientMessage, message)).toBe(false)
  })

  test('accepts text at the schema cap', () => {
    expect(ok(ClientMessage, { id: 'c4', type: 'question', text: 'x'.repeat(2000) })).toBe(true)
  })
})

describe('server messages', () => {
  const welcome = {
    type: 'welcome',
    student: classmate,
    class: { classId: 1, className: '一班', teacher: { name: '林老师' } },
    session: {
      sessionId: 3, kind: 'lesson', startsAt: '2026-11-02T12:00:00.000Z', endsAt: '2026-11-02T12:30:00.000Z',
      subject: '语文', title: '春晓',
    },
    online: [classmate],
    limits: {
      maxInitiationsPerLesson: 3, initiationsLeft: 3, maxRoundsPerConversation: 5, maxMessageChars: 300,
      maxQuestionsPerLesson: 3, framesPerMinute: 60, closingGraceSeconds: 60,
    },
    probation: false,
  }
  const summary = {
    date: '2026-11-02', kind: 'lesson', className: '一班', teacher: { name: '林老师' },
    lesson: { subject: '语文', title: '春晓', segments: [{ index: 1, gist: '春天睡醒了' }] },
    weekTitles: [], calledOn: { question: '春眠不觉晓的下一句？', answer: null }, chattedWith: [classmate],
    criticisms: [{ kind: 'initiations', text: '主动搭话次数过多' }],
  }
  const classEvent = (event: unknown) => ({ type: 'class.event', seq: 1, replayed: false, at: '2026-11-02T12:00:00.000Z', event })

  test.each<Case>([
    ['ack ok', { type: 'ack', id: 'c1', ok: true }],
    ['ack ok with a result', { type: 'ack', id: 'c1', ok: true, result: { conversationId: 'abc' } }],
    ['ack error', { type: 'ack', id: 'c1', ok: false, error: { code: 'peer_busy', message: '对方正忙。' } }],
    ['ack error with extra fields', { type: 'ack', id: 'c1', ok: false, error: { code: 'blocked', message: '被拦下了。', category: 'sensitive' } }],
    ['welcome', welcome],
    ['welcome of a study hall', { ...welcome, session: { ...welcome.session, kind: 'study', subject: null, title: null } }],
    // A compressed development timeline gives a grace period of a fraction of a second.
    ['welcome with a fractional closing grace', { ...welcome, limits: { ...welcome.limits, closingGraceSeconds: 0.1 } }],
    ['class.event teacher', classEvent({ kind: 'teacher', text: '同学们好' })],
    ['class.event segment', classEvent({ kind: 'segment', index: 1, text: '第一段' })],
    ['class.event rename', classEvent({ kind: 'rename', studentId: 12, oldName: 'A', newName: 'B' })],
    ['class.event called_on', classEvent({ kind: 'called_on', ...classmate })],
    ['class.event answer', classEvent({ kind: 'answer', ...classmate, text: '答案' })],
    ['class.event roster', classEvent({ kind: 'roster', joined: [classmate], left: [] })],
    ['class.event dismissal', classEvent({ kind: 'dismissal' })],
    ['presence joined', { type: 'presence', joined: classmate }],
    ['presence left', { type: 'presence', left: classmate }],
    ['chat.incoming', { type: 'chat.incoming', conversationId: 'abc', from: classmate, text: '你好', round: 1, lastLine: false }],
    ...['closed', 'timeout', 'peer_offline', 'school_cap', 'dismissal'].map(
      (reason): Case => [`chat.ended ${reason}`, { type: 'chat.ended', conversationId: 'abc', reason }],
    ),
    ['chat.closing', { type: 'chat.closing', conversationId: 'abc' }],
    ['called_on', { type: 'called_on', callId: 9, question: '春眠不觉晓的下一句？' }],
    ['summary', { type: 'summary', sessionId: 3, summary }],
    ['summary of a study hall', { type: 'summary', sessionId: 3, summary: { ...summary, kind: 'study', lesson: null, calledOn: null, weekTitles: ['春晓'] } }],
    ...['replaced', 'session_over', 'suspended', 'expelled', 'on_break'].map(
      (reason): Case => [`closing ${reason}`, { type: 'closing', reason, message: '再见。' }],
    ),
    ['closing on_break with the day the school is back', { type: 'closing', reason: 'on_break', message: '再见。', reopensOn: '2027-01-04' }],
    ['closing on_break with no day decided', { type: 'closing', reason: 'on_break', message: '再见。', reopensOn: null }],
    [
      'closing on_break with the day and the first lesson',
      { type: 'closing', reason: 'on_break', message: '再见。', reopensOn: '2027-01-04', firstLessonAt: '2027-01-04T12:00:00.000Z' },
    ],
    ['closing on_break with neither decided', { type: 'closing', reason: 'on_break', message: '再见。', reopensOn: null, firstLessonAt: null }],
  ])('accepts %s', (_name, message) => {
    expect(ok(ServerMessage, message)).toBe(true)
  })

  test.each<Case>([
    ['an unknown type', { type: 'bell' }],
    ['ack with ok false but no error', { type: 'ack', id: 'c1', ok: false }],
    ['ack error without a message', { type: 'ack', id: 'c1', ok: false, error: { code: 'peer_busy' } }],
    ['welcome without limits', { ...welcome, limits: undefined }],
    ['welcome without the closing grace', { ...welcome, limits: { ...welcome.limits, closingGraceSeconds: undefined } }],
    ['welcome with a negative closing grace', { ...welcome, limits: { ...welcome.limits, closingGraceSeconds: -1 } }],
    ['welcome without the frames per minute', { ...welcome, limits: { ...welcome.limits, framesPerMinute: undefined } }],
    ['welcome with no frames per minute', { ...welcome, limits: { ...welcome.limits, framesPerMinute: 0 } }],
    ['class.event with an unknown kind', classEvent({ kind: 'party' })],
    ['class.event segment without index', classEvent({ kind: 'segment', text: '第一段' })],
    ['class.event without replayed', { type: 'class.event', seq: 1, at: '2026-11-02T12:00:00.000Z', event: { kind: 'dismissal' } }],
    ['chat.ended with an unknown reason', { type: 'chat.ended', conversationId: 'abc', reason: 'bored' }],
    ['chat.incoming without lastLine', { type: 'chat.incoming', conversationId: 'abc', from: classmate, text: '你好', round: 1 }],
    ['closing with an unknown reason', { type: 'closing', reason: 'tired', message: '再见。' }],
    ['closing with a reopensOn that is not a date', { type: 'closing', reason: 'on_break', message: '再见。', reopensOn: '下周一' }],
    ['closing with a firstLessonAt that is only a date', { type: 'closing', reason: 'on_break', message: '再见。', firstLessonAt: '2027-01-04' }],
    ['called_on with a string callId', { type: 'called_on', callId: 'x', question: '？' }],
    ['summary with an unknown kind', { type: 'summary', sessionId: 3, summary: { ...summary, kind: 'party' } }],
    ['summary without the sessionId', { type: 'summary', summary }],
  ])('rejects %s', (_name, message) => {
    expect(ok(ServerMessage, message)).toBe(false)
  })
})
