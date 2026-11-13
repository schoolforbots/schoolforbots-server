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
import { callsOf, writeComment, type Call } from './questions.js'
import type { ActiveSession } from './runtime.js'
import * as teacher from './teacher.js'
import { classDelayMs, lessonSteps } from './timeline.js'

// What the teacher says in words of the model: after each segment, the answer to at most one of the students'
// questions, picked by the model for being on the segment's topic; and a comment on each answer to a call-on. The work
// runs in the background, apart from the lesson runtime, and holds no database transaction while the model thinks: the
// class goes on whatever the model does, and what is not ready before the next segment is dropped. A comment the model
// does not give in time, or that does not pass, is the template thanks.
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
  /** `teacherLlm` off: the teacher answers no question, and comments on an answer with the template thanks. */
  switches: Switches
  /** Timeline speed (see `lessonSteps`): when the next segment starts, before which a comment must be out. */
  speed: number
  /** Samples the questions when there are too many: a number in [0, 1), as `Math.random` (the default) gives. */
  random?: () => number
  log?: TeacherAiLog
}

export interface TeacherAi {
  /** Starts answering the questions of segment `k` (see `LessonHooks.startAnswering`), once per session and segment. */
  startAnswering: LessonHooks['startAnswering']
  /**
   * Starts the comment on the answer to call-on `n` (`callId`), just taken; once per session and call-on. Returns at
   * once. The comment is the model's, when it passes the checks before the next segment starts; else the template
   * thanks, said at once (see questions.ts for which of the two is the one said). Should the work fail before it
   * writes either, the call-on's close says the template thanks.
   */
  startComment(session: Pick<ActiveSession, 'sessionId' | 'classId' | 'closeAt'>, n: number, callId: number): void
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

/** How the comment on an answer ended, as the program log says it. */
type CommentOutcome = 'commented' | 'template' | 'dropped' | 'no_answer'

/** Why the comment is the template thanks and not the model's; `failed` is an unforeseen error, logged by its name. */
type TemplateReason = 'switched_off' | 'no_lesson' | 'no_time' | 'refused' | 'unavailable' | 'failed' | LineProblem

interface Question {
  studentId: number
  text: string
}

/** What the prompt says of the session: the teacher, the lesson taught so far, the members at the doors. */
interface Context {
  teacherName: string
  personality: string
  lessonSoFar: string
  members: SessionMember[]
}

/** What the prompt of a comment says, and by when the comment must be out. */
interface CommentContext {
  teacherName: string
  personality: string
  /** The lesson's question of the call-on; null when the lesson has none. */
  question: string | null
  /** The segments the question is on; null when the lesson has none of them. */
  segmentText: string | null
  /** When the next segment starts (the call-on's close); null when the timeline has no close for the call-on. */
  deadline: Date | null
}

/** What the teacher calls himself when the class's persona is no longer in the config (as the runtime does). */
const FALLBACK_TEACHER = '老师'

/** With less than this left before the deadline the model is not called: its answer could not come back in time. */
const MIN_CALL_MS = 1000

/**
 * With the second layer checking the teacher's lines, the time kept back from the model's call, on top of the second
 * layer's wait for its batch, for the second layer's own call to come back in the usual case: a line that passes it
 * after the deadline is dropped, and the model's work with it.
 */
export const CHECK_MARGIN_MS = 2000

const ANSWER_FORMAT =
  '只回复一个 JSON 对象，格式为 {"pick": <编号或 null>, "answer": "<回答>"}。' +
  'pick 写你要回答的那个问题的编号，answer 写你当众说的回答；' +
  '没有适合当众回答的问题时，pick 写 null，answer 写空字符串。不要写别的内容。'

/**
 * The teacher speaking as a machine, matched on a line as `normalize` leaves it: "I am" or "as" (one) an AI, a language
 * model or the like, and an AI assistant. A topic word alone (a lesson on language models, say) is not one.
 */
const SELF_REFERENCE = /(?:我是|我只是|作为)(?:一个|一名|一款)?(?:ai|人工智能|语言模型|大语言模型|大模型)|(?:ai|人工智能)助手/u

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
  const { db, config, clock, hub, llm, prompts, moderator, secondLayer, switches, speed } = deps
  const random = deps.random ?? Math.random
  const log = deps.log
  const answerPieces = promptPieces(prompts['teacher-answer'], ANSWER_FORMAT)
  const commentPieces = promptPieces(prompts['teacher-comment'])
  // Room for the longest answer allowed (a Chinese character may take two tokens) and the JSON around it.
  const answerTokens = 200 + 2 * config.chat.maxMessageChars
  // Room for the longest comment allowed, in plain text.
  const commentTokens = 100 + 2 * config.chat.maxMessageChars

