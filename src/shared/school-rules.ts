import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff'

// The school rules (报名协议和校规), one Markdown file per version in a directory: `YYYY-MM-DD.md`, the date being the
// version. Old versions are kept, so the service can show any of them and what changed since. A file starts with the
// title, then `版本：<the version>` and `本次修改：<what changed>`; each rule is a line of its own after that.

export interface SchoolRulesVersion {
  version: string
  /** What this version changed, from its `本次修改：` line. */
  changes: string
  /** The whole file. */
  text: string
}

export interface SchoolRules {
  /** The newest version: the one owners agree to now. */
  current: SchoolRulesVersion
  /** Every version, oldest first. */
  versions: SchoolRulesVersion[]
}

const VERSION_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/
const VERSION_LINE = '版本：'
const CHANGES_LINE = '本次修改：'

/** The value of the first line that starts with `prefix`, trimmed; undefined when there is none. */
function headerValue(lines: string[], prefix: string): string | undefined {
  return lines.find((line) => line.startsWith(prefix))?.slice(prefix.length).trim()
}

/** Reads every version in `dir`. Throws, naming the directory or the file, when there is none or one is malformed. */
export function loadSchoolRules(dir: string): SchoolRules {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (err) {
    throw new Error(`Cannot read the school rules directory ${dir}: ${(err as Error).message}`)
  }

  const versions = names
    .flatMap((name) => {
      const version = VERSION_FILE.exec(name)?.[1]
      return version === undefined ? [] : [{ name, version }]
    })
    // Dates written YYYY-MM-DD sort as text.
    .sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0))
    .map(({ name, version }): SchoolRulesVersion => {
      const text = readFileSync(join(dir, name), 'utf8')
      const lines = text.split('\n')
      const stated = headerValue(lines, VERSION_LINE)
      if (stated !== version) {
        throw new Error(
          `Invalid school rules ${join(dir, name)}: the "${VERSION_LINE}" line must say ${version}, the file name (found ${stated ?? 'no such line'})`,
        )
      }
      const changes = headerValue(lines, CHANGES_LINE)
      if (changes === undefined || changes === '') {
        throw new Error(`Invalid school rules ${join(dir, name)}: no "${CHANGES_LINE}" line saying what this version changed`)
      }
      return { version, changes, text }
    })

  const current = versions.at(-1)
  if (current === undefined) throw new Error(`No school rules in ${dir}: expected a file named YYYY-MM-DD.md`)
  return { current, versions }
}

/** Where a version can be read on GitHub. */
export function schoolRulesUrl(version: string): string {
  return `https://github.com/schoolforbots/server/blob/main/school-rules/${version}.md`
}

/**
 * What changed from the version `from` to the current one, as a unified diff (the files named `<version>.md`, three
 * lines of context): '' when `from` is the current version, null when the school never had it.
 */
export function diffSchoolRules(rules: SchoolRules, from: string): string | null {
  const old = rules.versions.find((v) => v.version === from)
  if (old === undefined) return null
  const { current } = rules
  if (old.version === current.version) return ''
  return createTwoFilesPatch(`${old.version}.md`, `${current.version}.md`, old.text, current.text, undefined, undefined, {
    context: 3,
    // The `---` and `+++` lines only, as git prints them, without jsdiff's `Index:` and `====` lines.
    headerOptions: FILE_HEADERS_ONLY,
  })
}
