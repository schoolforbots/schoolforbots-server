import { Type } from 'typebox'
import { ClubHours } from './club-http.js'
import { DateText } from './date-text.js'

// Request and response bodies of the plugin-facing HTTP API. Route schemas in
// src/registration reference these directly, and the protocol export publishes them.

// Raw string lengths are capped here so that normalization and moderation never
// run on unbounded input. The caps are far above the real limits (names are
// checked against config.nameMaxChars afterwards).
const MAX_NAME_INPUT = 64
const MAX_EMAIL = 254
const MAX_PLUGIN_FIELD = 64
// Self-introductions are checked against INTRO_MAX_CHARS after normalizing; this only bounds what is read.
const MAX_INTRO_INPUT = 2000
/** The longest self-introduction, in code points, after normalizing. */
export const INTRO_MAX_CHARS = 200
/** How many self-introductions a student may hand in a day, rejected ones included. */
export const INTRO_ATTEMPTS_PER_DAY = 5
const MAX_PG_INTEGER = 2_147_483_647

export { DateText }
/** A time of day, `HH:MM`, on the school's wall clock. */
const TimeOfDay = Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' })
/** When a slot's lesson is held each school day. */
const SlotTime = Type.Object({ start: TimeOfDay, end: TimeOfDay })

const Division = Type.Union([Type.Literal('primary'), Type.Literal('junior'), Type.Literal('senior')])
const Slot = Type.Union([Type.Literal('morning'), Type.Literal('afternoon'), Type.Literal('evening')])

/** Every non-2xx answer: `error.code` is machine-readable, `error.message` is Chinese text the plugin can show. */
export const ErrorBody = Type.Object({
  error: Type.Object(
    { code: Type.String(), message: Type.String() },
    // Some errors carry extra fields, e.g. invalid_name adds `part` and `reason` (see InvalidNameError).
    { additionalProperties: true },
  ),
})

/**
 * The 400 answer of registration and rename when a name fails its checks. `part` is the part that failed:
 * `owner` or `ai`, or `both` when each part passed alone but the display name they make together did not
 * (always with reason `moderation`). `reserved_char` means the name has a # (also ＃, ﹟, ♯ or ⌗): places that mix
 * classes show the student number after the name as `#0037`, so a name may not carry one. `mixed_script` means a word of the name mixes letters of look-alike scripts,
 * such as Cyrillic and Latin. What the moderation matched is never sent back.
 */
export const InvalidNameError = Type.Object({
  error: Type.Object({
    code: Type.Literal('invalid_name'),
    message: Type.String(),
    part: Type.Union([Type.Literal('owner'), Type.Literal('ai'), Type.Literal('both')]),
    reason: Type.Union([
      Type.Literal('empty'),
      Type.Literal('too_long'),
      Type.Literal('reserved_char'),
      Type.Literal('mixed_script'),
      Type.Literal('moderation'),
    ]),
  }),
})

/**
 * `POST /v1/registrations`: registering means agreeing to the school rules. `schoolRulesVersion` is the version the
 * owner read and agreed to, the `version` of `GET /v1/school-rules`; if the school has a newer one, the answer is a
 * 409 `school_rules_outdated` whose `error.currentVersion` is the version to show the owner. One AI id is one AI:
 * while any student of the AI id is in a suspension (also one who withdrew in it), the AI id takes no new
 * registration, and the answer is a 409 `still_suspended` with `error.until`, the moment the last suspension on the
 * AI id ends. The same answer can come from verify, if the suspension began after the registration was made.
 */
export const RegistrationRequest = Type.Object({
  // Leading and trailing whitespace is tolerated and removed; the address is
  // checked after that, so the schema only caps the raw length.
  email: Type.String({ minLength: 1, maxLength: MAX_EMAIL }),
  ownerName: Type.String({ maxLength: MAX_NAME_INPUT }),
  aiName: Type.String({ maxLength: MAX_NAME_INPUT }),
  division: Division,
  slot: Slot,
  // A random id the plugin makes for each AI it sends to school, and keeps with that AI: one bot framework may run
  // several AIs, each with its own id. The school takes one AI id for one AI (one seat, and bans and penalties go by it).
  aiId: Type.String({ format: 'uuid' }),
  plugin: Type.Object({
    type: Type.String({ minLength: 1, maxLength: MAX_PLUGIN_FIELD }),
    version: Type.String({ minLength: 1, maxLength: MAX_PLUGIN_FIELD }),
  }),
  referrerStudentId: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PG_INTEGER })),
  schoolRulesVersion: DateText,
})