  /** The time a line of the model's needs after its reply, before the deadline, for the checks it goes through. */
  const checkReserve = (): number =>
    config.secondLayer.implementation === 'llm' && switches.isOn('secondLayerTeacher')
      ? config.secondLayer.batchMillis + CHECK_MARGIN_MS
      : 0

  const running = new Set<Promise<void>>()
  /**
   * The work started, by session and segment (answering) or call-on (comment), until it can no longer write: the
   * runtime may start a segment again.
   */
  const started = new Map<string, number>()

  /** Forgets the work that can no longer write by `now`. */
  function forgetEnded(now: number): void {
    for (const [key, until] of started) if (until <= now) started.delete(key)
  }

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
    if (SELF_REFERENCE.test(said)) return 'self_reference'
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

  /** The teacher and segments 1 to `k` of the session's lesson; null when the lesson has no segment `k`. */
  async function contextOf(sessionId: number, k: number): Promise<Context | null> {
    const row = await db
      .selectFrom('classSessions as s')
      .innerJoin('classes as c', 'c.id', 's.classId')
      .leftJoin('lessons as l', 'l.id', 's.lessonId')
      .select(['s.members', 'c.teacherPersonaId', 'l.segments'])
      .where('s.id', '=', sessionId)
      .executeTakeFirstOrThrow()
    if (row.segments?.[k - 1] === undefined) return null
    const lessonSoFar = row.segments
      .slice(0, k)
      .map((s, i) => `第 ${i + 1} 段${i + 1 === k ? '（刚讲完）' : ''}：\n${s.text}`)
      .join('\n\n')
    return { ...teacherOf(row.teacherPersonaId), lessonSoFar, members: row.members }
  }

  /** The class's teacher by the persona's id, as the config describes them now. */
  function teacherOf(personaId: string): { teacherName: string; personality: string } {
    const persona = config.teacherPersonas.find((p) => p.id === personaId)
    return { teacherName: persona?.name ?? FALLBACK_TEACHER, personality: persona?.personality ?? '' }
  }

