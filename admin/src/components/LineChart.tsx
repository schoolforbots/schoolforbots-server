import { Button, Table } from 'antd'
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { dayName, shortDayName } from '../labels.js'
import { Empty } from './States.js'

// A daily line chart drawn in SVG: thin lines on hairline gridlines, a legend when there is more than one line and
// the names again at the line ends, a vertical line on each day a runtime switch changed, a readout of one day's
// numbers that follows the pointer or the arrow keys, and the same numbers as a table.

export interface Series {
  key: string
  name: string
  color: string
  /** One per date. */
  values: number[]
}

/** Something that happened on a day, drawn as a vertical line and listed in that day's readout. */
export interface Marker {
  date: string
  text: string
}

interface LineChartProps {
  /** The question the chart answers. */
  title: string
  /** `YYYY-MM-DD`, oldest first. */
  dates: string[]
  series: Series[]
  markers: Marker[]
  /** A value as the readout and the table show it. */
  format: (value: number) => string
  /** A value on the y axis. */
  formatTick: (value: number) => string
  /** Whether the values are counts: the axis then steps by whole numbers. */
  counts: boolean
  /** What to say instead of drawing, when every value is zero. */
  empty: string
}

const HEIGHT = 232
const MARGIN = { top: 12, bottom: 28, left: 56 }
/** Room for the names at the line ends. */
const NAMES_WIDTH = 84
/** Line height of a 12px name: the names at the ends never touch. */
const LABEL_GAP = 17
const INK = { tick: '#5c5c5c', label: '#1f1f1f', grid: '#e8e7e1', base: '#b9b8ae', marker: '#767676', guide: '#a3a29a' }

/** Ticks from zero to a round number at or above `max`, about four steps. */
function axisTicks(max: number, counts: boolean): number[] {
  if (max <= 0) return [0, 1]
  const rough = max / 4
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  let step = [1, 2, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= rough) ?? 10 * magnitude
  if (counts) step = Math.max(1, Math.round(step))
  const steps = Math.ceil(max / step - 1e-9)
  return Array.from({ length: steps + 1 }, (_, i) => Number((i * step).toPrecision(12)))
}

/** Where the names at the line ends go: as close to each end as they can be, `gap` apart, between top and bottom. */
function placeLabels(wanted: number[], gap: number, top: number, bottom: number): number[] {
  const order = wanted.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y)
  const ys = order.map((entry) => entry.y)
  const at = (k: number) => ys[k] ?? 0
  // Down from the top one, each at least `gap` below the one above; then up from the bottom one, only as far as
  // the bottom needs; then down again where that pushed them above the top.
  for (let k = 1; k < ys.length; k++) ys[k] = Math.max(at(k), at(k - 1) + gap)
  for (let k = ys.length - 1; k >= 0; k--) ys[k] = Math.min(at(k), k === ys.length - 1 ? bottom : at(k + 1) - gap)
  for (let k = 0; k < ys.length; k++) ys[k] = Math.max(at(k), k === 0 ? top : at(k - 1) + gap)
  const result = new Array<number>(wanted.length)
  order.forEach((entry, k) => (result[entry.i] = at(k)))
  return result
}

function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(fallback)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined && entry.contentRect.width > 0) setWidth(Math.round(entry.contentRect.width))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

export function LineChart({ title, dates, series, markers, format, formatTick, counts, empty }: LineChartProps) {
  const titleId = useId()
  const [asTable, setAsTable] = useState(false)
  const hasData = series.some((line) => line.values.some((value) => value !== 0))
  const markerDates = new Set(markers.map((marker) => marker.date).filter((date) => dates.includes(date)))
  const several = series.length > 1

  return (
    <figure className="chart" aria-labelledby={titleId}>
      <div className="chart-head">
        <h3 id={titleId} className="chart-title">
          {title}
        </h3>
        {hasData && (
          <Button type="link" size="small" onClick={() => setAsTable(!asTable)}>
            {asTable ? '用折线图看' : '用表格看'}
          </Button>
        )}
      </div>
      {!hasData ? (
        <Empty why={empty} />
      ) : (
        <>
          {(several || markerDates.size > 0) && (
            <ul className="chart-legend" aria-label="图例">
              {several &&
                series.map((line) => (
                  <li key={line.key}>
                    <span className="legend-line" style={{ background: line.color }} aria-hidden="true" />
                    {line.name}
                  </li>
                ))}
              {markerDates.size > 0 && (
                <li>
                  <span className="legend-marker" aria-hidden="true" />
                  竖线：切换过开关的日子
                </li>
              )}
            </ul>
          )}
          {asTable ? (
            <DayTable title={title} dates={dates} series={series} markers={markers} format={format} />
          ) : (
            <Plot
              title={title}
              dates={dates}
              series={series}
              markers={markers}
              markerDates={markerDates}
              format={format}
              formatTick={formatTick}
              counts={counts}
              namesAtEnds={several}
            />
          )}
        </>
      )}
    </figure>
  )
}