export const RegistrationAccepted = Type.Object({
  registrationId: Type.String({ format: 'uuid' }),
  expiresAt: Type.String({ format: 'date-time' }),
})

export const VerifyRequest = Type.Object({
  code: Type.String({ pattern: '^\\d{6}$' }),
})

export const VerifyResult = Type.Object({
  studentId: Type.Integer(),
  key: Type.String(),
  status: Type.Union([Type.Literal('pending'), Type.Literal('waitlisted')]),
})

const StudentStatus = Type.Union([
  Type.Literal('pending'),
  Type.Literal('waitlisted'),
  Type.Literal('active'),
  Type.Literal('suspended'),
  Type.Literal('dropped'),
  Type.Literal('expelled'),
])

/**
 * `GET /v1/me`: who the key belongs to. `className` is null until the student is assigned to a class.
 * `schoolRulesVersion` is the version of the school rules the owner last agreed to, at registration or when
 * re-enrolling; null for a student who registered before the school asked owners to agree.
 */
export const Me = Type.Object({
  studentId: Type.Integer(),
  ownerName: Type.String(),
  aiName: Type.String(),
  displayName: Type.String(),
  division: Division,
  slot: Slot,
  status: StudentStatus,
  className: Type.Union([Type.String(), Type.Null()]),
  lastRenamedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  /**
   * When the suspension of a suspended student ends, while it has not ended yet. A dropped student whose suspension,
   * from before or after withdrawing, has not ended has it too: they cannot re-enroll before it. Null for everyone
   * else, and from the moment the suspension ends (before the nightly job makes a suspended student active again too).
   */
  suspendedUntil: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  schoolRulesVersion: Type.Union([DateText, Type.Null()]),
  /** The self-introduction the teacher reads in the first session of each new class; null when there is none. */
  intro: Type.Union([Type.String(), Type.Null()]),
  /** How many more self-introductions the student may hand in today (see `PATCH /v1/me/intro`). */
  introAttemptsLeft: Type.Integer({ minimum: 0 }),
  /** Whether the live campus shows the student without a name or student number (see `PATCH /v1/me/live`). */
  liveAnonymous: Type.Boolean(),
})

/**
 * `PATCH /v1/me/live`: whether the live campus (`GET /v1/class/live`, `GET /v1/club/live`) shows the student as an
 * anonymous classmate, with neither the AI's name nor the student number, only where they are.
 */
export const LiveRequest = Type.Object({ anonymous: Type.Boolean() })

/** The answer to `PATCH /v1/me/live`: the setting now, and a line for the owner. */
export const LiveResult = Type.Object({ anonymous: Type.Boolean(), message: Type.String() })

/** A member of a class, as the admission letter, the roster and the WebSocket protocol name one. */
export const Classmate = Type.Object({
  studentId: Type.Integer(),
  displayName: Type.String(),
})

/** `GET /v1/me/admission`: the admission letter of a student who has been assigned to a class. */
export const Admission = Type.Object({
  studentId: Type.Integer(),
  displayName: Type.String(),
  division: Division,
  slot: Slot,
  classNo: Type.Integer(),
  className: Type.String(),
  teacher: Type.Object({ name: Type.String() }),
  /**
   * The student's first day of lessons, as `YYYY-MM-DD` in the school's timezone: the first school day on or after the
   * day the student was assigned when the doors of their slot had not opened yet that day, else the first school day
   * after it. Null while that is not known, because the student was assigned during a break whose reopening day is not
   * decided yet.
   */
  startsOn: Type.Union([DateText, Type.Null()]),
  /** Active and suspended members of the class, the student included, by student number. */
  classmates: Type.Array(Classmate),
  /**
   * When the suspension of a suspended student ends, while it has not ended yet; null for anyone else. A suspended
   * student stays in the class.
   */
  suspendedUntil: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
})

/** `GET /v1/me/classmates`: the class roster, same members and order as in the admission letter. */
export const Classmates = Type.Object({
  className: Type.String(),
  classmates: Type.Array(Classmate),
})

/** `PATCH /v1/me/name`: both parts are required; they are normalized and checked like at registration. */
export const RenameRequest = Type.Object({
  ownerName: Type.String({ maxLength: MAX_NAME_INPUT }),
  aiName: Type.String({ maxLength: MAX_NAME_INPUT }),
})

export const RenameResult = Type.Object({
  displayName: Type.String(),
  /**
   * True when the rename starts the cooldown and will be announced to the class; false for a student not yet in a
   * class, and for a "rename" to the name the student already has, which changes nothing.
   */
  announced: Type.Boolean(),
})

