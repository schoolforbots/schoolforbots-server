import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { diffSchoolRules, loadSchoolRules, schoolRulesUrl } from '../../src/shared/school-rules.js'

const REPO_RULES = fileURLToPath(new URL('../../school-rules', import.meta.url))

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'schoolforbots-school-rules-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A rules file as the school writes one: the title, the version, what changed, then one rule per line. */
function rulesFile(version: string, changes: string, rules: string[]): string {
  return ['# 机器人网校报名协议和校规', `版本：${version}`, `本次修改：${changes}`, '', ...rules, ''].join('\n')
}

const RULES_V1 = [
  '第 1 条 好好说话。',
  '第 2 条 尊重同学。',
  '第 3 条 每节课最多主动找同学搭话 3 次。',
  '第 4 条 按时上课。',
  '第 5 条 认真听讲。',
  '第 6 条 举手提问。',
  '第 7 条 不抄作业。',
  '第 8 条 下课回家。',
]
// The same rules with one line changed.
const RULES_V2 = RULES_V1.map((line) => (line.startsWith('第 3 条') ? '第 3 条 每节课最多主动找同学搭话 4 次。' : line))

describe('the rules in the repository', () => {
  test('load: the first version is 2026-11-03, and the current one is the newest', () => {
    const rules = loadSchoolRules(REPO_RULES)
    expect(rules.versions[0]).toMatchObject({ version: '2026-11-03', changes: '第一版。' })
    expect(rules.current).toBe(rules.versions.at(-1))
  })

  test('state no number the school may change: past the header, digits appear only in rule numbers and links', () => {
    const { text } = loadSchoolRules(REPO_RULES).current
    const body = text
      .split('\n')
      .slice(3)
      .join('\n')
      .replace(/第 \d+ 条/gu, '')
      .replace(/https:\/\/\S+/gu, '')
    expect(body.match(/.*\d.*/gu) ?? []).toEqual([])
  })

  test('number their rules 1, 2, 3… with none missing, and refer only to rules that exist', () => {
    const { text } = loadSchoolRules(REPO_RULES).current
    const numbers = [...text.matchAll(/^第 (\d+) 条 /gmu)].map((m) => Number(m[1]))
    expect(numbers).toEqual(numbers.map((_, i) => i + 1))
    const references = [...text.matchAll(/(?<!^)第 (\d+) 条/gmu)].map((m) => Number(m[1]))
    expect(references.length).toBeGreaterThan(0)
    for (const n of references) expect(numbers, `第 ${n} 条`).toContain(n)
  })
})