interface PlotProps {
  title: string
  dates: string[]
  series: Series[]
  markers: Marker[]
  markerDates: Set<string>
  format: (value: number) => string
  formatTick: (value: number) => string
  counts: boolean
  namesAtEnds: boolean
}

function Plot({ title, dates, series, markers, markerDates, format, formatTick, counts, namesAtEnds }: PlotProps) {
  const [box, width] = useWidth(560)
  // The day the keyboard is on (while the chart has the focus) and the day under the pointer; the pointer's shows
  // while it is over the plot, and leaving the plot gives the readout back to the keyboard.
  const [keyed, setKeyed] = useState<number | null>(null)
  const [pointed, setPointed] = useState<number | null>(null)
  const active = pointed ?? keyed
  const readoutId = useId()

  const n = dates.length
  const right = namesAtEnds ? NAMES_WIDTH : 16
  const plotWidth = Math.max(width - MARGIN.left - right, 1)
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom
  const bottom = MARGIN.top + plotHeight
  const ticks = axisTicks(Math.max(...series.flatMap((line) => line.values)), counts)
  const top = ticks[ticks.length - 1] ?? 1
  const x = (i: number) => MARGIN.left + (n === 1 ? plotWidth / 2 : (i * plotWidth) / (n - 1))
  const y = (value: number) => bottom - (value / top) * plotHeight
  const crisp = (v: number) => Math.round(v) + 0.5

  // A date label every few days, counted back from yesterday so the last day always has one.
  const every = Math.ceil(n / 7)
  const dateTicks = dates.map((_, i) => i).filter((i) => (n - 1 - i) % every === 0)

  const last = n - 1
  const ends = series.map((line) => y(line.values[last] ?? 0))
  const labelYs = namesAtEnds ? placeLabels(ends, LABEL_GAP, MARGIN.top + 6, bottom - 2) : []

  function pick(event: PointerEvent<SVGRectElement>) {
    const left = event.currentTarget.ownerSVGElement?.getBoundingClientRect().left ?? 0
    const at = (event.clientX - left - MARGIN.left) / plotWidth
    setPointed(Math.min(last, Math.max(0, Math.round(at * (n - 1)))))
  }

  function step(event: KeyboardEvent<HTMLDivElement>) {
    const current = active ?? last
    let next: number | null
    switch (event.key) {
      case 'ArrowLeft':
        next = Math.max(0, current - 1)
        break
      case 'ArrowRight':
        next = Math.min(last, current + 1)
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = last
        break
      case 'Escape':
        next = null
        break
      default:
        return
    }
    event.preventDefault()
    setKeyed(next)
    setPointed(null)
  }

  const activeDate = active === null ? undefined : dates[active]
  const readoutLeft = active === null ? 0 : x(active)
  const flip = readoutLeft > width / 2

  return (
    <div
      ref={box}
      className="chart-plot"
      tabIndex={0}
      role="group"
      aria-label={`${title}，用左右方向键逐天查看`}
      aria-describedby={readoutId}
      onFocus={() => setKeyed((current) => current ?? last)}
      onBlur={() => setKeyed(null)}
      onKeyDown={step}
    >
      <svg width={width} height={HEIGHT} aria-hidden="true">
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={MARGIN.left}
              x2={MARGIN.left + plotWidth}
              y1={crisp(y(tick))}
              y2={crisp(y(tick))}
              stroke={tick === 0 ? INK.base : INK.grid}
              shapeRendering="crispEdges"
            />
            <text x={MARGIN.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle" fill={INK.tick}>
              {formatTick(tick)}
            </text>
          </g>
        ))}
        {dateTicks.map((i) => {
          const [, month, day] = (dates[i] ?? '').split('-').map(Number)
          return (
            <text key={i} x={x(i)} y={bottom + 18} textAnchor="middle" fill={INK.tick}>
              {month}/{day}
            </text>
          )
        })}
        {dates.map((date, i) =>
          markerDates.has(date) ? (
            <line
              key={date}
              className="chart-marker"
              x1={crisp(x(i))}
              x2={crisp(x(i))}
              y1={MARGIN.top}
              y2={bottom}
              stroke={INK.marker}
              shapeRendering="crispEdges"
            />
          ) : null,
        )}
        {active !== null && (
          <line x1={crisp(x(active))} x2={crisp(x(active))} y1={MARGIN.top} y2={bottom} stroke={INK.guide} />
        )}
        {series.map((line) => (
          <path
            key={line.key}
            className="chart-line"
            d={line.values
              .map((value, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(value).toFixed(1)}`)
              .join(' ')}
            fill="none"
            stroke={line.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {series.map((line) => (
          // The end of each line, or the day the readout shows.
          <circle
            key={line.key}
            className="chart-line"
            cx={x(active ?? last)}
            cy={y(line.values[active ?? last] ?? 0)}
            r={4}
            fill={line.color}
            stroke="#ffffff"
            strokeWidth={2}
          />
        ))}
        {namesAtEnds &&
          series.map((line, k) => {
            const end = ends[k] ?? 0
            const label = labelYs[k] ?? end
            const moved = Math.abs(label - end) > 1
            return (
              <g key={line.key}>
                {moved && <line x1={x(last) + 6} y1={end} x2={x(last) + 14} y2={label} stroke={INK.guide} />}
                <text x={x(last) + 16} y={label} dominantBaseline="middle" fill={INK.label}>
                  {line.name}
                </text>
              </g>
            )
          })}
        <rect
          x={MARGIN.left}
          y={MARGIN.top}
          width={plotWidth}
          height={plotHeight}
          fill="transparent"
          onPointerMove={pick}
          onPointerLeave={() => setPointed(null)}
        />
      </svg>
      {/* A live region: always in the page, so a day read out is announced; out of sight while it shows none. */}
      <div
        id={readoutId}
        role="status"
        className={activeDate === undefined ? 'chart-readout visually-hidden' : 'chart-readout'}
        style={{ left: readoutLeft, transform: flip ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)' }}
      >
        {activeDate !== undefined && active !== null && (
          <>
            <p className="readout-date">{dayName(activeDate)}</p>
            <ul>
              {series.map((line) => (
                <li key={line.key}>
                  <span className="readout-key" style={{ background: line.color }} aria-hidden="true" />
                  <strong>{format(line.values[active] ?? 0)}</strong>
                  <span className="readout-name">{line.name}</span>
                </li>
              ))}
            </ul>
            {markerDates.has(activeDate) && (
              <div className="readout-markers">
                {markers
                  .filter((marker) => marker.date === activeDate)
                  .map((marker, i) => (
                    <p key={i}>{marker.text}</p>
                  ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

interface DayTableProps {
  title: string
  dates: string[]
  series: Series[]
  markers: Marker[]
  format: (value: number) => string
}

/** The chart's numbers, one row a day, newest first. */
function DayTable({ title, dates, series, markers, format }: DayTableProps) {
  const withSwitches = markers.some((marker) => dates.includes(marker.date))
  const rows = dates
    .map((date, i) => ({
      date,
      values: series.map((line) => line.values[i] ?? 0),
      switches: markers
        .filter((marker) => marker.date === date)
        .map((marker) => marker.text)
        .join('；'),
    }))
    .reverse()
  const columns = [
    { key: 'date', title: '日期', render: (_: unknown, row: (typeof rows)[number]) => shortDayName(row.date) },
    ...series.map((line, k) => ({
      key: line.key,
      title: line.name,
      align: 'right' as const,
      render: (_: unknown, row: (typeof rows)[number]) => format(row.values[k] ?? 0),
    })),
    ...(withSwitches ? [{ key: 'switches', title: '切换开关', dataIndex: 'switches' }] : []),
  ]
  return (
    <div className="chart-table" tabIndex={0} role="region" aria-label={`${title}：每天的数字`}>
      <Table size="small" pagination={false} rowKey="date" columns={columns} dataSource={rows} />
    </div>
  )
}
