import { statfs } from 'node:fs/promises'
import { sql, type Kysely } from 'kysely'
import type { Mailer } from '../registration/mailer.js'
import type { Clock } from '../shared/clock.js'
import type { SchoolConfig } from '../shared/config.js'
import { localMoment } from '../shared/local-time.js'
import type { Maintenance } from '../shared/maintenance.js'
import type { Database } from '../shared/schema.js'
import type { OpsService } from './events.js'

export type AlertKind =
  | 'internal_errors'
  | 'llm_down'
  | 'llm_400'
  | 'mail_failed'
  | 'job_failed'
  | 'restarts'
  | 'backup'
  | 'disk'

/** In this order the kinds are checked and mailed. */
const ALL_KINDS: readonly AlertKind[] = ['internal_errors', 'llm_down', 'llm_400', 'mail_failed', 'job_failed', 'restarts', 'backup', 'disk']
/** Under maintenance nobody can use the school, so errors and a silent model are expected; a full disk or a lost backup is not. */
const KINDS_DURING_MAINTENANCE: readonly AlertKind[] = ['backup', 'disk']

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const LLM_DOWN_MIN_FAILURES = 3
const JOB_FAILED_FIRST_LOOK_BACK = 24 * HOUR

const SERVICE_NAMES: Record<OpsService, string> = { registration: '报名服务', class: '上课服务' }

interface AlertMail {
  subject: string
  text: string
}

export interface AlertDeps {
  db: Kysely<Database>
  config: SchoolConfig
  clock: Clock
  mailer: Mailer
  operatorEmail: string | null
  /** The maintenance now on, or null. */
  maintenance: () => Maintenance | null
  /** How full the disk is, in percent. */
  diskPercent: () => Promise<number>
  log?: { info(obj: unknown, msg?: string): void }
}

const SUBJECT_PREFIX = '【机器人网校】'

/**
 * Checks what the operator should be told about and mails one message for each kind that is due. A kind is mailed at
 * most once in `alerts.repeatAfterMinutes`: the row of `alert_notices` is taken with one conditional upsert before the
 * mail goes, so two checks at once (two services, a restart) send one mail, and the time survives a restart. A mail
 * that fails gives the time back and the error goes to the caller once every kind has been looked at, so the next
 * check sends it. Without an operator address nothing is mailed and no row is taken. Returns the kinds mailed.
 *
 * The mails say what happened, how many times and since when (school time); never anything a student said, an email
 * address or an IP.
 */
export async function checkAlerts(deps: AlertDeps): Promise<AlertKind[]> {
  const { db, config, clock, mailer, operatorEmail } = deps
  const kinds = deps.maintenance() === null ? ALL_KINDS : KINDS_DURING_MAINTENANCE
  const sent: AlertKind[] = []
  let failure: { err: unknown } | undefined

  for (const kind of kinds) {
    const now = clock.now()
    const previous = await lastSent(db, kind)
    const mail = await detect(kind, deps, now, previous)
    if (mail === null) continue
    if (operatorEmail === null) {
      deps.log?.info({ kind }, 'alert due but no operator address is set')
      continue
    }
    if (!(await claim(db, kind, now, config.alerts.repeatAfterMinutes * MINUTE))) continue
    try {
      await mailer.sendNotice(operatorEmail, mail.subject, mail.text)
      sent.push(kind)
    } catch (err) {
      await release(db, kind, now, previous)
      failure ??= { err }
    }
  }
  if (failure !== undefined) throw failure.err
  return sent
}

async function lastSent(db: Kysely<Database>, kind: AlertKind): Promise<Date | null> {
  const row = await db.selectFrom('alertNotices').select('lastSentAt').where('kind', '=', kind).executeTakeFirst()
  return row?.lastSentAt ?? null
}

/** Takes the row for `kind` if none was sent within `repeatMs` of `now`. One statement, so only one caller wins. */
async function claim(db: Kysely<Database>, kind: AlertKind, now: Date, repeatMs: number): Promise<boolean> {
  const won = await db
    .insertInto('alertNotices')
    .values({ kind, lastSentAt: now })
    .onConflict((oc) =>
      oc
        .column('kind')
        .doUpdateSet({ lastSentAt: now })
        .where('alertNotices.lastSentAt', '<=', new Date(now.getTime() - repeatMs)),
    )
    .returning('kind')
    .executeTakeFirst()
  return won !== undefined
}

