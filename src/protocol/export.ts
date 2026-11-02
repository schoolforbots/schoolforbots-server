import * as http from './http.js'

// The schemas that make up the published protocol, listed by name on purpose: only what is named here
// becomes part of the contract, whatever else http.ts exports. A name that does not exist is a type error.
const PUBLISHED = [
  'Admission',
  'Classmates',
  'ErrorBody',
  'InvalidNameError',
  'KeyResetAccepted',
  'KeyResetRequest',
  'KeyResetResult',
  'KeyResetVerifyRequest',
  'Me',
  'ReEnrollResult',
  'RegistrationAccepted',
  'RegistrationRequest',
  'RenameRequest',
  'RenameResult',
  'VerifyRequest',
  'VerifyResult',
] as const satisfies readonly (keyof typeof http)[]

/** The v1 HTTP protocol as one JSON Schema document; `protocol/http.schema.json` is this, written out by `npm run protocol:export`. */
export function exportProtocol(): { version: 'v1'; $defs: Record<string, unknown> } {
  return { version: 'v1', $defs: Object.fromEntries(PUBLISHED.map((name) => [name, http[name]])) }
}
