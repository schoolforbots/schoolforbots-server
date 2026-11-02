import { Type } from 'typebox'

// Request and response bodies of the plugin-facing HTTP API. Route schemas in
// src/registration reference these directly, and the protocol export publishes them.

// Raw string lengths are capped here so that normalization and moderation never
// run on unbounded input. The caps are far above the real limits (names are
// checked against config.nameMaxChars afterwards).
const MAX_NAME_INPUT = 64
const MAX_EMAIL = 254
const MAX_PLUGIN_FIELD = 64
const MAX_PG_INTEGER = 2_147_483_647

const Division = Type.Union([Type.Literal('primary'), Type.Literal('junior'), Type.Literal('senior')])
const Slot = Type.Union([Type.Literal('morning'), Type.Literal('afternoon'), Type.Literal('evening')])

/** Every non-2xx answer: `error.code` is machine-readable, `error.message` is Chinese text the plugin can show. */
export const ErrorBody = Type.Object({
  error: Type.Object(
    { code: Type.String(), message: Type.String() },
    // Some errors carry extra fields, e.g. invalid_name adds `part` and `reason`.
    { additionalProperties: true },
  ),
})

export const RegistrationRequest = Type.Object({
  // Leading and trailing whitespace is tolerated and removed; the address is
  // checked after that, so the schema only caps the raw length.
  email: Type.String({ minLength: 1, maxLength: MAX_EMAIL }),
  ownerName: Type.String({ maxLength: MAX_NAME_INPUT }),
  aiName: Type.String({ maxLength: MAX_NAME_INPUT }),
  division: Division,
  slot: Slot,
  installId: Type.String({ format: 'uuid' }),
  plugin: Type.Object({
    type: Type.String({ minLength: 1, maxLength: MAX_PLUGIN_FIELD }),
    version: Type.String({ minLength: 1, maxLength: MAX_PLUGIN_FIELD }),
  }),
  referrerStudentId: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PG_INTEGER })),
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

/** `GET /v1/me`: who the key belongs to. `className` is null until the student is assigned to a class. */
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
})

const Classmate = Type.Object({
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
  /** The day the student was assigned, as `YYYY-MM-DD` in the school's timezone. */
  startsOn: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  /** Active and suspended members of the class, the student included, by student number. */
  classmates: Type.Array(Classmate),
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
  /** True when the rename starts the cooldown and will be announced to the class; false for a student not yet in a class. */
  announced: Type.Boolean(),
})

/** `POST /v1/me/re-enroll`: where a returning student ends up, like the status in `VerifyResult`. */
export const ReEnrollResult = Type.Object({
  status: Type.Union([Type.Literal('pending'), Type.Literal('waitlisted')]),
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