  /**
   * What the comment on the answer to `call` is on: a review question on the segments taught so far, an extension on
   * the segment after the call-on, which it leads into. The comment is due before that next segment starts.
   */
  async function commentContextOf(sessionId: number, call: Call): Promise<CommentContext> {
    const row = await db
      .selectFrom('classSessions as s')
      .innerJoin('classes as c', 'c.id', 's.classId')
      .leftJoin('lessons as l', 'l.id', 's.lessonId')
      .select(['s.startsAt', 's.classId', 'c.teacherPersonaId', 'l.segments', 'l.callOnQuestions'])
      .where('s.id', '=', sessionId)
      .executeTakeFirstOrThrow()
    const after = config.lesson.callOns[call.n - 1]?.afterSegment ?? 0
    const segments = row.segments ?? []
    const relevant = call.kind === 'review' ? segments.slice(0, after) : segments.slice(after, after + 1)
    const steps = lessonSteps(row.startsAt, 'lesson', config.lesson, speed, config.teacherAi.answerLeadSeconds)
    const close = steps.find((s) => s.step === `call-on-close-${call.n}`)?.at
    return {
      ...teacherOf(row.teacherPersonaId),
      question: row.callOnQuestions?.[call.kind] ?? null,
      segmentText: relevant.length === 0 ? null : relevant.map((s) => s.text).join('\n\n'),
      // The close of the call is the class's step, a little after the timetable like the others (see `classDelayMs`).
      deadline: close === undefined ? null : new Date(close.getTime() + classDelayMs(row.classId, config.lesson, speed)),
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
      lessonSoFar: ctx.lessonSoFar,
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
   * time for it before the deadline, the checks after it included (`checkReserve`).
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
      const left = window.deadline.getTime() - clock.now().getTime() - checkReserve()
      const timeoutMs = Math.min(left, config.llm.timeoutSeconds * 1000)
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

  /**
   * The model's comment on `answer`, the answer to `call`, when it passes `checkLine` (as the class hears it), else why
   * there is none. A comment that does not pass is not generated again: the template thanks is there instead. No call
   * is made without the time for it before the deadline, the checks after it included (`checkReserve`). The calls made
   * are counted in `tally`, should it throw.
   */
  async function modelComment(
    sessionId: number,
    call: Call,
    answer: string,
    ctx: CommentContext,
    deadline: Date,
    tally: { calls: number },
  ): Promise<{ comment: string } | { reason: TemplateReason }> {
    if (!switches.isOn('teacherLlm')) return { reason: 'switched_off' }
    if (ctx.question === null || ctx.segmentText === null) return { reason: 'no_lesson' }
    const left = deadline.getTime() - clock.now().getTime() - checkReserve()
    const timeoutMs = Math.min(left, config.teacherAi.commentTimeoutSeconds * 1000)
    if (timeoutMs < MIN_CALL_MS) return { reason: 'no_time' }
    const max = config.chat.maxMessageChars
    const prompt = fillPrompt(prompts['teacher-comment'], {
      teacherName: ctx.teacherName,
      teacherPersona: ctx.personality,
      callOnKind: call.kind === 'review' ? '复习题' : '引申题',
      question: ctx.question,
      // The student's words, on one line, unable to close the block they sit in.
      answer: neutralizeStudentText(answer, max),
      segmentText: ctx.segmentText,
      maxChars: String(max),
    })
    let comment: string
    tally.calls++
    try {
      const reply = await llm.call('comment', prompt, { json: false, timeoutMs, maxOutputTokens: commentTokens })
      comment = reply.text.trim()
    } catch (err) {
      if (err instanceof LlmUnavailable) return { reason: 'unavailable' }
      if (err instanceof LlmContentRefused) return { reason: 'refused' }
      throw err
    }
    const problem = await checkLine(sessionId, 'comment', comment, { pieces: commentPieces, aloud: comment })
    return problem === null ? { comment } : { reason: problem }
  }

  /**
   * The comment on the answer to call-on `n`: the model's when it passes, else the template thanks, written at once
   * unless it is too late for it (see `writeComment`). The template is said too when getting the model's fails in a way
   * nobody foresaw (a reply the client cannot read, a prompt file that does not fit the code): logged by the error's
   * name, it does not leave the answer without a reply until the next segment. Nothing is asked of the model once the
   * call has its comment or has closed.
   */
  async function commentOn(
    session: Pick<ActiveSession, 'sessionId' | 'classId'>,
    n: number,
    callId: number,
  ): Promise<{ outcome: CommentOutcome; calls: number; reason?: TemplateReason }> {
    const call = (await callsOf(db, session.sessionId)).find((c) => c.n === n && c.callId === callId)
    if (call === undefined || call.answer === null) return { outcome: 'no_answer', calls: 0 }
    if (call.comment !== null || call.timeUp) return { outcome: 'dropped', calls: 0 }
    const ctx = await commentContextOf(session.sessionId, call)
    if (ctx.deadline === null) return { outcome: 'dropped', calls: 0 }
    const tally = { calls: 0 }
    let said: { comment: string } | { reason: TemplateReason }
    try {
      said = await modelComment(session.sessionId, call, call.answer, ctx, ctx.deadline, tally)
    } catch (err) {
      const what = { sessionId: session.sessionId, classId: session.classId, n, callId }
      log?.error({ ...what, err: err instanceof Error ? err.name : 'unknown' }, 'teacher work failed')
      said = { reason: 'failed' }
    }
    const text = 'comment' in said ? said.comment : teacher.callOnThanks()
    const written = await writeComment({ db, clock, hub }, session, n, text, ctx.deadline)
    const outcome = !written ? 'dropped' : 'comment' in said ? 'commented' : 'template'
    return { outcome, calls: tally.calls, ...('reason' in said ? { reason: said.reason } : {}) }
  }

  return {
    startAnswering(session, k, window) {
      const now = clock.now().getTime()
      // Only the windows still open are remembered.
      forgetEnded(now)
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

    startComment(session, n, callId) {
      forgetEnded(clock.now().getTime())
      const key = `comment:${session.sessionId}:${n}`
      if (started.has(key)) return
      // A call-on's answer is taken once: remembered until the session closes, past any time to comment on it.
      started.set(key, session.closeAt.getTime())
      const what = { sessionId: session.sessionId, classId: session.classId, n, callId }
      track(what, async () => {
        const result = await commentOn(session, n, callId)
        log?.info({ ...what, ...result }, 'teacher comment')
      })
    },

    async idle() {
      while (running.size > 0) await Promise.all(running)
    },
  }
}