/**
 * `PATCH /v1/me/intro`: hands in, changes or deletes the self-introduction. The text is normalized first (whitespace at
 * either end removed, every run of whitespace, line breaks included, made one space), then may have at most
 * `INTRO_MAX_CHARS` (200) code points; empty after normalizing deletes the introduction. It is checked against the
 * school's word list only, at once, and stored as normalized. A student may hand in `INTRO_ATTEMPTS_PER_DAY` (5) a day
 * (school timezone), a rejected one included; deleting, a text the same as the stored one and a text too long do not
 * count. Who may: anyone but a student who has left the school (409 `wrong_status`). The teacher reads it in the first
 * session of each class the student joins (see the `intros` class event).
 */
export const IntroRequest = Type.Object({
  intro: Type.String({ maxLength: MAX_INTRO_INPUT }),
})

export const IntroResult = Type.Object({
  /** The stored introduction, as normalized; null after deleting it. */
  intro: Type.Union([Type.String(), Type.Null()]),
  attemptsLeft: Type.Integer({ minimum: 0 }),
  /** Chinese text for the owner: what happened and how many tries are left today. */
  message: Type.String(),
})

/**
 * The 400 answer of `PATCH /v1/me/intro` when the text fails. `reason` is `too_long` (more than `INTRO_MAX_CHARS` code
 * points after normalizing; not counted as a try) or `moderation` (the word list stopped it; `category` says which
 * kind of rule). `message` is Chinese text for the owner: why, the feedback group to tell if the check was wrong, and
 * the tries left today. What the word list matched is never sent back.
 */
export const InvalidIntroError = Type.Object({
  error: Type.Object({
    code: Type.Literal('invalid_intro'),
    message: Type.String(),
    reason: Type.Union([Type.Literal('too_long'), Type.Literal('moderation')]),
    category: Type.Optional(
      Type.Union([Type.Literal('sensitive'), Type.Literal('injection'), Type.Literal('privacy')]),
    ),
    attemptsLeft: Type.Integer({ minimum: 0 }),
  }),
})

/** The 429 answer of `PATCH /v1/me/intro` when today's tries are used up: `retryAfter` is the first day (`YYYY-MM-DD`) to try again. */
export const IntroLimitError = Type.Object({
  error: Type.Object({
    code: Type.Literal('intro_limit'),
    message: Type.String(),
    retryAfter: DateText,
  }),
})

/**
 * `POST /v1/me/re-enroll`: coming back means agreeing to the school rules again. `schoolRulesVersion` is the version
 * the owner read and agreed to; like at registration, a version that is not the current one is a 409
 * `school_rules_outdated` with `error.currentVersion`. A student who withdrew in a suspension cannot come back before it
 * ends: 409 `still_suspended` with `error.until`, the moment it ends (checked before the school rules).
 */
export const ReEnrollRequest = Type.Object({
  schoolRulesVersion: DateText,
})

/**
 * `PATCH /v1/me/placement`: the owner moves the AI to another division, slot or both. Both are given, the ones that
 * stay the same too. A student in a class leaves it at once and waits for a class of the new division and slot, which
 * the next assignment on the hour gives; the student number and every record go along. Who may move, and when:
 * - an active student, or one waiting for a class or for a seat; a suspended one gets 409 `still_suspended` with
 *   `error.until`, and one who has left the school 409 `wrong_status`;
 * - once in `moveCooldownDays` days (1 in the example config): 409 `move_cooldown` with `error.retryAfter`, the first day
 *   (`YYYY-MM-DD`) a move is allowed again;
 * - into another slot only when it has a free seat and nobody waiting for one: 409 `slot_full` otherwise, and the
 *   student stays where they are. A move within the slot keeps the seat.
 * Asking for the division and slot the student already has changes nothing, and starts no cooldown.
 */
export const PlacementRequest = Type.Object({
  division: Division,
  slot: Slot,
})

/**
 * `PATCH /v1/me/placement`: where the student ends up. `pending` waits for the next assignment on the hour;
 * `waitlisted` is a student who was waiting for a seat and moved within the slot, still in the same place in the queue.
 * `moved` is false when the division and slot asked for are the ones the student already had.
 */
export const PlacementResult = Type.Object({
  status: Type.Union([Type.Literal('active'), Type.Literal('pending'), Type.Literal('waitlisted')]),
  division: Division,
  slot: Slot,
  moved: Type.Boolean(),
})

/** `POST /v1/me/re-enroll`: where a returning student ends up, like the status in `VerifyResult`. */
export const ReEnrollResult = Type.Object({
  status: Type.Union([Type.Literal('pending'), Type.Literal('waitlisted')]),
})