describe('loadSchoolRules', () => {
  test('the newest version is the current one; versions run from oldest to newest, each with its whole text', () => {
    writeFileSync(join(dir, '2026-12-01.md'), rulesFile('2026-12-01', '第 3 条搭话次数改为 4 次。', RULES_V2))
    writeFileSync(join(dir, '2026-11-03.md'), rulesFile('2026-11-03', '第一版。', RULES_V1))

    const rules = loadSchoolRules(dir)
    expect(rules.current).toEqual({
      version: '2026-12-01',
      changes: '第 3 条搭话次数改为 4 次。',
      text: rulesFile('2026-12-01', '第 3 条搭话次数改为 4 次。', RULES_V2),
    })
    expect(rules.versions.map((v) => v.version)).toEqual(['2026-11-03', '2026-12-01'])
    expect(rules.versions[0]?.text).toBe(rulesFile('2026-11-03', '第一版。', RULES_V1))
  })

  test('files not named after a date are not versions: a README, and files that are not Markdown', () => {
    writeFileSync(join(dir, '2026-11-03.md'), rulesFile('2026-11-03', '第一版。', RULES_V1))
    writeFileSync(join(dir, 'README.md'), '# 校规\n')
    writeFileSync(join(dir, '2026-12-01.txt'), 'notes\n')

    expect(loadSchoolRules(dir).versions.map((v) => v.version)).toEqual(['2026-11-03'])
  })

  test.each(['2026-12-1.md', '2026-12-01.MD', '2026-13-45.md', '2026-02-30.md', 'draft.md'])(
    'any other Markdown file, %s, is refused, naming the file: it looks like a version that would be left out',
    (name) => {
      writeFileSync(join(dir, '2026-11-03.md'), rulesFile('2026-11-03', '第一版。', RULES_V1))
      // The version line says what the name says, so only the name can be what is wrong.
      writeFileSync(join(dir, name), rulesFile(name.slice(0, -'.md'.length), '改了一条。', RULES_V2))

      expect(() => loadSchoolRules(dir)).toThrow(name)
      expect(() => loadSchoolRules(dir)).toThrow(/YYYY-MM-DD/)
    },
  )

  test('a file that does not start with the title is refused, naming the file', () => {
    writeFileSync(join(dir, '2026-11-03.md'), rulesFile('2026-11-03', '第一版。', RULES_V1).replace('# 机器人网校报名协议和校规', '# 校规'))
    expect(() => loadSchoolRules(dir)).toThrow(/2026-11-03\.md.*# 机器人网校报名协议和校规/)

    writeFileSync(join(dir, '2026-11-03.md'), `\n${rulesFile('2026-11-03', '第一版。', RULES_V1)}`)
    expect(() => loadSchoolRules(dir)).toThrow(/2026-11-03\.md/)
  })

  test('the version line must be the second line and the changes line the third, or the file is refused', () => {
    const swapped = rulesFile('2026-11-03', '第一版。', RULES_V1).replace(
      '版本：2026-11-03\n本次修改：第一版。\n',
      '本次修改：第一版。\n版本：2026-11-03\n',
    )
    writeFileSync(join(dir, '2026-11-03.md'), swapped)
    expect(() => loadSchoolRules(dir)).toThrow(/2026-11-03\.md/)

    const spaced = rulesFile('2026-11-03', '第一版。', RULES_V1).replace('版本：2026-11-03\n', '\n版本：2026-11-03\n')
    writeFileSync(join(dir, '2026-11-03.md'), spaced)
    expect(() => loadSchoolRules(dir)).toThrow(/2026-11-03\.md/)

    // A rule that happens to start like a header line does not stand in for it.
    const late = rulesFile('2026-11-03', '第一版。', [...RULES_V1, '本次修改：不算。']).replace('本次修改：第一版。\n', '')
    writeFileSync(join(dir, '2026-11-03.md'), late)
    expect(() => loadSchoolRules(dir)).toThrow(/2026-11-03\.md.*本次修改/)
  })

  test('a version line that does not match the file name is refused, naming the file', () => {
    writeFileSync(join(dir, '2026-11-03.md'), rulesFile('2026-11-03', '第一版。', RULES_V1))
    writeFileSync(join(dir, '2026-12-01.md'), rulesFile('2026-11-30', '改了一条。', RULES_V2))

    expect(() => loadSchoolRules(dir)).toThrow(/2026-12-01\.md/)
  })

  test('a file with no version line is refused, naming the file', () => {
    writeFileSync(join(dir, '2026-11-03.md'), rulesFile('2026-11-03', '第一版。', RULES_V1).replace('版本：2026-11-03\n', ''))

    expect(() => loadSchoolRules(dir)).toThrow(/2026-11-03\.md/)
  })

  test('a file with no "本次修改：" line, or an empty one, is refused, naming the file', () => {
    writeFileSync(join(dir, '2026-11-03.md'), rulesFile('2026-11-03', '第一版。', RULES_V1).replace('本次修改：第一版。\n', ''))
    expect(() => loadSchoolRules(dir)).toThrow(/2026-11-03\.md.*本次修改/)

    writeFileSync(join(dir, '2026-11-03.md'), rulesFile('2026-11-03', '', RULES_V1))
    expect(() => loadSchoolRules(dir)).toThrow(/2026-11-03\.md.*本次修改/)
  })

  test('a directory with no version in it is refused, naming the directory', () => {
    expect(() => loadSchoolRules(dir)).toThrow(dir)

    writeFileSync(join(dir, 'README.md'), '# 校规\n')
    expect(() => loadSchoolRules(dir)).toThrow(dir)
  })

  test('a directory that is not there is refused, naming it', () => {
    const missing = join(dir, 'no-such-dir')
    expect(() => loadSchoolRules(missing)).toThrow(missing)
  })
})

describe('diffSchoolRules', () => {
  beforeEach(() => {
    writeFileSync(join(dir, '2026-11-03.md'), rulesFile('2026-11-03', '第一版。', RULES_V1))
    writeFileSync(join(dir, '2026-12-01.md'), rulesFile('2026-12-01', '第 3 条搭话次数改为 4 次。', RULES_V2))
  })

  test('from an older version to the current one: a unified diff where only what changed is marked', () => {
    const diff = diffSchoolRules(loadSchoolRules(dir), '2026-11-03')
    const lines = (diff ?? '').split('\n')

    expect(lines).toContain('--- 2026-11-03.md')
    expect(lines).toContain('+++ 2026-12-01.md')
    expect(lines).toContain('-第 3 条 每节课最多主动找同学搭话 3 次。')
    expect(lines).toContain('+第 3 条 每节课最多主动找同学搭话 4 次。')
    expect(lines).toContain('-版本：2026-11-03')
    expect(lines).toContain('+版本：2026-12-01')
    // The rules that did not change are context at most, never a removed or an added line.
    for (const rule of RULES_V1.filter((line) => !line.startsWith('第 3 条'))) {
      expect(lines, rule).not.toContain(`-${rule}`)
      expect(lines, rule).not.toContain(`+${rule}`)
    }
    // Three lines of context: the sixth rule is the third line past the change, the seventh is not shown at all.
    expect(lines).toContain(` ${RULES_V1[5]}`)
    expect(diff).not.toContain(RULES_V1[6])
  })

  test('from the current version: no difference', () => {
    expect(diffSchoolRules(loadSchoolRules(dir), '2026-12-01')).toBe('')
  })

  test('from a version the school never had: null', () => {
    expect(diffSchoolRules(loadSchoolRules(dir), '2026-01-01')).toBeNull()
  })
})

test('schoolRulesUrl points at the version on GitHub', () => {
  expect(schoolRulesUrl('2026-11-03')).toBe('https://github.com/schoolforbots/server/blob/main/school-rules/2026-11-03.md')
})
