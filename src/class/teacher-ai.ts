import type { Kysely } from 'kysely'
import type { Llm } from '../llm/client.js'
import { extractJson } from '../llm/json.js'
import { fillPrompt, neutralizeStudentText, type PromptName, type PromptTemplate } from '../llm/prompts.js'
import { LlmContentRefused, LlmUnavailable } from '../llm/provider.js'
import type { Moderator } from '../moderation/moderator.js'
import type { SecondLayer } from '../moderation/second-layer.js'
import type { Clock } from '../shared/clock.js'
import type { SchoolConfig } from '../shared/config.js'
import { displayName } from '../shared/identity.js'
import type { Database, SessionMember } from '../shared/schema.js'
import type { Switches } from '../shared/switches.js'
import { isValidText } from './chat.js'
import { appendClassEvent, classEventMessage, stepWritten, type StoredEvent } from './events.js'
import type { LessonHooks } from './hooks.js'
import type { Hub } from './hub.js'
import type { ActiveSession } from './runtime.js'

// What the teacher says in words of the model: after each segment, the answer to at most one of the students'
// questions, picked by the model for being on the segment's topic. The work runs in the background, apart from the
// lesson runtime, and holds no database transaction while the model thinks: the class goes on whatever the model does,
// and an answer that is not ready before the next segment is dropped.
//
// A line the teacher would say goes out only once it passes every check of `checkLine`; the class never hears a line
// the model wrote that did not.

/** The kinds of lines the teacher says in words of the model, as the blocks table counts them. */
type TeacherLinePurpose = 'answer' | 'comment'

/** A program log: numbers, outcomes and error names only, never a question, an answer or a prompt. */
export interface TeacherAiLog {
  info(obj: object, msg: string): void
  error(obj: object, msg: string): void
}

export interface TeacherAiDeps {
  db: Kysely<Database>
  config: SchoolConfig
  clock: Clock
  hub: Hub
  llm: Llm
  prompts: Record<PromptName, PromptTemplate>
  /** The word list a line of the teacher's passes first. */
  moderator: Moderator
  /** Then the second layer, as a line the teacher says aloud (source `teacher`). */
  secondLayer: SecondLayer
  /** `teacherLlm` off: the teacher answers no question. */
  switches: Switches
  /** Samples the questions when there are too many: a number in [0, 1), as `Math.random` (the default) gives. */
  random?: () => number
  log?: TeacherAiLog
}

export interface TeacherAi {
  /** Starts answering the questions of segment `k` (see `LessonHooks.startAnswering`), once per session and segment. */
  startAnswering: LessonHooks['startAnswering']
  /** Resolves once no work is going on: for tests, and for the shutdown. */
  idle(): Promise<void>
}

/** Why a line the teacher would say did not pass. */
type LineProblem = 'format' | 'length' | 'word_list' | 'prompt_text' | 'self_reference' | 'second_layer'

/** How one segment's answering ended, as the program log says it. */
type Outcome =
  | 'answered'
  | 'no_questions'
  | 'no_segment'
  | 'no_pick'
  | 'failed'
  | 'refused'
  | 'unavailable'
  | 'late'
  | 'dropped'

interface Question {
  studentId: number
  text: string
}

/** What the prompt says of the session: the teacher, the segment just taught, the members at the doors. */
interface Context {
  teacherName: string
  personality: string
  segmentText: string
  members: SessionMember[]
}

/** What the teacher calls himself when the class's persona is no longer in the config (as the runtime does). */
const FALLBACK_TEACHER = '老师'

/** With less than this left before the deadline the model is not called: its answer could not come back in time. */
const MIN_CALL_MS = 1000

const ANSWER_FORMAT =
  '只回复一个 JSON 对象，格式为 {"pick": <编号或 null>, "answer": "<回答>"}。' +
  'pick 写你要回答的那个问题的编号，answer 写你当众说的回答；' +
  '没有适合当众回答的问题时，pick 写 null，answer 写空字符串。不要写别的内容。'

/** Lines in which the teacher speaks as a machine, compared as `normalize` leaves them. */
const SELF_REFERENCES = ['作为AI', '作为一个AI', '作为人工智能', '我是AI', '我是一个AI', '语言模型', '人工智能助手'].map(normalize)

/** A piece of a prompt shorter than this is too common a phrase to tell that a line repeats the prompt. */
const MIN_PROMPT_PIECE_CHARS = 8

