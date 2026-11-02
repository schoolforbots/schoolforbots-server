import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import type { Kysely } from 'kysely'
import { teacherPersonaFor } from '../registration/daily-job.js'
import { systemClock, type Clock } from '../shared/clock.js'
import { loadClassEnv, loadSchoolConfig, type Division, type SchoolConfig, type Slot } from '../shared/config.js'
import { createDb, lock, slotLockKey } from '../shared/db.js'
import { className, displayName } from '../shared/identity.js'
import type { Database } from '../shared/schema.js'
import { generateStudentKey, hashSecret } from '../shared/secrets.js'
import { isEntryPoint } from './entry-point.js'

// `npm run dev:seed -- --division junior --slot evening --students 20 --out .sim/keys.json`: for local development
// only. Opens a new class and puts N active students in it straight away, past registration, the nightly class
// assignment and the probation, then writes their student numbers and keys to the output file (see sim-bots.ts, which
// reads it). It refuses any database but one on this machine.

/** A seeding that was refused. The message says why, in Chinese, for the person running the command. */
export class DevSeedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DevSeedError'
  }
}

/** The plugin the seeded students registered with, as the simulator's hello names it too. */
export const SIM_PLUGIN = { type: 'sim', version: '0.0.0' } as const

/** The host pg connects to for this URL: a `host` parameter takes the place of the one before it. Null if none. */
function databaseHost(databaseUrl: string): string | null {
  let url: URL
  try {
    url = new URL(databaseUrl)
  } catch {
    return null
  }
  return url.searchParams.get('host') || url.hostname || null
}

/**
 * Whether the URL names a database on this machine: its host is exactly `localhost` or `127.0.0.1`. Anything else
 * (another host, no host at all, a socket path, something that is not a URL) is not.
 */
export function isLocalDatabaseUrl(databaseUrl: string): boolean {
  const host = databaseHost(databaseUrl)
  return host === 'localhost' || host === '127.0.0.1'
}

export interface SeedOptions {
  division: Division
  slot: Slot
  /** How many students to put in the class: from 1 to `config.classSize.max`. */
  students: number
  /** The source of every timestamp written. */
  clock: Clock
}

/** One seeded student, as the output file lists them. */
export interface SeededStudent {
  studentId: number
  key: string
  displayName: string
}

export interface SeedResult {
  classId: number
  className: string
  /** The name of the class's teacher. */
  teacher: string
  /** In student-number order; the n-th is 模拟主人{n}家的机器人{n}. */
  students: SeededStudent[]
}

/**
 * Opens a class of the division and slot and fills it with `students` active students, in one transaction. The class
 * is numbered and given a teacher as the nightly job does it: after the highest class number of its division and slot,
 * with the next persona in turn. The students' keys are made and hashed as at registration; they are past the
 * probation (`lessonsAttended` is the config's `probationLessons`), so they may start conversations at once.
 */
