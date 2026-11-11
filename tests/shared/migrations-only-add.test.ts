import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

/** The source with its `//` and `/* *\/` comments taken out, so a word in a comment never counts. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

// What `up` may not do. The raw SQL forms are matched case-insensitively with any whitespace (newlines too) between
// the words, and as whole words, so an identifier such as `renamedAt` is not one.
const SQL_FORMS: [label: string, pattern: RegExp][] = [
  ['drop table', /\bdrop\s+table\b/i],
  ['drop column', /\bdrop\s+column\b/i],
  ['rename', /\brename\b/i],
  ['alter column', /\balter\s+column\b/i],
]
const KYSELY_CALLS = ['renameColumn', 'renameTo', 'dropColumn', 'dropTable', 'alterColumn', 'modifyColumn']

/**
 * Where the text that starts at `from` ends: at the first `)` outside the brackets opened in it, or, when `ends` is
 * given, at the first of those characters outside brackets; else at the end.
 */
function endOfPart(code: string, from: number, ends = ''): number {
  let depth = 0
  for (let i = from; i < code.length; i++) {
    const ch = code[i]!
    if (ch === '(') depth++
    else if (ch === ')') {
      if (depth === 0) return i
      depth--
    } else if (depth === 0 && ends.includes(ch)) return i
  }
  return code.length
}

/** The arguments of the call whose `(` is at `open`, up to its matching `)`. */
function argumentsAt(code: string, open: number): string {
  return code.slice(open + 1, endOfPart(code, open + 1))
}

// A NOT NULL column with no default, added to a table that already exists: the old version, which does not know the
// column, cannot insert a row any more.
const NOT_NULL_KYSELY = 'addColumn notNull without defaultTo'
const NOT_NULL_SQL = 'add column not null without default'