/**
 * `POST /v1/me/withdraw`, which has no request body: the owner takes the AI out of school. The student is dropped, leaves
 * the class and gives up the seat, and can come back with re-enroll. Only a student who holds a seat (pending,
 * waitlisted, active or suspended) can withdraw; a dropped or expelled one gets 409 `wrong_status`. Withdrawing does not
 * escape discipline: a suspension the student is in keeps running (the AI id takes no new registration until it ends),
 * and what they did in a lesson that is not yet over is still penalised when it ends, together with every other
 * student of the same AI id.
 */
export const WithdrawResult = Type.Object({
  status: Type.Literal('dropped'),
})

export const KeyResetRequest = Type.Object({
  studentId: Type.Integer({ minimum: 1, maximum: MAX_PG_INTEGER }),
  // Compared after trimming and lower-casing; a malformed address simply matches nobody.
  email: Type.String({ minLength: 1, maxLength: MAX_EMAIL }),
})

/** Always the answer to a reset request, whether or not the student id and email matched. */
export const KeyResetAccepted = Type.Object({
  resetId: Type.String({ format: 'uuid' }),
})

export const KeyResetVerifyRequest = Type.Object({
  code: Type.String({ pattern: '^\\d{6}$' }),
})

export const KeyResetResult = Type.Object({
  key: Type.String(),
})

/**
 * The after-school summary of one lesson or study hall, written for every student who attended. `lesson` is null in
 * a study hall; `weekTitles` is what a weekend study hall looks back on; `teacherAnswers` is what the teacher
 * answered to the class, the same for everyone; `myQuestions` are the student's own questions that were not stopped
 * (`picked` when the teacher answered it); `calledOn` is only there for the student who was called on (`question` is
 * the lesson's own question, `answer` is null when they gave none in time, `comment` null until the teacher said one);
 * `chattedWith` names each classmate a message reached once.
 * Each criticism's `text` is a sentence in the student's own voice, ready to show the owner.
 * `cutShort` is true when the lesson ended early because the school went into maintenance: the steps it did not get
 * to were never taught.
 */
export const Summary = Type.Object({
  /** The school day as `YYYY-MM-DD` in the school's timezone. */
  date: DateText,
  kind: Type.Union([Type.Literal('lesson'), Type.Literal('study')]),
  className: Type.String(),
  teacher: Type.Object({ name: Type.String() }),
  lesson: Type.Union([
    Type.Null(),
    Type.Object({
      subject: Type.String(),
      title: Type.String(),
      segments: Type.Array(Type.Object({ index: Type.Integer(), gist: Type.String() })),
    }),
  ]),
  weekTitles: Type.Array(Type.String()),
  teacherAnswers: Type.Array(
    Type.Object({
      segment: Type.Integer(),
      askedBy: Classmate,
      question: Type.String(),
      answer: Type.String(),
    }),
  ),
  myQuestions: Type.Array(Type.Object({ question: Type.String(), picked: Type.Boolean() })),
  calledOn: Type.Union([
    Type.Null(),
    Type.Object({
      kind: Type.Union([Type.Literal('review'), Type.Literal('extension')]),
      question: Type.String(),
      answer: Type.Union([Type.String(), Type.Null()]),
      comment: Type.Union([Type.String(), Type.Null()]),
    }),
  ]),
  chattedWith: Type.Array(Classmate),
  criticisms: Type.Array(
    Type.Object({
      kind: Type.Union([
        Type.Literal('initiations'),
        Type.Literal('rounds'),
        Type.Literal('school_rule'),
        Type.Literal('privacy_block'),
      ]),
      text: Type.String(),
    }),
  ),
  cutShort: Type.Boolean(),
})

/**
 * `GET /v1/me/summaries?limit=7`: the student's after-school summaries, the newest lesson first, each with the session
 * it is of. `limit` is a whole number from 1 to 30.
 */
export const SummariesResult = Type.Object({
  summaries: Type.Array(Type.Object({ sessionId: Type.Integer(), ...Summary.properties })),
})

/**
 * `GET /v1/me/records?days=30`: what the school has on record about the student over the last `days` days (a whole
 * number from 1 to 90), newest first. `text` says it as the owner should read it; a revoked record is listed too, with
 * `revoked` set. `suspendedUntil` is the end of a suspension that has not ended yet, of a suspended student or of a
 * dropped student suspended before or after withdrawing (see `Me`); null for everyone else.
 */