/** For comparing what is said: compatibility forms folded (full-width letters), no whitespace, lower case. */
function normalize(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, '').toLowerCase()
}

/**
 * The sentences of a prompt, with the format code puts into it, long enough that a line containing one repeats the
 * prompt. A placeholder stands for something else than the prompt's own words, so only what is around it counts; a
 * list number or bullet in front, and the punctuation at either end, are left out.
 */
function promptPieces(template: PromptTemplate, format = ''): string[] {
  return [template.system, template.user, format]
    .flatMap((text) => text.split(/[。！？!?\n]/u))
    .flatMap((sentence) => sentence.split(/\{\{\w+\}\}/u))
    .map((piece) =>
      normalize(piece)
        .replace(/^(?:\d+[.、)）]|[-*•])/u, '')
        .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, ''),
    )
    .filter((piece) => [...piece].length >= MIN_PROMPT_PIECE_CHARS)
}

/** `n` of `items` picked at random, in their order: all of them when there are no more. */
function sample<T>(items: T[], n: number, random: () => number): T[] {
  if (items.length <= n) return items
  const order = items.map((_, i) => i)
  for (let i = 0; i < n; i++) {
    const j = Math.min(i + Math.floor(random() * (order.length - i)), order.length - 1)
    ;[order[i], order[j]] = [order[j]!, order[i]!]
  }
  return order
    .slice(0, n)
    .sort((a, b) => a - b)
    .map((i) => items[i]!)
}

type Parsed = { pick: 'none' } | { pick: number; answer: string }

/**
 * The model's reply to the questions numbered 1 to `count`, or null when it is not one: a JSON object (words around it
 * are allowed) whose `pick` is null or one of the numbers, and whose `answer` is a string when there is a pick.
 */
function parseReply(text: string, count: number): Parsed | null {
  let json: unknown
  try {
    json = extractJson(text)
  } catch {
    return null
  }
  const { pick, answer } = json as { pick?: unknown; answer?: unknown }
  if (pick === null) return { pick: 'none' }
  if (typeof pick !== 'number' || !Number.isInteger(pick) || pick < 1 || pick > count) return null
  if (typeof answer !== 'string') return null
  return { pick, answer: answer.trim() }
}