/** Whether a chain on `alterTable` (up to its `.execute(`) has an `addColumn` with `.notNull()` and no `.defaultTo(`. */
function addsNotNullWithKysely(code: string): boolean {
  for (const chain of code.matchAll(/\balterTable\s*\(/g)) {
    const end = code.indexOf('.execute(', chain.index)
    const statement = code.slice(chain.index, end === -1 ? undefined : end)
    for (const add of statement.matchAll(/\.addColumn\s*\(/g)) {
      const args = argumentsAt(statement, add.index + add[0].length - 1)
      if (/\.notNull\s*\(/.test(args) && !/\.defaultTo\s*\(/.test(args)) return true
    }
  }
  return false
}

/** Whether raw SQL has an `add column` clause (up to its comma) that says `not null` and has no `default`. */
function addsNotNullWithSql(code: string): boolean {
  for (const add of code.matchAll(/\badd\s+column\b/gi)) {
    const clause = code.slice(add.index, endOfPart(code, add.index + add[0].length, ',;`'))
    if (/\bnot\s+null\b/i.test(clause) && !/\bdefault\b/i.test(clause)) return true
  }
  return false
}

/** The forbidden things the source of an `up` does: Kysely method names and raw SQL forms, each once, in the order found. */
export function forbiddenInUp(source: string): string[] {
  const code = withoutComments(source)
  const found = KYSELY_CALLS.filter((call) => new RegExp(`\\b${call}\\b`).test(code))
  for (const [label, pattern] of SQL_FORMS) if (pattern.test(code)) found.push(label)
  if (addsNotNullWithKysely(code)) found.push(NOT_NULL_KYSELY)
  if (addsNotNullWithSql(code)) found.push(NOT_NULL_SQL)
  return found
}

// During a deploy the old and the new version of the services share the database for a while, so a migration may only
// add things (see CONTRIBUTING.md). From 0011 on, the `up` of a migration must not rename, drop or alter anything, nor
// add a NOT NULL column without a default to a table that exists.
const DIR = 'src/shared/migrations'
const FIRST_CHECKED = 11

// A migration that really is the second release of a rename or drop (the new code stopped reading the old column in
// the release before) is listed here with what it may use (the names `forbiddenInUp` gives) and why. Empty today.
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

describe('forbiddenInUp', () => {
  const cases: [string, string, string][] = [
    ['drop column', "await sql`alter table x drop column y`.execute(db)", 'drop column'],
    ['rename column', "await sql`ALTER TABLE x RENAME COLUMN a TO b`.execute(db)", 'rename'],
    ['rename index', "await sql`alter index a\n  rename\n  to b`.execute(db)", 'rename'],
    ['alter column type', "await sql`alter table x alter column y type text`.execute(db)", 'alter column'],
    ['set not null', "await sql`alter table x\n alter   column y set not null`.execute(db)", 'alter column'],
    ['drop table', "await sql`Drop\nTable x`.execute(db)", 'drop table'],
    ['renameColumn', "await db.schema.alterTable('x').renameColumn('a', 'b').execute()", 'renameColumn'],
    ['renameTo', "await db.schema.alterTable('x').renameTo('y').execute()", 'renameTo'],
    ['dropColumn', "await db.schema.alterTable('x').dropColumn('a').execute()", 'dropColumn'],
    ['dropTable', "await db.schema.dropTable('x').execute()", 'dropTable'],
    ['alterColumn', "await db.schema.alterTable('x').alterColumn('a', (c) => c.setNotNull()).execute()", 'alterColumn'],
    ['modifyColumn', "await db.schema.alterTable('x').modifyColumn('a', 'text').execute()", 'modifyColumn'],
    [
      'addColumn notNull without defaultTo',
      "await db.schema.alterTable('x').addColumn('a', 'integer', (c) => c.notNull()).execute()",
      'addColumn notNull without defaultTo',
    ],
    [
      'the second addColumn of a chain',
      "await db.schema\n  .alterTable('x')\n  .addColumn('a', 'text')\n  .addColumn('b', sql`numeric(10, 2)`, (c) =>\n    c.notNull().check(sql`b >= 0`))\n  .execute()",
      'addColumn notNull without defaultTo',
    ],
    ['add column not null', "await sql`alter table x add column y integer not null`.execute(db)", 'add column not null without default'],
    [
      'add column not null, after a comma in a type',
      "await sql`ALTER TABLE x ADD COLUMN a text,\n  ADD COLUMN\n b numeric(10, 2) NOT  NULL`.execute(db)",
      'add column not null without default',
    ],
  ]
  test.each(cases)('catches %s', (_name, up, expected) => {
    expect(forbiddenInUp(`export async function up(db) {\n  ${up}\n}`)).toContain(expected)
  })
  test('passes create table, add column (nullable or with a default) and create index', () => {
    const up = `
      await db.schema.createTable('x').addColumn('id', 'serial', (c) => c.primaryKey()).addColumn('n', 'text', (c) => c.notNull()).execute()
      await db.schema.alterTable('students').addColumn('renamedAt', 'timestamptz').execute()
      await db.schema.alterTable('students').addColumn('count', 'integer', (c) => c.notNull().defaultTo(0)).execute()
      await sql\`alter table students add column dropped_count integer not null default 0\`.execute(db)
      await sql\`alter table students add column if not exists note text, add column n numeric(10, 2) default 0 not null\`.execute(db)
      await sql\`create table y (id serial primary key, name text not null)\`.execute(db)
      await db.schema.createIndex('x_idx').on('x').column('id').execute()`
    expect(forbiddenInUp(up)).toEqual([])
  })
  test('ignores words in comments', () => {
    const up = `
      // the old column was renamed and dropped (drop column, rename to) in an earlier design
      /* alter column y
         drop table x */
      await db.schema.createTable('x').addColumn('id', 'serial').execute()`
    expect(forbiddenInUp(up)).toEqual([])
  })
})

describe('migrations only add', () => {
  test('there are migrations to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })
  test.each(files)('%s: up renames, drops and alters nothing, and adds no NOT NULL column without a default', (file) => {
    const allowed = ALLOWED.find((a) => a.file === file)?.calls ?? []
    const used = forbiddenInUp(upSource(file)).filter((call) => !allowed.includes(call))
    expect(used).toEqual([])
  })
  test('every allow-list entry names a real migration and gives a reason', () => {
    for (const a of ALLOWED) {
      expect(files).toContain(a.file)
      expect(a.reason.length).toBeGreaterThan(10)
    }
  })
})
