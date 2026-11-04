import type { SchoolConfig } from '../shared/config.js'
import type { LlmPurpose } from './client.js'

/**
 * The fixed replies of fake mode, one shape per purpose; the parsers of the callers accept exactly these.
 * The lesson reply is a whole lesson plus the single-field replies of the segment and call-on rewrites, so
 * every lesson prompt kind parses it. Everything stays inside the length limits of those formats.
 */
export function fakeReply(purpose: LlmPurpose, user: string, config: SchoolConfig): string {
  switch (purpose) {
    case 'lesson': {
      const text = '今天我们来聊聊身边的小事。先想一想，你今天遇到过什么有趣的事情？把它说给同学听一听吧。'
      const gist = '聊聊身边的小事'
      return JSON.stringify({
        title: '身边的小事',
        subject: '语文',
        segments: config.lesson.segmentMinutes.map(() => ({ text, gist })),
        callOnQuestions: { review: '刚才讲了什么？请用一句话说一说。', extension: '你还能想到哪些类似的小事？' },
        text,
        gist,
        question: '请用一句话说说刚才讲的内容。',
      })
    }
    case 'answer':
      return JSON.stringify({ pick: 1, answer: '这是个好问题，我们课后一起想一想。' })
    case 'comment':
      return '说得不错。'
    case 'secondLayerTeacher':
    case 'secondLayerChat':
      return JSON.stringify({
        results: [...user.matchAll(/"id":\s*(\d+)/g)].map((m) => ({ id: Number(m[1]), verdict: 'pass' })),
      })
    case 'weekly':
      return JSON.stringify({ removeRules: [], directions: [] })
    case 'wordList':
      return JSON.stringify({ suggestions: [] })
  }
}
