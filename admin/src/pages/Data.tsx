import { Badge, Button, Card, PageActions, Segmented, Sparkline, type Tone } from '../ui.js'
import { useId, useState } from 'react'
import {
  dailyStatsPath,
  useLoad,
  type DailyStats,
  type DayNumbers,
  type LlmPurpose,
  type SeriesDay,
  type StatsDays,
} from '../api.js'
import { LineChart, type Marker, type Series } from '../components/LineChart.js'
import { Empty, Failed, Loading } from '../components/States.js'
import {
  BLOCK_NAMES,
  clockTime,
  count,
  dayName,
  DIVISION_NAMES,
  localDay,
  preciseYuan,
  PURPOSE_NAMES,
  sentence,
  SLOT_NAMES,
  SWITCH_NAMES,
  weekdayOf,
  yuan,
} from '../labels.js'

// The school data page: today's numbers so far and yesterday's, each next to the same day a week before, what needs
// doing, and the daily curves of the last 7, 30 or 90 days up to yesterday. Every number on it comes from
// `api/stats/daily`, and every time is read on the school's clock, in the time zone the answer names.

/** The categorical colours of the charts, in this order; the green and red of the pages never draw a line. */
// Tailwind's indigo-600, amber-500, emerald-500, sky-500, pink-500, violet-500, orange-600.
const LINE_COLORS = ['#4f46e5', '#f59e0b', '#10b981', '#0ea5e9', '#ec4899', '#8b5cf6', '#ea580c']
const RANGES: StatsDays[] = [7, 30, 90]