export function createTeacherAi(deps: TeacherAiDeps): TeacherAi {
  const { db, config, clock, hub, llm, prompts, moderator, secondLayer, switches } = deps
  const random = deps.random ?? Math.random
  const log = deps.log
  const answerPieces = promptPieces(prompts['teacher-answer'], ANSWER_FORMAT)
  // Room for the longest answer allowed (a Chinese character may take two tokens) and the JSON around it.
  const answerTokens = 200 + 2 * config.chat.maxMessageChars

  const running = new Set<Promise<void>>()
  /** The answering started, by session and segment, until its deadline: the runtime may start a segment again. */
  const started = new Map<string, number>()

  /** Runs `work` in the background; `idle` waits for it. A failure is logged by its name. */
  function track(what: object, work: () => Promise<void>): void {
    const task: Promise<void> = work()
      .catch((err: unknown) =>
        log?.error({ ...what, err: err instanceof Error ? err.name : 'unknown' }, 'teacher work failed'),
      )
      .finally(() => running.delete(task))
    running.add(task)
  }

  async function recordBlock(
    sessionId: number,
    purpose: TeacherLinePurpose,
    layer: 'word_list' | 'second_layer',
  ): Promise<void> {
    await db.insertInto('teacherLineBlocks').values({ sessionId, purpose, layer, createdAt: clock.now() }).execute()
  }

  /**
   * Whether a line the teacher would say aloud may be said: null when it may, else why not. It must not be empty or
   * longer than a chat line, must pass the word list, must not repeat a sentence of its prompt (`pieces`) or speak as a
   * machine, and must pass the second layer as `aloud`: what the class would hear with it (an answer goes out with the
   * question it answers). A line the word list or the second layer stops is counted, without its text.
   */
  async function checkLine(
    sessionId: number,
    purpose: TeacherLinePurpose,
    line: string,
    opts: { pieces: string[]; aloud: string },
  ): Promise<LineProblem | null> {
    if (!isValidText(line, config.chat.maxMessageChars)) return 'length'
    if (moderator.check(line).verdict === 'blocked') {
      await recordBlock(sessionId, purpose, 'word_list')
      return 'word_list'
    }
    const said = normalize(line)
    if (opts.pieces.some((piece) => said.includes(piece))) return 'prompt_text'
    if (SELF_REFERENCES.some((phrase) => said.includes(phrase))) return 'self_reference'
    if ((await secondLayer.check('teacher', opts.aloud)) === 'blocked') {
      await recordBlock(sessionId, purpose, 'second_layer')
      return 'second_layer'
    }
    return null
  }

  /** The students answered this session already, by their `qa` events. */
  async function answeredStudents(sessionId: number): Promise<Set<number>> {
    const rows = await db
      .selectFrom('classEvents')
      .select('payload')
      .where('sessionId', '=', sessionId)
      .where('kind', '=', 'qa')
      .execute()
    return new Set(rows.map((r) => r.payload.studentId).filter((id): id is number => typeof id === 'number'))
  }

  /**
   * The questions of the session asked in [from, to) that the moderator let through, at most `questionSampleSize`:
   * those of students not answered yet this session first, then the others. Each group is in the order asked, and
   * picked at random when it does not all fit.
   */
  async function questionsOf(sessionId: number, from: Date, to: Date): Promise<Question[]> {
    const rows = await db
      .selectFrom('messages')
      .select(['senderId', 'text'])
      .where('sessionId', '=', sessionId)
      .where('kind', '=', 'question')
      .where('moderation', 'is', null)
      .where('createdAt', '>=', from)
      .where('createdAt', '<', to)
      .orderBy('createdAt')
      .orderBy('id')
      .execute()
    if (rows.length === 0) return []
    const answered = await answeredStudents(sessionId)
    const size = config.teacherAi.questionSampleSize
    const first = sample(rows.filter((r) => !answered.has(r.senderId)), size, random)
    const then = sample(rows.filter((r) => answered.has(r.senderId)), size - first.length, random)
    return [...first, ...then].map((r) => ({ studentId: r.senderId, text: r.text }))
  }

  /** The teacher and segment `k` of the session's lesson; null when the lesson has no such segment. */
  async function contextOf(sessionId: number, k: number): Promise<Context | null> {
    const row = await db
      .selectFrom('classSessions as s')
      .innerJoin('classes as c', 'c.id', 's.classId')
      .leftJoin('lessons as l', 'l.id', 's.lessonId')
      .select(['s.members', 'c.teacherPersonaId', 'l.segments'])
      .where('s.id', '=', sessionId)
      .executeTakeFirstOrThrow()
    const segmentText = row.segments?.[k - 1]?.text
    if (segmentText === undefined) return null
    const persona = config.teacherPersonas.find((p) => p.id === row.teacherPersonaId)
    return {
      teacherName: persona?.name ?? FALLBACK_TEACHER,
      personality: persona?.personality ?? '',
      segmentText,
      members: row.members,
    }
  }

  /** The asker's name in the session: as the members at the doors had it, else as the student is called now. */
  async function nameOf(members: SessionMember[], studentId: number): Promise<string> {
    const member = members.find((m) => m.studentId === studentId)
    if (member !== undefined) return member.displayName
    const s = await db
      .selectFrom('students')
      .select(['ownerName', 'aiName'])
      .where('id', '=', studentId)
      .executeTakeFirstOrThrow()
    return displayName(s.ownerName, s.aiName)
  }

  function answerPrompt(questions: Question[], ctx: Context): { system: string; user: string } {
    const max = config.chat.maxMessageChars
    return fillPrompt(prompts['teacher-answer'], {
      teacherName: ctx.teacherName,
      teacherPersona: ctx.personality,
      segmentText: ctx.segmentText,
      // The questions are the students' words: each on a line of its own, unable to close the block or number a line.
      questions: questions.map((q, i) => `${i + 1}. ${neutralizeStudentText(q.text, max)}`).join('\n'),
      maxChars: String(max),
      format: ANSWER_FORMAT,
    })
  }

  /**
   * Writes the answer as the `qa-{k}#2` event and pushes it to the class, unless the window has closed meanwhile: the
   * deadline has passed, or the step after it (the next segment, or the dismissal after the last) has been written.
   * The session's lock (taken by `stepWritten`, as by every writer of its events) orders it against that step.
   */
  async function publish(
    session: ActiveSession,
    k: number,
    deadline: Date,
    said: { question: Question; answer: string; members: SessionMember[] },
  ): Promise<boolean> {
    const { sessionId, classId } = session
    const step = `qa-${k}#2`
    const next = k < config.lesson.segmentMinutes.length ? `segment-${k + 1}` : 'dismissal'
    const { question, answer } = said
    const name = await nameOf(said.members, question.studentId)
    const event = await db.transaction().execute(async (trx): Promise<StoredEvent | null> => {
      if (await stepWritten(trx, sessionId, step)) return null
      const after = await trx
        .selectFrom('classEvents')
        .select('id')
        .where('sessionId', '=', sessionId)
        .where('step', '=', next)
        .executeTakeFirst()
      const now = clock.now()
      if (after !== undefined || now.getTime() >= deadline.getTime()) return null
      const payload = {
        kind: 'qa',
        segment: k,
        studentId: question.studentId,
        displayName: name,
        question: question.text,
        answer,
      }
      const written = await appendClassEvent(trx, { sessionId, step, kind: 'qa', payload, at: now })
      return written === null ? null : { seq: written.seq, step, kind: 'qa', payload, at: now }
    })
    if (event === null) return false
    hub.broadcast(classId, classEventMessage(event, false))
    return true
  }

  /**
   * One segment's answering: one call with the questions, then the checks. A reply that does not pass is generated
   * again once; the vendor refusing the questions has a random half of them tried once. No call is made without the
   * time for it before the deadline.
   */
  async function answerSegment(
    session: ActiveSession,
    k: number,
    window: { from: Date; to: Date; deadline: Date },
  ): Promise<{ outcome: Outcome; questions: number; calls: number; problems: LineProblem[] }> {
    const { sessionId } = session
    let questions = await questionsOf(sessionId, window.from, window.to)
    const problems: LineProblem[] = []
    let calls = 0
    const end = (outcome: Outcome) => ({ outcome, questions: questions.length, calls, problems })
    if (questions.length === 0) return end('no_questions')
    const ctx = await contextOf(sessionId, k)
    if (ctx === null) return end('no_segment')

    let halved = false
    for (;;) {
      const timeoutMs = Math.min(window.deadline.getTime() - clock.now().getTime(), config.llm.timeoutSeconds * 1000)
      if (timeoutMs < MIN_CALL_MS) return end('late')
      let reply: string
      calls++
      try {
        const prompt = answerPrompt(questions, ctx)
        reply = (await llm.call('answer', prompt, { json: true, timeoutMs, maxOutputTokens: answerTokens })).text
      } catch (err) {
        if (err instanceof LlmUnavailable) return end('unavailable')
        if (!(err instanceof LlmContentRefused)) throw err
        // Most likely one question is what the vendor will not take: a random half of them may leave it out.
        const half = Math.floor(questions.length / 2)
        if (halved || half === 0) return end('refused')
        halved = true
        questions = sample(questions, half, random)
        continue
      }

      const parsed = parseReply(reply, questions.length)
      if (parsed !== null && parsed.pick === 'none') return end('no_pick')
      let problem: LineProblem | null = 'format'
      if (parsed !== null) {
        const question = questions[parsed.pick - 1]!
        problem = await checkLine(sessionId, 'answer', parsed.answer, {
          pieces: answerPieces,
          aloud: `${question.text}\n${parsed.answer}`,
        })
        if (problem === null) {
          const said = { question, answer: parsed.answer, members: ctx.members }
          return end((await publish(session, k, window.deadline, said)) ? 'answered' : 'dropped')
        }
      }
      problems.push(problem)
      if (problems.length > 1) return end('failed')
    }
  }

  return {
    startAnswering(session, k, window) {
      const now = clock.now().getTime()
      // Only the windows still open are remembered.
      for (const [key, deadline] of started) if (deadline <= now) started.delete(key)
      const key = `${session.sessionId}:${k}`
      if (started.has(key)) return
      const what = { sessionId: session.sessionId, classId: session.classId, segment: k }
      // A step run late (the service was down through the window) has nothing left to answer in.
      if (window.deadline.getTime() <= now) {
        log?.info({ ...what, outcome: 'late', calls: 0 }, 'teacher answer')
        return
      }
      started.set(key, window.deadline.getTime())
      if (!switches.isOn('teacherLlm')) return
      track(what, async () => {
        const result = await answerSegment(session, k, window)
        log?.info({ ...what, ...result }, 'teacher answer')
      })
    },

    async idle() {
      while (running.size > 0) await Promise.all(running)
    },
  }
}