export async function seedClass(db: Kysely<Database>, config: SchoolConfig, opts: SeedOptions): Promise<SeedResult> {
  const { division, slot, students: count } = opts
  const max = config.classSize.max
  if (!Number.isInteger(count) || count < 1 || count > max) {
    throw new DevSeedError(`--students 必须是 1 到 ${max} 之间的整数（学校配置里一个班最多 ${max} 人），现在是 ${count}`)
  }

  const now = opts.clock.now()
  return db.transaction().execute(async (trx) => {
    // The nightly job opens classes under the slot locks too, so the two never give a class the same number.
    await lock(trx, slotLockKey(slot))
    const { highest } = await trx
      .selectFrom('classes')
      .select((eb) => eb.fn.max('classNo').as('highest'))
      .where('division', '=', division)
      .where('slot', '=', slot)
      .executeTakeFirstOrThrow()
    const { classes } = await trx
      .selectFrom('classes')
      .select((eb) => eb.fn.countAll().as('classes'))
      .executeTakeFirstOrThrow()
    const classNo = (highest ?? 0) + 1
    const persona = teacherPersonaFor(config, Number(classes))
    const { id: classId } = await trx
      .insertInto('classes')
      .values({ division, slot, classNo, teacherPersonaId: persona.id, createdAt: now })
      .returning('id')
      .executeTakeFirstOrThrow()

    const seeded: SeededStudent[] = []
    for (let n = 1; n <= count; n++) {
      const ownerName = `模拟主人${n}`
      const aiName = `机器人${n}`
      const key = generateStudentKey()
      const { id } = await trx
        .insertInto('students')
        .values({
          // The class number keeps the addresses of every seeding apart; example.invalid never reaches anyone.
          email: `sim-${classId}-${n}@example.invalid`,
          ownerName,
          aiName,
          division,
          slot,
          status: 'active',
          classId,
          installId: randomUUID(),
          pluginType: SIM_PLUGIN.type,
          pluginVersion: SIM_PLUGIN.version,
          keyHash: hashSecret(key),
          registrationIp: '127.0.0.1',
          createdAt: now,
          queuedAt: now,
          assignedAt: now,
          lastAttendedAt: null,
          lastRenamedAt: null,
          lessonsAttended: config.chat.probationLessons,
          suspendedUntil: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      seeded.push({ studentId: id, key, displayName: displayName(ownerName, aiName) })
    }

    return { classId, className: className(division, slot, classNo, config), teacher: persona.name, students: seeded }
  })
}

/** Writes the students as a JSON list of `{ studentId, key, displayName }`, making its directory if need be. */
export function writeKeysFile(path: string, students: SeededStudent[]): void {
  mkdirSync(dirname(path), { recursive: true })
  // The keys let anyone into class as these students: the file is for its owner alone.
  writeFileSync(path, `${JSON.stringify(students, null, 2)}\n`, { mode: 0o600 })
}

const USAGE =
  '用法：npm run dev:seed -- --division <primary|junior|senior> --slot <morning|afternoon|evening> --students <人数> --out <输出文件.json>'

const DIVISIONS: readonly Division[] = ['primary', 'junior', 'senior']
const SLOTS: readonly Slot[] = ['morning', 'afternoon', 'evening']

interface SeedArgs {
  division: Division
  slot: Slot
  students: number
  out: string
}

/** The command line, or null when it is not as `USAGE` says. */
function parseSeedArgs(argv: string[]): SeedArgs | null {
  let values: Record<string, string | undefined>
  try {
    values = parseArgs({
      args: argv,
      options: {
        division: { type: 'string' },
        slot: { type: 'string' },
        students: { type: 'string' },
        out: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }).values
  } catch {
    return null
  }
  const { division, slot, students, out } = values
  if (!DIVISIONS.includes(division as Division) || !SLOTS.includes(slot as Slot)) return null
  if (students === undefined || !/^[0-9]+$/.test(students) || out === undefined || out === '') return null
  return { division: division as Division, slot: slot as Slot, students: Number(students), out }
}

/** Returns the process exit code: 0 when the class was seeded, 1 when it was refused or something failed. */
async function main(argv: string[]): Promise<number> {
  const args = parseSeedArgs(argv)
  if (args === null) {
    console.error(USAGE)
    return 1
  }

  try {
    // What the class service reads: the database and the school config, and no mail settings.
    const env = loadClassEnv(process.env)
    if (!isLocalDatabaseUrl(env.databaseUrl)) {
      // Only the host: the URL carries the password.
      throw new DevSeedError(
        `只能往本机的数据库里造数据：DATABASE_URL 的主机必须是 localhost 或 127.0.0.1，现在是 ${databaseHost(env.databaseUrl) ?? '（没有主机）'}`,
      )
    }
    const config = loadSchoolConfig(env.configPath)
    const db = createDb(env.databaseUrl)
    try {
      const result = await seedClass(db, config, { ...args, clock: systemClock })
      writeKeysFile(args.out, result.students)
      const first = result.students[0]?.studentId
      const last = result.students.at(-1)?.studentId
      console.log(
        `已建好 ${result.className}（班级编号 ${result.classId}，${result.teacher}任教），${result.students.length} 个学生，学号 ${first} 到 ${last}`,
      )
      console.log(`学号和钥匙写在 ${args.out}`)
    } finally {
      await db.destroy()
    }
    return 0
  } catch (err) {
    if (err instanceof DevSeedError) {
      console.error(`造数据失败：${err.message}`)
    } else {
      console.error('造数据失败', err)
    }
    return 1
  }
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error('造数据失败', err)
      process.exit(1)
    },
  )
}
