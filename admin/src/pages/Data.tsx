import { Button, Segmented } from 'antd'
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
const LINE_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6']
const RANGES: StatsDays[] = [7, 30, 90]

const compactCount = (value: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact' }).format(value)
const tickYuan = (value: number) => `¥${Number(value.toPrecision(6))}`

type Counted = Exclude<keyof DayNumbers, 'date' | 'dauBySlot' | 'blockedByCategory'>

const TILES: { key: Counted; label: string; format: (value: number) => string }[] = [
  { key: 'dau', label: '来上课的学生', format: count },
  { key: 'chat', label: '聊天消息', format: count },
  { key: 'blocked', label: '拦下的消息', format: count },
  { key: 'violations', label: '违反校规', format: count },
  { key: 'suspensions', label: '停课', format: count },
  { key: 'expulsions', label: '开除', format: count },
  { key: 'registrations', label: '新报名', format: count },
  { key: 'costYuan', label: '大模型花费', format: yuan },
]

/** How a number compares with the same day a week before, in words. */
function change(now: number, before: number | undefined, weekday: string, format: (value: number) => string) {
  if (before === undefined) return `上${weekday}学校还没开学`
  const diff = Math.round((now - before) * 100) / 100
  if (diff === 0) return `和上${weekday}一样`
  return `比上${weekday}${diff > 0 ? '多' : '少'} ${format(Math.abs(diff))}`
}

/** A day's numbers in a row of tiles, each with its change; the month's spend goes with the day that has `month`. */
function Tiles(props: { labelId: string; day: DayNumbers; before: DayNumbers | null; month?: DailyStats['month'] }) {
  const { labelId, day, before, month } = props
  const weekday = weekdayOf(day.date)
  return (
    <div className="tiles">
      {TILES.map((tile) => (
        <div key={tile.key} className="tile" role="group" aria-labelledby={`${labelId}-${tile.key}`}>
          <p id={`${labelId}-${tile.key}`} className="tile-label">
            {tile.label}
          </p>
          <p className="tile-value">{tile.format(day[tile.key])}</p>
          <p className="tile-change">{change(day[tile.key], before?.[tile.key], weekday, tile.format)}</p>
          {tile.key === 'costYuan' && month !== undefined && (
            <p className="tile-change">
              本月 {yuan(month.costYuan)}，预算 {yuan(month.budgetYuan)}
            </p>
          )}
        </div>
      ))}
    </div>
  )
}

/** Why no class is held today, when none is; undefined on a school day. */
function noClass(status: DailyStats['todayStatus'], weekday: string): string | undefined {
  if (status.state === 'not_started') return '学校还没开学，今天不上课。'
  if (status.state === 'on_break') return `今天放假${status.breakName === null ? '' : `（${status.breakName}）`}，不上课。`
  if (!status.schoolDay) return `今天是${weekday}，周末不上课。`
  if (status.maintenance) return '现在维护中：上课服务不让任何人进，碰上维护的时段今天不上课。'
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
    <section className="panel" aria-labelledby={titleId}>
      <div className="panel-head">
        <h2 id={titleId} className="panel-title">
          今天（截至 {time}），{dayName(todaySoFar.date)}
        </h2>
        {/* It stays enabled while it reads (a disabled button would lose the focus); a second click waits. */}
        <Button onClick={() => !reading && onUpdate()}>{reading ? '正在更新' : '更新到现在'}</Button>
      </div>
      {(against !== undefined || why !== undefined) && (
        <p className="day-note">
          {against}
          {why}
        </p>
      )}
      <Tiles labelId={titleId} day={todaySoFar} before={sameTimeLastWeek} month={month} />
    </section>
  )
}

function Yesterday({ stats }: { stats: DailyStats }) {
  const titleId = useId()
  const { yesterday, sameDayLastWeek } = stats
  return (
    <section className="panel" aria-labelledby={titleId}>
      <h2 id={titleId} className="panel-title">
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
    <section className="panel reminders" aria-label="要处理的事">
      {/* Only failures that lasted into a new day are listed: a fresh one is still being retried. */}
      {nothing && <p>现在没有要处理的事：开门前要审的课都审完了，没有一直生成不出来的课，本月花费也没超预算。</p>}
      {unreviewed.length > 0 && (
        <div className="reminder reminder-review">
          <div>
            <p>{unreviewed.length} 节课要在开门前审完，不然那一天改上自习：</p>
            <ul className="reminder-days">
              {[...days].map(([date, day]) => (
                <li key={date}>
                  {dayName(date)}
                  {clockTime(day.deadline, stats.timeZone)} 开门：{day.divisions.join('、')}
                </li>
              ))}
            </ul>
          </div>
          <Button type="primary" onClick={onGoReview}>
            去审课
          </Button>
        </div>
      )}
      {generationFailed.map((failure) => (
        <p key={`${failure.date}-${failure.division}`} className="reminder">
          {`${dayName(failure.date)}${DIVISION_NAMES[failure.division]}的课没生成出来，试了 ${failure.attempts} 次，`}
          {`最后一次的原因：${sentence(failure.lastError)}`}
          {failure.date === stats.today
            ? '今天的课系统不会再生成了：要今天上这节课，到审课页手动粘贴，赶在开门前审过。'
            : '系统会接着重试；等不及的话，到审课页手动粘贴。'}
        </p>
      ))}
      {month.overBudget && (
        <p className="reminder reminder-alarm">
          {`本月大模型花费 ${yuan(month.costYuan)}，超过了预算 ${yuan(month.budgetYuan)}。`}
          大模型照常在用，不会自动停；要少花钱，到开关页关掉暂时不用的功能。
        </p>
      )}
    </section>
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
      <div className="panel">
        {stats.error !== undefined ? (
          <Failed what="学校数据" reason={stats.error.message} retry={stats.reload} />
        ) : (
          <Loading what="学校数据" />
        )}
      </div>
    )
  }

  const data = stats.data
  const shown = data.series.length
  return (
    <div className="page">
      <Today stats={data} reading={stats.loading} onUpdate={stats.reload} />
      <Yesterday stats={data} />
      <Reminders stats={data} onGoReview={onGoReview} />
      <section className="range" aria-labelledby={rangeId}>
        <div className="panel-head">
          <h2 id={rangeId} className="panel-title">
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
          <p className="range-loading" role="status">
            正在读取最近 {days} 天的数据，下面先留着最近 {shown} 天的。
          </p>
        )}
        {stats.error !== undefined ? (
          <div className="panel">
            <Failed what={`最近 ${days} 天的数据`} reason={stats.error.message} retry={stats.reload} />
          </div>
        ) : (
          // While another range is read, the curves of the last one stay, their lines dimmed (the words keep their
          // contrast).
          <div className={stats.loading ? 'stale' : undefined} aria-busy={stats.loading}>
            {blank(data.series) ? (
              <div className="panel">
                <Empty why={`最近 ${shown} 天还没有数据。学校开学后，第二天这里会出现第一组数字。`} />
              </div>
            ) : (
              <Charts stats={data} />
            )}
          </div>
        )}
      </section>
    </div>
  )
}