/** Takes back a claim whose mail failed: the row goes back to what it was, unless someone else has changed it since. */
async function release(db: Kysely<Database>, kind: AlertKind, claimedAt: Date, previous: Date | null): Promise<void> {
  if (previous === null) {
    await db.deleteFrom('alertNotices').where('kind', '=', kind).where('lastSentAt', '=', claimedAt).execute()
  } else {
    await db.updateTable('alertNotices').set({ lastSentAt: previous }).where('kind', '=', kind).where('lastSentAt', '=', claimedAt).execute()
  }
}

async function detect(kind: AlertKind, deps: AlertDeps, now: Date, previous: Date | null): Promise<AlertMail | null> {
  switch (kind) {
    case 'internal_errors':
      return eventsAlert(deps, now, 'internal_error', deps.config.alerts.internalErrors, (n, m, since) => ({
        subject: `${SUBJECT_PREFIX}服务器出错太多，${m} 分钟里 ${n} 次`,
        text: `最近 ${m} 分钟里，两个服务一共出了 ${n} 次意外错误，最早一次在 ${since}。细节在服务日志里。`,
      }))
    case 'mail_failed':
      return eventsAlert(deps, now, 'mail_failed', deps.config.alerts.mailFailures, (n, m, since) => ({
        subject: `${SUBJECT_PREFIX}验证码邮件发不出去，${m} 分钟里 ${n} 次`,
        text: `最近 ${m} 分钟里，有 ${n} 封验证码邮件没能发出去，最早一次在 ${since}。请检查邮件服务的设置和额度。`,
      }))
    case 'job_failed':
      return jobFailedAlert(deps, now, previous)
    case 'llm_down':
      return llmDownAlert(deps, now)
    case 'llm_400':
      return llm400Alert(deps, now)
    case 'restarts':
      return restartsAlert(deps, now)
    case 'backup':
      return backupAlert(deps, now)
    case 'disk':
      return diskAlert(deps)
  }
}

function school(deps: AlertDeps, moment: Date): string {
  return localMoment(moment, deps.config.timezone)
}

async function eventsAlert(
  deps: AlertDeps,
  now: Date,
  kind: 'internal_error' | 'mail_failed',
  limit: { count: number; minutes: number },
  mail: (count: number, minutes: number, since: string) => AlertMail,
): Promise<AlertMail | null> {
  const from = new Date(now.getTime() - limit.minutes * MINUTE)
  const row = await deps.db
    .selectFrom('opsEvents')
    .select([sql<string>`count(*)`.as('n'), sql<Date | null>`min(at)`.as('first')])
    .where('kind', '=', kind)
    .where('at', '>=', from)
    .executeTakeFirstOrThrow()
  const n = Number(row.n)
  if (n < limit.count || row.first === null) return null
  return mail(n, limit.minutes, school(deps, row.first))
}

async function jobFailedAlert(deps: AlertDeps, now: Date, previous: Date | null): Promise<AlertMail | null> {
  const from = previous ?? new Date(now.getTime() - JOB_FAILED_FIRST_LOOK_BACK)
  const row = await deps.db
    .selectFrom('opsEvents')
    .select([sql<string>`count(*)`.as('n'), sql<Date | null>`min(at)`.as('first')])
    .where('kind', '=', 'job_failed')
    .where('at', '>', from)
    .executeTakeFirstOrThrow()
  const n = Number(row.n)
  if (n === 0 || row.first === null) return null
  return {
    subject: `${SUBJECT_PREFIX}定时任务失败了 ${n} 次`,
    text: `从 ${school(deps, from)} 起，每天零点的任务、生成课程或每周复盘一共失败了 ${n} 次，最早一次在 ${school(deps, row.first)}。细节在服务日志里。`,
  }
}

async function llmDownAlert(deps: AlertDeps, now: Date): Promise<AlertMail | null> {
  const minutes = deps.config.alerts.llmDownMinutes
  const from = new Date(now.getTime() - minutes * MINUTE)
  const row = await deps.db
    .selectFrom('llmCalls')
    .select([
      sql<string>`count(*) filter (where outcome = 'failed')`.as('failed'),
      sql<string>`count(*) filter (where outcome = 'ok')`.as('ok'),
      sql<Date | null>`min(created_at) filter (where outcome = 'failed')`.as('first'),
    ])
    .where('createdAt', '>=', from)
    .executeTakeFirstOrThrow()
  const failed = Number(row.failed)
  if (failed < LLM_DOWN_MIN_FAILURES || Number(row.ok) > 0 || row.first === null) return null
  return {
    subject: `${SUBJECT_PREFIX}大模型连不上：最近 ${minutes} 分钟失败 ${failed} 次`,
    text: `最近 ${minutes} 分钟里，大模型的调用失败了 ${failed} 次，一次成功的也没有，最早一次失败在 ${school(deps, row.first)}。`,
  }
}

