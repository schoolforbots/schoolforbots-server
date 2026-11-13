import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { buildRegistrationApp } from '../../src/registration/app.js'
import { MemoryMailer } from '../../src/registration/mailer.js'
import { ADMIN_ERROR_CODES, ERROR_MESSAGES } from '../../src/registration/errors.js'
import { WS_ERROR_MESSAGES } from '../../src/class/ws-errors.js'
import { ClosingMessage } from '../../src/protocol/ws.js'
import { loadSchoolRules } from '../../src/shared/school-rules.js'
import { createTestClock } from '../helpers/clock.js'
import { createTestDb } from '../helpers/db.js'
import { exampleConfig, exampleModerator } from '../helpers/app.js'

// The plugin API reference is written twice, by hand, and this test keeps both copies in step with the code: every
// route, every error code and every closing reason is in both documents, and the documents name nothing else.

const fromRoot = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url))

interface Doc {
  file: string
  /** The `##` headings of the three tables. */
  tables: { http: string; classroom: string; closing: string }
}

const DOCS: Doc[] = [
  { file: 'docs/api.md', tables: { http: 'HTTP 错误码', classroom: '上课时的错误码', closing: '断开原因' } },
  { file: 'docs/api.en.md', tables: { http: 'HTTP error codes', classroom: 'Classroom error codes', closing: 'Closing reasons' } },
]

const text = (doc: Doc) => readFileSync(fromRoot(doc.file), 'utf8')

/** `METHOD /v1/path/{param}` of every `` ### `METHOD /v1/...` `` heading. */
function documentedRoutes(doc: Doc): string[] {
  return [...text(doc).matchAll(/^### `([A-Z]+) (\/v1\S*)`\s*$/gm)].map((m) => `${m[1]} ${m[2]}`)
}

/** The codes in the first column of the table under the `##` heading `title`. */
function tableCodes(doc: Doc, title: string): string[] {
  const lines = text(doc).split('\n')
  const start = lines.findIndex((line) => line.trim() === `## ${title}`)
  expect(start, `${doc.file} has no "## ${title}" section`).toBeGreaterThanOrEqual(0)
  const codes: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break
    const code = /^\| `([^`]+)` \|/.exec(line)?.[1]
    if (code !== undefined) codes.push(code)
  }
  return codes
}

const sorted = (values: Iterable<string>) => [...new Set(values)].sort()

/** The `/v1` routes of the registration service, without the admin pages, as `METHOD /v1/path/{param}`. */
let routes: string[] = []
let destroy: () => Promise<void>

beforeAll(async () => {
  const { db, destroy: destroyDb } = await createTestDb()
  const app = buildRegistrationApp({
    db,
    config: exampleConfig(),
    moderator: exampleModerator(),
    mailer: new MemoryMailer(),
    clock: createTestClock(new Date('2026-11-02T12:00:00+08:00')),
    maintenance: { current: () => null, refresh: async () => {}, onChange: () => {}, stop: () => {} },
    schoolRules: loadSchoolRules(fromRoot('school-rules')),
    trustProxy: false,
  })
  // Routes are registered when the app loads, after buildRegistrationApp has returned, so the hook sees all of them.
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/v1')) return
    for (const method of [route.method].flat()) {
      if (method === 'HEAD') continue
      routes.push(`${method} ${route.url.replace(/:(\w+)/g, '{$1}')}`)
    }
  })
  await app.ready()
  destroy = async () => {
    await app.close()
    await destroyDb()
  }
})

afterAll(async () => {
  await destroy?.()
})

const adminCodes: readonly string[] = ADMIN_ERROR_CODES

/** Every code a plugin can get over HTTP: all of `ErrorCode` but the admin ones, and the 500 that has no `ErrorCode`. */
const httpCodes = () => [...Object.keys(ERROR_MESSAGES).filter((code) => !adminCodes.includes(code)), 'internal_error']
const closingReasons = () => (ClosingMessage.properties.reason.anyOf as { const: string }[]).map((literal) => literal.const)

describe('the plugin API reference', () => {
  test('every /v1 route is in both documents, and no other', () => {
    expect(routes.length).toBeGreaterThan(0)
    for (const doc of DOCS) {
      expect(sorted(documentedRoutes(doc)), doc.file).toEqual(sorted(routes))
      // One heading per route.
      expect(documentedRoutes(doc).length, doc.file).toBe(new Set(documentedRoutes(doc)).size)
    }
  })

  test('every error code a plugin can get is in both tables', () => {
    for (const doc of DOCS) {
      expect(sorted(tableCodes(doc, doc.tables.http)), doc.file).toEqual(sorted(httpCodes()))
      expect(sorted(tableCodes(doc, doc.tables.classroom)), doc.file).toEqual(sorted(Object.keys(WS_ERROR_MESSAGES)))
      expect(sorted(tableCodes(doc, doc.tables.closing)), doc.file).toEqual(sorted(closingReasons()))
    }
  })

  test('the tables name no code that does not exist', () => {
    for (const doc of DOCS) {
      const unknown = (listed: string[], real: string[]) => listed.filter((code) => !real.includes(code))
      expect(unknown(tableCodes(doc, doc.tables.http), httpCodes()), doc.file).toEqual([])
      expect(unknown(tableCodes(doc, doc.tables.classroom), Object.keys(WS_ERROR_MESSAGES)), doc.file).toEqual([])
      expect(unknown(tableCodes(doc, doc.tables.closing), closingReasons()), doc.file).toEqual([])
    }
  })

  test('the documents name no admin route and no admin error', () => {
    for (const doc of DOCS) {
      const content = text(doc)
      expect(content, doc.file).not.toContain('/api/')
      for (const code of ADMIN_ERROR_CODES) expect(content, `${doc.file} names ${code}`).not.toMatch(new RegExp(`\\b${code}\\b`))
    }
  })
})
