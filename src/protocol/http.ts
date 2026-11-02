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