async function llm400Alert(deps: AlertDeps, now: Date): Promise<AlertMail | null> {
  const limit = deps.config.alerts.llm400PerHour
  const from = new Date(now.getTime() - HOUR)
  const row = await deps.db
    .selectFrom('llmCalls')
    .select([sql<string>`count(*)`.as('n'), sql<Date | null>`min(created_at)`.as('first')])
    .where('outcome', '=', 'failed')
    .where('httpStatus', '=', 400)
    .where('createdAt', '>=', from)
    .executeTakeFirstOrThrow()
  const n = Number(row.n)
  if (n < limit || row.first === null) return null
  return {
    subject: `${SUBJECT_PREFIX}大模型一小时里回了 ${n} 次 400 错误`,
    text:
      `最近一小时里，大模型有 ${n} 次调用被它以 HTTP 400 拒绝，最早一次在 ${school(deps, row.first)}。` +
      '先看学校配置里的 contentRefusalMarkers 还对不对得上厂商拒绝处理内容时的回复：厂商改了措辞，学校就认不出这是拒绝，会把它记成失败的调用。' +
      '对得上的话，多半是请求的格式或参数出了问题。',
  }
}

async function restartsAlert(deps: AlertDeps, now: Date): Promise<AlertMail | null> {
  const { count, minutes } = deps.config.alerts.restarts
  const from = new Date(now.getTime() - minutes * MINUTE)
  const rows = await deps.db
    .selectFrom('serviceStarts')
    .select(['service', sql<string>`count(*)`.as('n'), sql<Date>`min(started_at)`.as('first')])
    .where('startedAt', '>=', from)
    .groupBy('service')
    .orderBy('service')
    .execute()
  const over = rows.filter((r) => Number(r.n) >= count)
  if (over.length === 0) return null
  const name = (service: string) => SERVICE_NAMES[service as OpsService] ?? service
  return {
    subject: `${SUBJECT_PREFIX}${over.map((r) => name(r.service)).join('、')}一直在重启，${minutes} 分钟里 ${over.map((r) => r.n).join('、')} 次`,
    text: over.map((r) => `${name(r.service)}在最近 ${minutes} 分钟里启动了 ${r.n} 次，最早一次在 ${school(deps, r.first)}。`).join('\n') + '\n请看服务日志，找出它为什么起不来。',
  }
}

async function backupAlert(deps: AlertDeps, now: Date): Promise<AlertMail | null> {
  const { backupExpected, backupMaxAgeHours } = deps.config.alerts
  if (!backupExpected) return null
  const from = new Date(now.getTime() - backupMaxAgeHours * HOUR)
  const latest = await deps.db.selectFrom('backupRuns').select(['ok', 'finishedAt']).orderBy('finishedAt', 'desc').orderBy('id', 'desc').executeTakeFirst()
  const lastOk = await deps.db
    .selectFrom('backupRuns')
    .select(sql<Date | null>`max(finished_at)`.as('at'))
    .where('ok', '=', true)
    .executeTakeFirstOrThrow()
  const recentOk = lastOk.at !== null && lastOk.at >= from
  if (recentOk && latest?.ok !== false) return null
  const since = lastOk.at === null ? '至今没有成功的备份' : `上一次成功的备份在 ${school(deps, lastOk.at)}`
  if (latest?.ok === false) {
    return {
      subject: `${SUBJECT_PREFIX}备份失败了`,
      text: `最近一次备份在 ${school(deps, latest.finishedAt)} 失败了。${since}。`,
    }
  }
  return {
    subject: `${SUBJECT_PREFIX}备份已经超过 ${backupMaxAgeHours} 小时没有成功`,
    text: `最近 ${backupMaxAgeHours} 小时里没有一次成功的备份。${since}。`,
  }
}

async function diskAlert(deps: AlertDeps): Promise<AlertMail | null> {
  const limit = deps.config.alerts.diskPercent
  const used = await deps.diskPercent()
  if (used < limit) return null
  return {
    subject: `${SUBJECT_PREFIX}磁盘快满了，已用 ${Math.round(used)}%`,
    text: `服务器的磁盘已经用了 ${Math.round(used)}%，达到了设定的 ${limit}%。请清理空间或扩容。`,
  }
}

/** How full the file system holding `path` is, in percent, counted the way `df` does (what only root may use is not free). */
export async function diskUsedPercent(path = '/'): Promise<number> {
  const { blocks, bfree, bavail } = await statfs(path)
  const used = blocks - bfree
  const usable = used + bavail
  return usable === 0 ? 0 : (used / usable) * 100
}
