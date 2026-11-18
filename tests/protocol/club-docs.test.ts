import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { TSchema } from 'typebox'
import Value from 'typebox/value'
import { describe, expect, test } from 'vitest'
import { ClubClientMessage, ClubServerMessage } from '../../src/protocol/club.js'

// The club section of the plugin API reference walks through a game frame by frame. Every frame is a ```json block
// after a line that says which way it goes, and this test checks each one against the protocol, so the example cannot
// drift from the code. Both documents carry the same frames; only the prose around them differs.

const fromRoot = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url))

interface Doc {
  file: string
  /** The `##` heading of the club section. */
  section: string
  /** The line before a frame the client sends, and before one the server sends. */
  client: string
  server: string
}

const DOCS: Doc[] = [
  { file: 'docs/api.md', section: '社团的 WebSocket', client: '客户端 →', server: '← 服务器' },
  { file: 'docs/api.en.md', section: 'Club WebSocket', client: 'Client →', server: '← Server' },
]

interface Frame {
  from: 'client' | 'server'
  /** The line of the opening fence, from 1, for the failure messages. */
  line: number
  json: string
}

/** The ```json blocks of the club section, with the direction named on the line before each. */
function frames(doc: Doc): Frame[] {
  const lines = readFileSync(fromRoot(doc.file), 'utf8').split('\n')
  const start = lines.findIndex((line) => line.trim() === `## ${doc.section}`)
  expect(start, `${doc.file} has no "## ${doc.section}" section`).toBeGreaterThanOrEqual(0)
  const result: Frame[] = []
  let previous = ''
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith('## ')) break
    if (line.trim() === '```json') {
      const end = lines.findIndex((candidate, j) => j > i && candidate.trim() === '```')
      expect(end, `${doc.file}:${i + 1} has no closing fence`).toBeGreaterThan(i)
      const from = previous === doc.client ? 'client' : previous === doc.server ? 'server' : undefined
      expect(from, `${doc.file}:${i + 1} is not after "${doc.client}" or "${doc.server}"`).toBeDefined()
      result.push({ from: from!, line: i + 1, json: lines.slice(i + 1, end).join('\n') })
      i = end
      previous = ''
      continue
    }
    if (line.trim() !== '') previous = line.trim()
  }
  return result
}

const schemaOf = (frame: Frame): TSchema => (frame.from === 'client' ? ClubClientMessage : ClubServerMessage)

describe('the example game in the club section', () => {
  test('has at least 10 frames in each document', () => {
    for (const doc of DOCS) expect(frames(doc).length, doc.file).toBeGreaterThanOrEqual(10)
  })

  test('every frame is a message of the protocol, in the direction it is shown going', () => {
    for (const doc of DOCS) {
      for (const frame of frames(doc)) {
        const where = `${doc.file}:${frame.line}`
        let value: unknown
        expect(() => (value = JSON.parse(frame.json)), where).not.toThrow()
        const errors = [...Value.Errors(schemaOf(frame), value)].map((error) => `${error.instancePath} ${error.message}`)
        expect(Value.Check(schemaOf(frame), value), `${where}: ${errors.slice(0, 5).join('; ')}`).toBe(true)
      }
    }
  })

  test('both documents show the same frames', () => {
    const [zh, en] = DOCS.map((doc) => frames(doc).map(({ from, json }) => ({ from, json })))
    expect(en).toEqual(zh)
  })
})
