import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

// During a deploy the old and the new version of the services share the database for a while, so a migration may only
// add things (see CONTRIBUTING.md). From 0011 on, the `up` of a migration must not rename, drop or alter anything.
const DIR = 'src/shared/migrations'
const FIRST_CHECKED = 11
const FORBIDDEN = ['renameColumn', 'renameTo', 'dropColumn', 'dropTable', 'alterColumn']

// A migration that really is the second release of a rename or drop (the new code stopped reading the old column in
// the release before) is listed here with the calls it may use and why. Empty today.
const ALLOWED: { file: string; calls: string[]; reason: string }[] = []

/** The source of `up`: everything before `down` is declared. */
function upSource(file: string): string {
  const source = readFileSync(join(DIR, file), 'utf8')
  const downAt = source.search(/export\s+(async\s+)?function\s+down\b/)
  return downAt === -1 ? source : source.slice(0, downAt)
}

const files = readdirSync(DIR)
  .filter((f) => /^\d{4}_.*\.ts$/.test(f))
  .filter((f) => Number(f.slice(0, 4)) >= FIRST_CHECKED)
  .sort()

describe('migrations only add', () => {
  test('there are migrations to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })
  test.each(files)('%s: up renames, drops and alters nothing', (file) => {
    const allowed = ALLOWED.find((a) => a.file === file)?.calls ?? []
    const used = FORBIDDEN.filter((call) => upSource(file).includes(call) && !allowed.includes(call))
    expect(used).toEqual([])
  })
  test('every allow-list entry names a real migration and gives a reason', () => {
    for (const a of ALLOWED) {
      expect(files).toContain(a.file)
      expect(a.reason.length).toBeGreaterThan(10)
    }
  })
})
