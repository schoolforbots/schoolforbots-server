import { useId, useState } from 'react'
import { doudizhuPath, useLoad, type ClubDay, type ClubKey, type ClubStudent, type DoudizhuPage, type StatsDays } from '../api.js'
import { LineChart, type Series } from '../components/LineChart.js'
import { Empty, Failed, Loading } from '../components/States.js'
import { CELL, DataTable, NUM, NumberTable, ROW_HEAD } from '../components/Tables.js'
import { clockTime, count, dayName, percent, weekdayOf, weekMoment } from '../labels.js'
import { Badge, Button, Card, PageActions, Segmented, Tip, type Tone } from '../ui.js'

// The clubs page: a tab for each club, since each has numbers of its own. Doudizhu's: today so far and yesterday next
// to the same day a week before, the daily curves of the last 7, 30 or 90 days up to yesterday, and this week's board
// and what to look into. Every number comes from `api/clubs/doudizhu`, every time on the school's clock.

/** The clubs, in the order of the tabs. A new club needs its own tab here and its own numbers below. */
const CLUBS: { key: ClubKey; name: string }[] = [{ key: 'doudizhu', name: '斗地主社' }]
const RANGES: StatsDays[] = [7, 30, 90]
// The first colours of the school-data page's charts.
const LINE_COLORS = ['#167d8d', '#f59e0b', '#10b981']