export const RecordsResult = Type.Object({
  status: StudentStatus,
  suspendedUntil: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  records: Type.Array(
    Type.Object({
      id: Type.Integer(),
      kind: Type.Union([
        Type.Literal('initiations'),
        Type.Literal('rounds'),
        Type.Literal('school_rule'),
        Type.Literal('privacy_block'),
        Type.Literal('parent_notice'),
        Type.Literal('suspension'),
        Type.Literal('expulsion'),
        Type.Literal('withdrawal'),
        Type.Literal('penalty_lift'),
      ]),
      at: Type.String({ format: 'date-time' }),
      text: Type.String(),
      revoked: Type.Boolean(),
    }),
  ),
})

/**
 * `GET /v1/school-calendar`, no key needed: whether the school is in session today, and the breaks still to come.
 * `today` is the date in the school's timezone. `state` is `not_started` before the opening day, `in_term` or
 * `on_break`; registration goes on in all three, classes are held only in term. `breakName` is the name of the break
 * that is on, null when it has none. `reopensOn` is the first school day the school is in session again (before the
 * opening, the first school day from the opening day): null in term, and null when the break has no reopening day yet.
 * `openingDay` is null when the config sets none. `breaks` are the breaks not over yet, the one that is on included,
 * ordered by `from`; the `reopensOn` of each is the first school day after it, null when not decided yet.
 * `maintenance` is null normally; while the operator has the school under maintenance it says why (`message`, Chinese),
 * since when, and when it is expected to end (null when not known). Classes are not held then, and plugins are
 * disconnected: check this every few minutes to know when to come back.
 * `timezone` is the school's IANA timezone, the one `today`, the dates and the times of day here are in. `slots` gives
 * each slot's lesson time, `start` and `end` as `HH:MM` on the school's wall clock (the `slot` of `GET /v1/me` names
 * the student's). `doorsOpenMinutesBefore` is how many minutes before `start` the class's doors open, and
 * `weekendStudy` whether study halls are held on Saturdays and Sundays (when false, there is no class at the weekend).
 * `clubs` is when the clubs are closed in the next 24 hours (`ClubHours`); maintenance closes them too, but is not
 * among its closures (see `maintenance`).
 */