const compactCount = (value: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact' }).format(value)
const tickYuan = (value: number) => `¥${Number(value.toPrecision(6))}`

type Counted = Exclude<keyof DayNumbers, 'date' | 'dauBySlot' | 'blockedByCategory'>

/** `rises`: whether more of it is good news (green) or bad (red); the words say which way it went either way. */
const TILES: { key: Counted; label: string; format: (value: number) => string; rises: 'good' | 'bad' }[] = [
  { key: 'dau', label: '来上课的学生', format: count, rises: 'good' },
  { key: 'chat', label: '聊天消息', format: count, rises: 'good' },
  { key: 'blocked', label: '拦下的消息', format: count, rises: 'bad' },
  { key: 'costYuan', label: '大模型花费', format: yuan, rises: 'bad' },
  { key: 'violations', label: '违反校规', format: count, rises: 'bad' },
  { key: 'suspensions', label: '停课', format: count, rises: 'bad' },
  { key: 'expulsions', label: '开除', format: count, rises: 'bad' },
  { key: 'registrations', label: '新报名', format: count, rises: 'good' },
]

/** The daily line under the four numbers that have one, from the curves below (up to yesterday). */
function trend(series: SeriesDay[], key: Counted): number[] | undefined {
  const sum = (values: Record<string, number>) => Object.values(values).reduce((a, b) => a + b, 0)
  switch (key) {
    case 'dau':
      return series.map((day) => sum(day.dauBySlot))
    case 'chat':
      return series.map((day) => day.chat)
    case 'blocked':
      return series.map((day) => sum(day.blockedByCategory) + day.blockedBySecondLayer)
    case 'costYuan':
      return series.map((day) => sum(day.costByPurpose))
    default:
      return undefined
  }
}

function Arrow({ up }: { up: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      {up ? <path d="M2 11.5 6.5 7l3 3L14 5.5M10 5.5h4v4" /> : <path d="M2 4.5 6.5 9l3-3 4.5 4.5M10 10.5h4v-4" />}
    </svg>
  )
}

/** How a number compares with the same day a week before, in words. */
function change(now: number, before: number | undefined, weekday: string, format: (value: number) => string) {
  if (before === undefined) return `上${weekday}学校还没开学`
  const diff = Math.round((now - before) * 100) / 100
  if (diff === 0) return `和上${weekday}一样`
  return `比上${weekday}${diff > 0 ? '多' : '少'} ${format(Math.abs(diff))}`
}

/**
 * A day's numbers as the template's stat cards: what it counts, the number, the same day last week beside it, and a
 * badge with the change in words, green for good news and red for bad. The month's spend goes with the day that has
 * `month`; `series` draws the daily line under the four numbers that have one.
 */
function Tiles(props: {
  labelId: string
  day: DayNumbers
  before: DayNumbers | null
  month?: DailyStats['month']
  series?: SeriesDay[]
}) {
  const { labelId, day, before, month, series } = props
  const weekday = weekdayOf(day.date)
  return (
    <div className="mt-4 grid grid-cols-4 gap-4">
      {TILES.map((tile) => {
        const now = day[tile.key]
        const then = before?.[tile.key]
        const diff = then === undefined ? 0 : now - then
        const better = diff === 0 ? undefined : (diff > 0) === (tile.rises === 'good')
        const tone: Tone = better === undefined ? 'gray' : better ? 'green' : 'red'
        const line = series === undefined ? undefined : trend(series, tile.key)
        return (
          <article
            key={tile.key}
            className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-5"
            role="group"
            aria-labelledby={`${labelId}-${tile.key}`}
          >
            <div className="flex items-start justify-between gap-2">
              <strong id={`${labelId}-${tile.key}`} className="block text-sm font-medium text-gray-600">
                {tile.label}
              </strong>
              <Badge tone={tone} className="gap-1 rounded-sm px-1.5">
                {diff !== 0 && <Arrow up={diff > 0} />}
                {change(now, then, weekday, tile.format)}
              </Badge>
            </div>
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-2xl font-medium text-gray-900 tabular-nums">{tile.format(now)}</span>
              {then !== undefined && (
                <span className="text-xs text-gray-600">
                  上{weekday} {tile.format(then)}
                </span>
              )}
            </p>
            {tile.key === 'costYuan' && month !== undefined && (
              <p className="-mt-2 text-xs text-gray-600">
                本月 {yuan(month.costYuan)}，预算 {yuan(month.budgetYuan)}
              </p>
            )}
            {line !== undefined && <Sparkline values={line} tone={tile.rises === 'good' ? 'indigo' : 'gray'} />}
          </article>
        )
      })}
    </div>
  )
}

/** Why no class is held today, when none is; undefined on a school day. */
function noClass(status: DailyStats['todayStatus'], weekday: string): string | undefined {
  if (status.state === 'not_started') return '学校还没开学，今天不上课。'
  if (status.state === 'on_break') return `今天放假${status.breakName === null ? '' : `（${status.breakName}）`}，不上课。`
  if (!status.schoolDay) return `今天是${weekday}，周末不上课。`
  if (status.maintenance) return '现在维护中：上课服务和社团服务都不让任何人进，碰上维护的时段今天不上课。'
  return undefined
}

/**
 * Today up to the time the numbers were counted, next to the same day last week up to the same time: a class that is
 * over is in them. They go on growing, so they can be read again up to now.
 */
function Today({ stats, reading, onUpdate }: { stats: DailyStats; reading: boolean; onUpdate: () => void }) {
  const titleId = useId()
  const { todaySoFar, sameTimeLastWeek, month } = stats
  const weekday = weekdayOf(todaySoFar.date)
  const time = clockTime(stats.asOf, stats.timeZone)
  // Said once above the tiles, which keep the short words of yesterday's.
  const against = sameTimeLastWeek === null ? undefined : `和上${weekday}零点到 ${time} 的数字比。`
  const why = noClass(stats.todayStatus, weekday)
  return (
    <section aria-labelledby={titleId}>
      <PageActions>
        {/* It stays enabled while it reads (a disabled button would lose the focus); a second click waits. */}
        <Button type="primary" onClick={() => !reading && onUpdate()}>
          {reading ? '正在更新' : '更新到现在'}
        </Button>
      </PageActions>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={titleId} className="text-base font-semibold text-gray-900">
          今天（截至 {time}），{dayName(todaySoFar.date)}
        </h2>
        {(against !== undefined || why !== undefined) && (
          <p className="text-sm text-gray-600">
            {against}
            {why}
          </p>
        )}
      </div>
      <Tiles labelId={titleId} day={todaySoFar} before={sameTimeLastWeek} month={month} series={stats.series} />
    </section>
  )
}

function Yesterday({ stats }: { stats: DailyStats }) {
  const titleId = useId()
  const { yesterday, sameDayLastWeek } = stats
  return (
    <section aria-labelledby={titleId}>
      <h2 id={titleId} className="text-base font-semibold text-gray-900">
        昨天，{dayName(yesterday.date)}
      </h2>
      <Tiles labelId={titleId} day={yesterday} before={sameDayLastWeek} />
    </section>
  )
}

function Reminders({ stats, onGoReview }: { stats: DailyStats; onGoReview: () => void }) {
  const { unreviewed, generationFailed } = stats.reminders
  const { month } = stats
  // One line per day: the doors of a day open once, whatever the division.
  const days = new Map<string, { deadline: string; divisions: string[] }>()
  for (const slot of unreviewed) {
    const day = days.get(slot.date) ?? { deadline: slot.deadline, divisions: [] }
    day.divisions.push(DIVISION_NAMES[slot.division])
    days.set(slot.date, day)
  }
  const nothing = unreviewed.length === 0 && generationFailed.length === 0 && !month.overBudget

  return (
    <Card title="要处理的事" label="要处理的事">
      {/* Only failures that lasted into a new day are listed: a fresh one is still being retried. */}
      {nothing && (
        <p className="mt-4 text-sm text-gray-600">
          现在没有要处理的事：开门前要审的课都审完了，没有一直生成不出来的课，本月花费也没超预算。
        </p>
      )}
      <ul className="mt-4 divide-y divide-gray-200">
        {unreviewed.length > 0 && (
          <li className="flex items-start justify-between gap-6 py-4 first:pt-0 last:pb-0">
            <div className="flex items-start gap-3">
              <Badge tone="yellow">待审</Badge>
              <div>
                <p className="text-sm font-medium text-gray-900">{unreviewed.length} 节课要在开门前审完，不然那一天改上自习：</p>
                <ul className="mt-1 space-y-0.5 text-sm text-gray-600">
                  {[...days].map(([date, day]) => (
                    <li key={date}>
                      {dayName(date)}
                      {clockTime(day.deadline, stats.timeZone)} 开门：{day.divisions.join('、')}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <Button type="primary" onClick={onGoReview}>
              去审课
            </Button>
          </li>
        )}
        {generationFailed.map((failure) => (
          <li key={`${failure.date}-${failure.division}`} className="flex items-start gap-3 py-4 first:pt-0 last:pb-0">
            <Badge tone="red">生成失败</Badge>
            <p className="text-sm text-gray-700">
              {`${dayName(failure.date)}${DIVISION_NAMES[failure.division]}的课没生成出来，试了 ${failure.attempts} 次，`}
              {`最后一次的原因：${sentence(failure.lastError)}`}
              {failure.date === stats.today
                ? '今天的课系统不会再生成了：要今天上这节课，到审课页手动粘贴，赶在开门前审过。'
                : '系统会接着重试；等不及的话，到审课页手动粘贴。'}
            </p>
          </li>
        ))}
        {month.overBudget && (
          <li className="flex items-start gap-3 py-4 first:pt-0 last:pb-0">
            <Badge tone="red">超预算</Badge>
            <p className="reminder-alarm text-sm">
              {`本月大模型花费 ${yuan(month.costYuan)}，超过了预算 ${yuan(month.budgetYuan)}。`}
              大模型照常在用，不会自动停；要少花钱，到开关页关掉暂时不用的功能。
            </p>
          </li>
        )}
      </ul>
    </Card>
  )
}

function lines<K extends string>(
  series: SeriesDay[],
  names: Record<K, string>,
  pick: (day: SeriesDay, key: K) => number,
): Series[] {
  return (Object.keys(names) as K[]).map((key, k) => ({
    key,
    name: names[key],
    color: LINE_COLORS[k] ?? '#5c5c5c',
    values: series.map((day) => pick(day, key)),
  }))
}

function Charts({ stats }: { stats: DailyStats }) {
  const { series } = stats
  const days = series.length
  const dates = series.map((day) => day.date)
  const markers: Marker[] = stats.switchChanges.map((change) => ({
    date: localDay(change.at, stats.timeZone),
    text: `${clockTime(change.at, stats.timeZone)} ${SWITCH_NAMES[change.name]}：${change.on ? '开' : '关'}`,
  }))
  const shared = { dates, markers }

  return (
    <div className="charts">
      <LineChart
        {...shared}
        title="每天有多少学生来上课？"
        series={lines(series, SLOT_NAMES, (day, slot) => day.dauBySlot[slot])}
        format={count}
        formatTick={compactCount}
        counts
        empty={`最近 ${days} 天没有学生来上课。`}
      />
      <LineChart
        {...shared}
        title="每天有多少条聊天消息？"
        series={[{ key: 'chat', name: '聊天消息', color: LINE_COLORS[0] ?? '', values: series.map((day) => day.chat) }]}
        format={count}
        formatTick={compactCount}
        counts
        empty={`最近 ${days} 天没有聊天消息。`}
      />
      <LineChart
        {...shared}
        title="每天拦下了多少条消息，各是因为什么？"
        series={[
          ...lines(series, BLOCK_NAMES, (day, category) => day.blockedByCategory[category]),
          // The second layer gives no category: its own line, so that the lines add up to the day's number.
          {
            key: 'secondLayer',
            name: '第二层',
            color: LINE_COLORS[Object.keys(BLOCK_NAMES).length] ?? '#5c5c5c',
            values: series.map((day) => day.blockedBySecondLayer),
          },
        ]}
        format={count}
        formatTick={compactCount}
        counts
        empty={`最近 ${days} 天没有拦下消息。`}
      />
      <LineChart
        {...shared}
        title="每天在大模型上花了多少钱，花在哪些用途上？"
        series={lines<LlmPurpose>(series, PURPOSE_NAMES, (day, purpose) => day.costByPurpose[purpose])}
        format={preciseYuan}
        formatTick={tickYuan}
        counts={false}
        empty={`最近 ${days} 天大模型没有花钱。`}
      />
    </div>
  )
}

/** Whether every number of the series is zero: there is nothing to draw. */
function blank(series: SeriesDay[]): boolean {
  return series.every(
    (day) =>
      day.chat === 0 &&
      [
        ...Object.values(day.dauBySlot),
        ...Object.values(day.blockedByCategory),
        day.blockedBySecondLayer,
        ...Object.values(day.costByPurpose),
      ].every((value) => value === 0),
  )
}

export function Data({ onGoReview }: { onGoReview: () => void }) {
  const [days, setDays] = useState<StatsDays>(7)
  const stats = useLoad<DailyStats>(dailyStatsPath(days))
  const rangeId = useId()

  if (stats.data === undefined) {
    return (
      <Card>
        {stats.error !== undefined ? (
          <Failed what="学校数据" reason={stats.error.message} retry={stats.reload} />
        ) : (
          <Loading what="学校数据" />
        )}
      </Card>
    )
  }

  const data = stats.data
  const shown = data.series.length
  return (
    <div className="space-y-8">
      <Today stats={data} reading={stats.loading} onUpdate={stats.reload} />
      <Yesterday stats={data} />
      <Reminders stats={data} onGoReview={onGoReview} />
      <section aria-labelledby={rangeId}>
        <div className="flex items-center justify-between gap-4">
          <h2 id={rangeId} className="text-base font-semibold text-gray-900">
            最近 {shown} 天
          </h2>
          <Segmented<StatsDays>
            // The group itself takes focus but does nothing with keys; its radio buttons do, so they are the one stop.
            tabIndex={-1}
            aria-label="看最近几天"
            options={RANGES.map((range) => ({ label: `${range} 天`, value: range }))}
            value={days}
            onChange={setDays}
          />
        </div>
        {stats.loading && (
          <p className="mt-2 text-sm text-gray-600" role="status">
            正在读取最近 {days} 天的数据，下面先留着最近 {shown} 天的。
          </p>
        )}
        <div className="mt-4">
          {stats.error !== undefined ? (
            <Card>
              <Failed what={`最近 ${days} 天的数据`} reason={stats.error.message} retry={stats.reload} />
            </Card>
          ) : (
            // While another range is read, the curves of the last one stay, their lines dimmed (the words keep their
            // contrast).
            <div className={stats.loading ? 'stale' : undefined} aria-busy={stats.loading}>
              {blank(data.series) ? (
                <Card>
                  <Empty why={`最近 ${shown} 天还没有数据。学校开学后，第二天这里会出现第一组数字。`} />
                </Card>
              ) : (
                <Charts stats={data} />
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