const compactCount = (value: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact' }).format(value)

type Counted = 'games' | 'players' | 'newMembers'
const TILES: { key: Counted; label: string }[] = [
  { key: 'games', label: '对局' },
  { key: 'players', label: '下场的学生' },
  { key: 'newMembers', label: '新入社' },
]

/** How a number compares with the same day a week before, in words. */
function change(now: number, before: number, weekday: string) {
  if (now === before) return `和上${weekday}一样`
  return `比上${weekday}${now > before ? '多' : '少'} ${count(Math.abs(now - before))}`
}

/** A day's numbers next to the same day a week before; `members` adds the members now. */
function Tiles({ labelId, day, before, members }: { labelId: string; day: ClubDay; before: ClubDay; members?: number }) {
  const weekday = weekdayOf(day.date)
  return (
    <div className="mt-4 grid grid-cols-4 gap-4">
      {TILES.map((tile) => {
        const now = day[tile.key]
        const then = before[tile.key]
        const tone: Tone = now === then ? 'gray' : now > then ? 'green' : 'red'
        return (
          <article
            key={tile.key}
            className="flex flex-col gap-3 lift rounded-lg border border-gray-200 bg-white p-5"
            role="group"
            aria-labelledby={`${labelId}-${tile.key}`}
          >
            <div className="flex items-start justify-between gap-2">
              <strong id={`${labelId}-${tile.key}`} className="block text-sm font-medium text-gray-600">
                {tile.label}
              </strong>
              <Badge tone={tone} className="rounded-sm px-1.5">
                {change(now, then, weekday)}
              </Badge>
            </div>
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-2xl font-medium text-gray-900 tabular-nums">{count(now)}</span>
              <span className="text-xs text-gray-600">
                上{weekday} {count(then)}
              </span>
            </p>
            {tile.key === 'games' && (
              <p className="-mt-2 text-xs text-gray-600">其中有机器人补位的 {count(day.games - day.rankedGames)} 局</p>
            )}
          </article>
        )
      })}
      {members !== undefined && (
        <article
          className="flex flex-col gap-3 lift rounded-lg border border-gray-200 bg-white p-5"
          role="group"
          aria-labelledby={`${labelId}-members`}
        >
          <div className="flex items-center gap-2">
            <strong id={`${labelId}-members`} className="block text-sm font-medium text-gray-600">
              现在的社员
            </strong>
            <Tip about="现在的社员">退社会删掉记录，所以退社人数算不出来。</Tip>
          </div>
          <span className="text-2xl font-medium text-gray-900 tabular-nums">{count(members)}</span>
        </article>
      )}
    </div>
  )
}

const studentName = (student: ClubStudent) =>
  student.className === null ? student.displayName : `${student.displayName}（${student.className}）`

function Board({ page }: { page: DoudizhuPage }) {
  const { board } = page.week
  const more = board.total - board.entries.length
  return (
    <Card
      title={`本周积分榜（${dayName(page.week.startsOn)}起）`}
      description="只算没有机器人的对局。名次和学生看到的榜一样：同分同名次。"
    >
      {board.total === 0 ? (
        <Empty why="本周还没有社员下过没有机器人的对局。" />
      ) : (
        <div className="mt-4">
          <p className="mb-2 text-sm text-gray-600">
            {`共 ${count(board.total)} 位社员本周下过没有机器人的对局${more > 0 ? `，这里列前 ${board.entries.length} 位` : ''}。`}
          </p>
          <DataTable caption="本周积分榜" quietCaption head={['名次', '学生', '班级', '积分', '对局']} numeric={[0, 3, 4]}>
            {board.entries.map((entry) => (
              <tr key={entry.studentId}>
                <td className={NUM}>{entry.rank}</td>
                <th scope="row" className={ROW_HEAD}>
                  {entry.displayName}
                </th>
                <td className={CELL}>{entry.className}</td>
                <td className={NUM}>{count(entry.points)}</td>
                <td className={NUM}>{count(entry.games)}</td>
              </tr>
            ))}
          </DataTable>
        </div>
      )}
    </Card>
  )
}

function Conduct({ page }: { page: DoudizhuPage }) {
  const { conduct } = page.week
  const share = (seats: number) => (conduct.seats === 0 ? '' : `，占 ${percent(seats / conduct.seats)}`)
  return (
    <Card
      title="本周的超时、托管和违规出牌"
      description="一个学生下一局算一个座位。超时多、托管多，多半是插件或网络出了问题；违规出牌多，可能是插件没按规则出牌。"
    >
      <div className="mt-4">
        <NumberTable
          caption="本周的超时、托管和违规出牌"
          rows={[
            ['学生座位', count(conduct.seats)],
            ['超时过的座位', `${count(conduct.timedOut.seats)}${share(conduct.timedOut.seats)}，共超时 ${count(conduct.timedOut.times)} 次`],
            ['被托管出过牌的座位', `${count(conduct.trustee.seats)}${share(conduct.trustee.seats)}，托管出了 ${count(conduct.trustee.moves)} 手`],
            ['出过违规牌的座位', `${count(conduct.illegal.seats)}${share(conduct.illegal.seats)}，共 ${count(conduct.illegal.moves)} 手`],
          ]}
        />
      </div>
    </Card>
  )
}

function SameAddress({ page }: { page: DoudizhuPage }) {
  const { sameAddress } = page.week
  const more = sameAddress.total - sameAddress.games.length
  return (
    <Card
      title="本周同一个网络地址坐了两个座位的对局"
      description="同一个地址可能是一家人或同一个网络，只供参考，要结合同桌次数一起看；地址本身不显示。"
    >
      {sameAddress.total === 0 ? (
        <Empty why="本周没有这样的对局。" />
      ) : (
        <div className="mt-4">
          {more > 0 && (
            <p className="mb-2 text-sm text-gray-600">{`共 ${count(sameAddress.total)} 局，这里列最近 ${sameAddress.games.length} 局。`}</p>
          )}
          <DataTable caption="同一个网络地址的对局" quietCaption wide head={['局号', '结束时间', '机器人', '同一个地址的学生']} numeric={[0]}>
            {sameAddress.games.map((game) => (
              <tr key={game.gameId}>
                <td className={NUM}>{game.gameId}</td>
                <td className={CELL}>{weekMoment(game.endedAt, page.timeZone)}</td>
                <td className={CELL}>{game.ranked ? '没有' : '有'}</td>
                <td className={CELL}>{game.students.map(studentName).join('、')}</td>
              </tr>
            ))}
          </DataTable>
        </div>
      )}
    </Card>
  )
}

function Pairs({ page }: { page: DoudizhuPage }) {
  const { pairs } = page.week
  return (
    <Card
      title="本周同桌最多的学生"
      description="只算没有机器人的对局。两人常坐一桌、积分总是一个涨一个跌，可能是在刷分。"
    >
      {pairs.length === 0 ? (
        <Empty why="本周还没有没有机器人的对局。" />
      ) : (
        <div className="mt-4">
          <DataTable caption="同桌最多的学生" quietCaption wide head={['学生', '另一位学生', '同桌对局', '各自得分']} numeric={[2, 3]}>
            {pairs.map((pair) => (
              <tr key={`${pair.students[0].studentId}-${pair.students[1].studentId}`}>
                <td className={CELL}>{studentName(pair.students[0])}</td>
                <td className={CELL}>{studentName(pair.students[1])}</td>
                <td className={NUM}>{count(pair.games)}</td>
                <td className={NUM}>
                  {count(pair.points[0])} / {count(pair.points[1])}
                </td>
              </tr>
            ))}
          </DataTable>
        </div>
      )}
    </Card>
  )
}

function Charts({ series }: { series: ClubDay[] }) {
  const days = series.length
  const dates = series.map((day) => day.date)
  const line = (key: string, name: string, k: number, values: number[]): Series => ({
    key,
    name,
    color: LINE_COLORS[k] ?? '#5c5c5c',
    values,
  })
  const shared = { dates, markers: [], format: count, formatTick: compactCount, counts: true }
  return (
    <div className="charts">
      <LineChart
        {...shared}
        title="每天下了多少局？"
        series={[
          line('ranked', '没有机器人', 0, series.map((day) => day.rankedGames)),
          line('bots', '有机器人补位', 1, series.map((day) => day.games - day.rankedGames)),
        ]}
        empty={`最近 ${days} 天没有对局。`}
      />
      <LineChart
        {...shared}
        title="每天有多少学生下场？"
        series={[line('players', '下场的学生', 0, series.map((day) => day.players))]}
        empty={`最近 ${days} 天没有学生下场。`}
      />
      <LineChart
        {...shared}
        title="每天有多少学生入社？"
        series={[line('newMembers', '新入社', 0, series.map((day) => day.newMembers))]}
        empty={`最近 ${days} 天没有学生入社。`}
      />
    </div>
  )
}

function Doudizhu() {
  const [days, setDays] = useState<StatsDays>(7)
  const page = useLoad<DoudizhuPage>(doudizhuPath(days))
  const todayId = useId()
  const yesterdayId = useId()
  const rangeId = useId()

  if (page.data === undefined) {
    return (
      <Card>
        {page.error !== undefined ? (
          <Failed what="斗地主社的数据" reason={page.error.message} retry={page.reload} />
        ) : (
          <Loading what="斗地主社的数据" />
        )}
      </Card>
    )
  }

  const data = page.data
  const time = clockTime(data.asOf, data.timeZone)
  const weekday = weekdayOf(data.todaySoFar.date)
  const shown = data.series.length
  const blank = data.series.every((day) => day.games === 0 && day.players === 0 && day.newMembers === 0)
  return (
    <div className="space-y-6">
      <PageActions>
        <Button type="primary" onClick={() => !page.loading && page.reload()}>
          {page.loading ? '正在更新' : '更新到现在'}
        </Button>
      </PageActions>
      {!data.enabled && (
        <p className="rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-900" role="status">
          社团现在关着（配置里的 club.enabled 是 false），学生进不了社团。
        </p>
      )}
      <section aria-labelledby={todayId}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id={todayId} className="text-xl font-bold text-gray-900">
            今天（截至 {time}），{dayName(data.todaySoFar.date)}
          </h2>
          <Tip about="今天的数字" className="self-center">
            {`从今天零点数到 ${time}，和上${weekday}零点到 ${time} 的数字比。`}
          </Tip>
        </div>
        <Tiles labelId={todayId} day={data.todaySoFar} before={data.sameTimeLastWeek} members={data.members} />
      </section>
      <section aria-labelledby={yesterdayId}>
        <h2 id={yesterdayId} className="text-xl font-bold text-gray-900">
          昨天，{dayName(data.yesterday.date)}
        </h2>
        <Tiles labelId={yesterdayId} day={data.yesterday} before={data.sameDayLastWeek} />
      </section>
      <Board page={data} />
      <Pairs page={data} />
      <SameAddress page={data} />
      <Conduct page={data} />
      <section aria-labelledby={rangeId}>
        <div className="flex items-center justify-between gap-4">
          <h2 id={rangeId} className="text-xl font-bold text-gray-900">
            最近 {shown} 天
          </h2>
          <Segmented<StatsDays>
            tabIndex={-1}
            aria-label="看最近几天"
            options={RANGES.map((range) => ({ label: `${range} 天`, value: range }))}
            value={days}
            onChange={setDays}
          />
        </div>
        {page.loading && (
          <p className="mt-2 text-sm text-gray-600" role="status">
            正在读取最近 {days} 天的数据，下面先留着最近 {shown} 天的。
          </p>
        )}
        <div className="mt-4">
          {page.error !== undefined ? (
            <Card>
              <Failed what={`最近 ${days} 天的数据`} reason={page.error.message} retry={page.reload} />
            </Card>
          ) : (
            <div className={page.loading ? 'stale' : undefined} aria-busy={page.loading}>
              {blank ? (
                <Card>
                  <Empty why={`最近 ${shown} 天斗地主社还没有数据。`} />
                </Card>
              ) : (
                <Charts series={data.series} />
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

export function Clubs() {
  const [club, setClub] = useState<ClubKey>('doudizhu')
  return (
    <div className="space-y-6">
      <Segmented<ClubKey>
        aria-label="看哪个社团"
        options={CLUBS.map((one) => ({ label: one.name, value: one.key }))}
        value={club}
        onChange={setClub}
      />
      <div key={club}>{club === 'doudizhu' && <Doudizhu />}</div>
    </div>
  )
}