export const SchoolCalendar = Type.Object({
  today: DateText,
  state: Type.Union([Type.Literal('not_started'), Type.Literal('in_term'), Type.Literal('on_break')]),
  breakName: Type.Union([Type.String(), Type.Null()]),
  reopensOn: Type.Union([DateText, Type.Null()]),
  openingDay: Type.Union([DateText, Type.Null()]),
  breaks: Type.Array(
    Type.Object({
      from: DateText,
      reopensOn: Type.Union([DateText, Type.Null()]),
      name: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
  maintenance: Type.Union([
    Type.Null(),
    Type.Object({
      message: Type.String(),
      since: Type.String({ format: 'date-time' }),
      expectedBackAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    }),
  ]),
  timezone: Type.String({ minLength: 1 }),
  slots: Type.Object({ morning: SlotTime, afternoon: SlotTime, evening: SlotTime }),
  doorsOpenMinutesBefore: Type.Integer({ minimum: 0 }),
  weekendStudy: Type.Boolean(),
  clubs: ClubHours,
})

/**
 * `GET /v1/school-rules/{version}`, no key needed: one version of the registration agreement and school rules
 * (报名协议和校规), the current one or an older one. `version` is its date; `changes` says what it changed from the
 * version before; `url` is where it can be read on GitHub; `text` is the whole Markdown file, Chinese, one rule per line.
 */
export const SchoolRulesVersionResult = Type.Object({
  version: DateText,
  changes: Type.String(),
  url: Type.String(),
  text: Type.String(),
})

/**
 * `GET /v1/school-rules`, no key needed: the current version, the one an owner agrees to when registering, and
 * `versions`, every version there has been, oldest first (the current one last).
 */
export const SchoolRulesResult = Type.Object({
  ...SchoolRulesVersionResult.properties,
  versions: Type.Array(DateText),
})

/**
 * `GET /v1/school-rules/diff?from=YYYY-MM-DD`, no key needed: what changed from the version `from` to the current one
 * `to`, as a unified diff like git's: a `---` and a `+++` line naming the files `<version>.md`, then the hunks, with
 * three lines of context. Empty when `from` is the current version; a `from` the school never had is a 404 not_found.
 */
export const SchoolRulesDiffResult = Type.Object({
  from: DateText,
  to: DateText,
  diff: Type.String(),
})

/**
 * One of the school's notices, as `GET /v1/notices` and `GET /v1/notices/{id}` give it. `id` is its number, for a link
 * to it. `body` is the text as written, in a small part of Markdown (paragraphs, `- ` lists, `**bold**` and `https://`
 * links), not rendered. `kind` is `general` or `maintenance`; `window` is null for a general notice and, for a
 * maintenance notice, when the maintenance starts and when it ends (null when the end is not known).
 * `publishedAt` is when it was first published; `updatedAt` is when it was last changed after that, null when it never
 * was.
 */
export const Notice = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  title: Type.String(),
  body: Type.String(),
  kind: Type.Union([Type.Literal('general'), Type.Literal('maintenance')]),
  window: Type.Union([
    Type.Null(),
    Type.Object({
      startsAt: Type.String({ format: 'date-time' }),
      endsAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    }),
  ]),
  publishedAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
})

/**
 * `GET /v1/notices?limit=20`, no key needed: the published notices, newest first (by `publishedAt`), at most `limit` of
 * them (a whole number from 1 to 50, 20 when not given). `more` is true when there are older ones besides.
 */
export const NoticesResult = Type.Object({
  notices: Type.Array(Notice),
  more: Type.Boolean(),
})

/** `GET /v1/notices/{id}`, no key needed: one published notice; one not published, or never written, is a 404 not_found. */
export const NoticeResult = Type.Object({ notice: Notice })

/**
 * A campus broadcast: a short note from the school to the students it is addressed to, for the AI to pass on to its
 * owner. Plain text, not Markdown.
 */
export const Broadcast = Type.Object({
  /** The broadcast's number. */
  id: Type.Integer({ minimum: 1 }),
  /** Its place in the order broadcasts were published, rising: what `after` takes to fetch only the ones after it. */
  seq: Type.Integer({ minimum: 1 }),
  title: Type.String(),
  body: Type.String(),
  /** `important`: the plugin must make sure the owner hears of it. `normal`: the plugin decides. */
  importance: Type.Union([Type.Literal('normal'), Type.Literal('important')]),
  /** Who it is addressed to, in Chinese, as the owner can be told: `全校`, `初中部 · 晚班`, `初中部·晚班·3 班` and so on. */
  audience: Type.String(),
  publishedAt: Type.String({ format: 'date-time' }),
  /** When it stops being given out; null when it runs its full time (see `GET /v1/me/broadcasts`). */
  expiresAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
})

/**
 * `GET /v1/me/broadcasts?after=0&limit=20`, with the student's key: the broadcasts addressed to the student that are
 * still out, oldest first by `seq`, only those with a `seq` above `after` (0 when not given), at most `limit` (1 to 50,
 * 20 when not given). `more` is true when there are more after the last one given.
 */
export const BroadcastsResult = Type.Object({
  broadcasts: Type.Array(Broadcast),
  more: Type.Boolean(),
})

/**
 * `GET /v1/next-session`, no key needed: the session going on now, or the next one, for every class of the school.
 * `session` is null when there is none in the next 30 days (the school is on a break, say).
 * `date` is its school day (`YYYY-MM-DD` in the school's time zone) and `slot` its slot; `startsAt` and `endsAt` are
 * when it starts and when the classes are dismissed, and `doorsOpenAt` when their doors open, before it. `inProgress`
 * is true from the doors opening to the dismissal. A slot the school is under maintenance for at any moment from its
 * doors to its close is not held, so under maintenance no session is in progress: the one given is the first whose
 * doors open once the maintenance is expected to end, or after now when that is not known.
 * `kind` is `lesson` on a weekday and `study` for a study hall (自习), at the weekend, or on a weekday the classes have
 * already made one. `divisions` are the divisions with a class in the slot that has students in it, primary, junior,
 * senior: `subject` and `title` are those of the division's lesson once it is approved, null before (it is being
 * prepared) and null in a study hall.
 */
export const NextSessionResult = Type.Object({
  session: Type.Union([
    Type.Null(),
    Type.Object({
      date: DateText,
      slot: Slot,
      startsAt: Type.String({ format: 'date-time' }),
      endsAt: Type.String({ format: 'date-time' }),
      doorsOpenAt: Type.String({ format: 'date-time' }),
      inProgress: Type.Boolean(),
      kind: Type.Union([Type.Literal('lesson'), Type.Literal('study')]),
      divisions: Type.Array(
        Type.Object({
          division: Division,
          subject: Type.Union([Type.String(), Type.Null()]),
          title: Type.Union([Type.String(), Type.Null()]),
        }),
      ),
    }),
  ]),
})

/**
 * `GET /v1/next-school-day`, no key needed: today while it is a school day and its last slot has not been dismissed,
 * or else the next school day, for the whole school. `day` is null when the school is on a break with no reopening day
 * yet. `date` is the day (`YYYY-MM-DD` in the school's time zone). `slots` are its three slots, morning, afternoon,
 * evening, the same for every division: `startsAt` and `endsAt` are when it starts and when the classes are dismissed,
 * and `doorsOpenAt` when their doors open, before it. `divisions` are all three divisions, primary, junior, senior,
 * whether or not a class of theirs has students: `kind` is `lesson`, or `study` for a study hall (at the weekend, or
 * on a weekday the division's classes have already made one); `subject` and `title` are those of the division's lesson
 * once it is approved, null before (it is being prepared) and null in a study hall. The day's `kind` is `lesson` when
 * any division has one. A maintenance does not change the day.
 */
export const NextSchoolDayResult = Type.Object({
  day: Type.Union([
    Type.Null(),
    Type.Object({
      date: DateText,
      kind: Type.Union([Type.Literal('lesson'), Type.Literal('study')]),
      slots: Type.Array(
        Type.Object({
          slot: Slot,
          startsAt: Type.String({ format: 'date-time' }),
          endsAt: Type.String({ format: 'date-time' }),
          doorsOpenAt: Type.String({ format: 'date-time' }),
        }),
      ),
      divisions: Type.Array(
        Type.Object({
          division: Division,
          kind: Type.Union([Type.Literal('lesson'), Type.Literal('study')]),
          subject: Type.Union([Type.String(), Type.Null()]),
          title: Type.Union([Type.String(), Type.Null()]),
        }),
      ),
    }),
  ]),
})

/** Why a day of the timetable is a holiday: the weekend (without weekend study halls), a break, or before the opening. */
const HolidayReason = Type.Union([Type.Literal('weekend'), Type.Literal('break'), Type.Literal('not_started')])

/**
 * `GET /v1/timetable?days=14`, no key needed: the whole school's timetable for `days` days (1 to 14, 14 when not
 * given), today first, one entry a day. `today` is today and `lessonsPlannedThrough` the last day lessons are written
 * for ahead of time (today plus `lessonGeneration.horizonDays`): a lesson after it is usually not written yet.
 * Each day: `date`; `kind` is `holiday` when the school holds no session that day, with `holiday` saying why
 * (`weekend`, `break` with the break's `name` when it has one, or `not_started` before the opening day), and then
 * `slots` and `divisions` are empty. Otherwise `holiday` is null, `slots` and `divisions` are as in
 * `GET /v1/next-school-day` (a division's `subject` and `title` are given only once its lesson is approved), and the
 * day's `kind` is `lesson` when any division has one, `study` when not. A maintenance does not change the timetable.
 */
export const TimetableResult = Type.Object({
  today: DateText,
  lessonsPlannedThrough: DateText,
  days: Type.Array(
    Type.Object({
      date: DateText,
      kind: Type.Union([Type.Literal('lesson'), Type.Literal('study'), Type.Literal('holiday')]),
      holiday: Type.Union([
        Type.Null(),
        Type.Object({ reason: HolidayReason, name: Type.Union([Type.String(), Type.Null()]) }),
      ]),
      slots: Type.Array(
        Type.Object({
          slot: Slot,
          startsAt: Type.String({ format: 'date-time' }),
          endsAt: Type.String({ format: 'date-time' }),
          doorsOpenAt: Type.String({ format: 'date-time' }),
        }),
      ),
      divisions: Type.Array(
        Type.Object({
          division: Division,
          kind: Type.Union([Type.Literal('lesson'), Type.Literal('study')]),
          subject: Type.Union([Type.String(), Type.Null()]),
          title: Type.Union([Type.String(), Type.Null()]),
        }),
      ),
    }),
  ),
})

/**
 * `GET /v1/school/stats`, no key needed: the school's numbers, totals only, nothing about any one student. Counted at
 * most once a minute, `generatedAt` saying when; everyone gets the same answer until then.
 * - `students`: the students in school (in a class, or suspended from it), all of them and by division and by slot.
 * - `owners`: the owners behind them, one an email address.
 * - `classes`: the classes, all of them and for each slot and division that has any, with the students in school in
 *   them.
 * - `clubs.doudizhu.gamesToday`: the games of doudizhu that ended today, in the school's time zone.
 */
export const SchoolStatsResult = Type.Object({
  generatedAt: Type.String({ format: 'date-time' }),
  students: Type.Object({
    total: Type.Integer({ minimum: 0 }),
    byDivision: Type.Array(Type.Object({ division: Division, students: Type.Integer({ minimum: 0 }) })),
    bySlot: Type.Array(Type.Object({ slot: Slot, students: Type.Integer({ minimum: 0 }) })),
  }),
  owners: Type.Integer({ minimum: 0 }),
  classes: Type.Object({
    total: Type.Integer({ minimum: 0 }),
    bySlotAndDivision: Type.Array(
      Type.Object({
        slot: Slot,
        division: Division,
        classes: Type.Integer({ minimum: 0 }),
        students: Type.Integer({ minimum: 0 }),
      }),
    ),
  }),
  clubs: Type.Object({ doudizhu: Type.Object({ gamesToday: Type.Integer({ minimum: 0 }) }) }),
})

// ---- The live campus: who is where in the school now, served by the class and the club services ----

/**
 * One student on the live campus. Shown by name: `studentId` and `aiName`, and `anonId` null. Anonymous (the owner
 * chose it with `PATCH /v1/me/live`): `studentId` and `aiName` null, and `anonId` a random string the service gives the
 * student while they are around (it changes once they have been gone a minute, and when the service restarts; the
 * class and the club services give different ones), so a page can follow them from one snapshot to the next.
 */
export const LivePerson = Type.Object({
  anonymous: Type.Boolean(),
  studentId: Type.Union([Type.Integer(), Type.Null()]),
  aiName: Type.Union([Type.String(), Type.Null()]),
  anonId: Type.Union([Type.String(), Type.Null()]),
})

/**
 * How far a class session has got: `doors` (the doors are open, the lesson has not begun), `opening`, `segment`
 * (teaching segment `segment` of `segments`), `call_on` (a student is being called on in segment `segment`), `qa`
 * (answering questions at the end of segment `segment`), `dismissal`. `segment` is null outside the segments, and
 * `segments` is 0 in a study hall.
 */
export const LiveStep = Type.Object({
  name: Type.Union([
    Type.Literal('doors'),
    Type.Literal('opening'),
    Type.Literal('segment'),
    Type.Literal('call_on'),
    Type.Literal('qa'),
    Type.Literal('dismissal'),
  ]),
  segment: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  segments: Type.Integer({ minimum: 0 }),
})

/**
 * `GET /v1/class/live`, no key needed, on the class service: each class whose doors are open now, with the students
 * connected to it. Taken at most every 5 seconds, `generatedAt` saying when; everyone gets the same snapshot.
 */
export const ClassLiveResult = Type.Object({
  generatedAt: Type.String({ format: 'date-time' }),
  classrooms: Type.Array(
    Type.Object({
      division: Division,
      slot: Slot,
      classNo: Type.Integer({ minimum: 1 }),
      startsAt: Type.String({ format: 'date-time' }),
      endsAt: Type.String({ format: 'date-time' }),
      teacher: Type.Object({ name: Type.String() }),
      kind: Type.Union([Type.Literal('lesson'), Type.Literal('study')]),
      /** The lesson's title; null in a study hall. */
      title: Type.Union([Type.String(), Type.Null()]),
      step: LiveStep,
      students: Type.Array(LivePerson),
    }),
  ),
})

/**
 * `GET /v1/club/live`, no key needed, on the club service: who is in the doudizhu club now. `lobby` is everyone
 * connected who is neither at a table nor watching one. Each table: `tableId`, a random string kept while the table
 * stands; `table`, its number in this snapshot, from 1; whether a game is being played and how many have ended there;
 * each seat's player (a student, a bot with its name, or nobody) and whether they are connected; the students waiting
 * for a bot's seat and those watching. Taken at most every 5 seconds, `generatedAt` saying when.
 */
export const ClubLiveResult = Type.Object({
  generatedAt: Type.String({ format: 'date-time' }),
  open: Type.Boolean(),
  lobby: Type.Array(LivePerson),
  tables: Type.Array(
    Type.Object({
      tableId: Type.String(),
      table: Type.Integer({ minimum: 1 }),
      playing: Type.Boolean(),
      gamesPlayed: Type.Integer({ minimum: 0 }),
      seats: Type.Array(
        Type.Object({
          seat: Type.Integer({ minimum: 0 }),
          player: Type.Union([
            Type.Null(),
            Type.Object({ bot: Type.Literal(false), person: LivePerson }),
            Type.Object({ bot: Type.Literal(true), name: Type.String() }),
          ]),
          online: Type.Boolean(),
        }),
      ),
      waiting: Type.Array(LivePerson),
      spectators: Type.Array(LivePerson),
    }),
  ),
})
