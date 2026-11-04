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
  dayName,
  DIVISION_NAMES,
  localDay,
  PURPOSE_NAMES,
  SLOT_NAMES,
  SWITCH_NAMES,
  weekdayOf,
} from '../labels.js'

// The school data page: yesterday's numbers next to the same day a week before, what needs doing, and the daily
// curves of the last 7, 30 or 90 days. Every number on it comes from `api/stats/daily`.

/** The categorical colours of the charts, in this order; the green and red of the pages never draw a line. */
const LINE_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6']
const RANGES: StatsDays[] = [7, 30, 90]

const count = (value: number) => value.toLocaleString('zh-CN')
const yuan = (value: number) => `¥${value.toFixed(2)}`
/** Up to the 4 decimal places the series has, but at least fen. */
const preciseYuan = (value: number) => `¥${value.toFixed(4).replace(/(\.\d\d[1-9]*)0+$/, '$1')}`
const compactCount = (value: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact' }).format(value)
const tickYuan = (value: number) => `¥${Number(value.toPrecision(6))}`

/** A text that ends a sentence, with the full stop it may lack. */
const sentence = (text: string) => (/[。！？.!?]$/.test(text) ? text : `${text}。`)

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

function Yesterday({ stats }: { stats: DailyStats }) {
  const titleId = useId()
  const { yesterday, sameDayLastWeek, month } = stats
  const weekday = weekdayOf(yesterday.date)
  return (
    <section className="panel" aria-labelledby={titleId}>
      <h2 id={titleId} className="panel-title">
        昨天，{dayName(yesterday.date)}
      </h2>
      <div className="tiles">
        {TILES.map((tile) => (
          <div key={tile.key} className="tile" role="group" aria-labelledby={`${titleId}-${tile.key}`}>
            <p id={`${titleId}-${tile.key}`} className="tile-label">
              {tile.label}
            </p>
            <p className="tile-value">{tile.format(yesterday[tile.key])}</p>
            <p className="tile-change">
              {change(yesterday[tile.key], sameDayLastWeek?.[tile.key], weekday, tile.format)}
            </p>
            {tile.key === 'costYuan' && (
              <p className="tile-change">
                本月 {yuan(month.costYuan)}，预算 {yuan(month.budgetYuan)}
              </p>
            )}
          </div>
        ))}
      </div>
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
      {nothing && <p>现在没有要处理的事：开门前要审的课都审完了，没有生成失败的课，本月花费也没超预算。</p>}
      {unreviewed.length > 0 && (
        <div className="reminder reminder-review">
          <div>
            <p>{unreviewed.length} 节课要在开门前审完，不然那一天改上自习：</p>
            <ul className="reminder-days">
              {[...days].map(([date, day]) => (
                <li key={date}>
                  {dayName(date)}
                  {clockTime(day.deadline)} 开门：{day.divisions.join('、')}
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
          {`最后一次的原因：${sentence(failure.lastError)}系统会接着重试；等不及的话，到审课页手动粘贴。`}
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
    date: localDay(change.at),
    text: `${clockTime(change.at)} ${SWITCH_NAMES[change.name]}：${change.on ? '开' : '关'}`,
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
        series={lines(series, BLOCK_NAMES, (day, category) => day.blockedByCategory[category])}
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
        empty={`最近 ${days} 天没有调用大模型，没有花钱。`}
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
        ...Object.values(day.costByPurpose),
      ].every((value) => value === 0),
  )
}

export function Data({ onGoReview }: { onGoReview: () => void }) {
  const [days, setDays] = useState<StatsDays>(7)
  const stats = useLoad<DailyStats>(dailyStatsPath(days))
  const rangeId = useId()

  if (stats.data === undefined) {
    return stats.error !== undefined ? (
      <Failed what="学校数据" reason={stats.error.message} retry={stats.reload} />
    ) : (
      <Loading what="学校数据" />
    )
  }

  const data = stats.data
  const shown = data.series.length
  return (
    <div className="page">
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
        {stats.error !== undefined ? (
          <div className="panel">
            <Failed what={`最近 ${days} 天的数据`} reason={stats.error.message} retry={stats.reload} />
          </div>
        ) : (
          // While another range is read, the curves of the last one stay, dimmed.
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
