import { Badge, Button, Card, Tip } from '../ui.js'
import { useId, useRef, useState, type ReactNode } from 'react'
import {
  dropRule,
  useLoad,
  weeklyPath,
  WEEKS_PATH,
  type Division,
  type LlmPurpose,
  type Loaded,
  type SuggestedRule,
  type WeeklyPage,
  type WeeklyStats,
} from '../api.js'
import { Confirm } from '../components/Confirm.js'
import { Empty, Failed, Loading } from '../components/States.js'
import { CELL, DataTable, NUM, NumberTable, ROW_HEAD } from '../components/Tables.js'
import { useFocusOnMount } from '../focus.js'
import {
  addDays,
  count,
  dayMoment,
  dayName,
  DIVISION_NAMES,
  percent,
  preciseYuan,
  PURPOSE_NAMES,
  RULE_KIND_NAMES,
  sentence,
  shortDayName,
  weekMoment,
} from '../labels.js'
import { useSchoolZone } from '../zone.js'

// 每周复盘: one week, Monday to Sunday, in the six parts of the review (上课, 课程, 老师, 审核, 学生, 花费), as tables
// and numbers, then every rule dropped so far. A week is reviewed on the Monday after it; until then its numbers are
// counted as they stand and the model's two items are not there yet. Each of the two can also fail on its own, and
// the page says why. Dropping a suggested rule asks first, and then says what it took back.
//
// Drawn as HyperUI's analytics dashboard: a bar with the week picker, a row of stat cards with the week's headline
// numbers, then the six parts as cards, two of the shorter ones side by side, with HyperUI's tables and badges.

/** Whether the week holds nothing at all: no lesson, no message, no spend, and nothing the model made or failed. */
function quiet({ stats, suggestions }: WeeklyPage): boolean {
  if (suggestions !== null && (suggestions.removeRules?.length !== 0 || suggestions.directions?.length !== 0)) {
    return false
  }
  const numbers = [
    ...Object.values(stats.callOn.byDivision).map((division) => division.called),
    stats.questions.total,
    stats.reconnects.length,
    ...Object.values(stats.lessons),
    ...Object.values(stats.teacher),
    ...stats.moderation.byDay.flatMap((day) => [day.sensitive, day.injection, day.privacy, day.secondLayer]),
    stats.moderation.topRules.length,
    stats.moderation.falsePositiveMarks.length,
    stats.moderation.secondLayerChat.length,
    ...Object.values(stats.students),
    ...Object.values(stats.cost.byPurpose),
  ]
  return numbers.every((n) => n === 0)
}

const weekName = (monday: string) => `${dayName(monday)}到 ${dayName(addDays(monday, 6))}`

/** A part of the review: a card named by its heading. */
function Block({
  title,
  description,
  children,
  className,
}: {
  title: string
  /** What the block is, in a tip beside its title. */
  description?: string
  children: ReactNode
  className?: string
}) {
  return (
    <Card title={title} description={description} className={className}>
      <div className="mt-4 space-y-4 text-sm text-gray-700">{children}</div>
    </Card>
  )
}

/** A list under its own heading (what it is, in a tip beside it), or the sentence that says why there is none. */
function Listed({ title, hint, children }: { title: string; hint?: string; children: (titleId: string) => ReactNode }) {
  const titleId = useId()
  return (
    <div className="border-t border-gray-200 pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <h3 id={titleId} className="text-sm font-medium text-gray-900">
          {title}
        </h3>
        {hint !== undefined && <Tip about={title}>{hint}</Tip>}
      </div>
      <div className="mt-3">{children(titleId)}</div>
    </div>
  )
}

/** A headline number of the week, as the template's stat cards. */
function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  const labelId = useId()
  return (
    <article className="flex flex-col gap-1 lift rounded-lg border border-gray-200 bg-white p-5" role="group" aria-labelledby={labelId}>
      <strong id={labelId} className="block text-sm font-medium text-gray-600">
        {label}
      </strong>
      <span className="text-2xl font-medium text-gray-900 tabular-nums">{value}</span>
      <span className="text-xs text-gray-600">{note}</span>
    </article>
  )
}

function Headline({ stats }: { stats: WeeklyStats }) {
  const called = Object.values(stats.callOn.byDivision).reduce((sum, d) => sum + d.called, 0)
  const total = Object.values(stats.cost.byPurpose).reduce((sum, value) => sum + value, 0)
  return (
    <div className="grid grid-cols-4 gap-4" role="region" aria-label="这一周的几个数">
      <Stat
        label="点名回答率"
        value={called === 0 ? '没有点名' : percent(stats.callOn.rate)}
        note={`点名 ${count(called)} 次`}
      />
      <Stat
        label="收到的问题"
        value={`${count(stats.questions.total)} 个`}
        note={`老师答了 ${count(stats.questions.segmentsWithAnswer)} 段`}
      />
      <Stat
        label="这周入学的新生"
        value={`${count(stats.students.newcomers)} 人`}
        note={`其中 ${count(stats.students.cameBackForSecond)} 人上了第二节课`}
      />
      <Stat
        label="大模型花费"
        value={preciseYuan(total)}
        note={stats.cost.attendees === 0 ? '这一周没有学生来上课' : `${count(stats.cost.attendees)} 个学生来上课`}
      />
    </div>
  )
}

const answered = (called: number, answers: number) => (called === 0 ? '没有点名' : percent(answers / called))

function Lessons({ stats }: { stats: WeeklyStats }) {
  const { callOn, questions, reconnects } = stats
  // In the order the school names them, whatever order the stored review keeps them in.
  const divisions = (Object.keys(DIVISION_NAMES) as Division[]).map((d) => [d, callOn.byDivision[d]] as const)
  const called = divisions.reduce((sum, [, d]) => sum + d.called, 0)
  const answers = divisions.reduce((sum, [, d]) => sum + d.answered, 0)
  return (
    <Block title="上课">
      <p className="text-base font-medium text-gray-900">
        {called === 0
          ? '这一周没有点名。'
          : `点名回答率 ${percent(callOn.rate)}：点名 ${count(called)} 次，答了 ${count(answers)} 次。`}
      </p>
      <div className="grid grid-cols-3 items-start gap-6">
        <DataTable caption="点名，按学部" head={['学部', '点名', '答了', '回答率']} numeric={[1, 2, 3]}>
          {divisions.map(([division, d]) => (
            <tr key={division}>
              <th scope="row" className={ROW_HEAD}>
                {DIVISION_NAMES[division]}
              </th>
              <td className={NUM}>{count(d.called)}</td>
              <td className={NUM}>{count(d.answered)}</td>
              <td className={NUM}>{answered(d.called, d.answered)}</td>
            </tr>
          ))}
        </DataTable>
        {callOn.byPlugin.length > 0 && (
          <DataTable caption="点名，按插件" head={['插件', '版本', '点名', '答了', '回答率']} numeric={[2, 3, 4]}>
            {callOn.byPlugin.map((p) => (
              <tr key={`${p.type}/${p.version}`}>
                <th scope="row" className={ROW_HEAD}>
                  {p.type}
                </th>
                <td className={CELL}>{p.version}</td>
                <td className={NUM}>{count(p.called)}</td>
                <td className={NUM}>{count(p.answered)}</td>
                <td className={NUM}>{answered(p.called, p.answered)}</td>
              </tr>
            ))}
          </DataTable>
        )}
        {reconnects.length === 0 ? (
          <p>这一周没有学生来上课，也就没有掉线重连。</p>
        ) : (
          <DataTable caption="掉线重连，按插件版本" head={['插件', '版本', '重连次数']} numeric={[2]}>
            {reconnects.map((r) => (
              <tr key={`${r.type}/${r.version}`}>
                <th scope="row" className={ROW_HEAD}>
                  {r.type}
                </th>
                <td className={CELL}>{r.version}</td>
                <td className={NUM}>{count(r.count)}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </div>
      <p className="rounded-md bg-gray-50 px-4 py-3">
        {`收到 ${count(questions.total)} 个问题。答疑的段里，老师答了 ${count(questions.segmentsWithAnswer)} 段，` +
          `没答 ${count(questions.segmentsWithout)} 段。`}
      </p>
    </Block>
  )
}

/** Why an item of the model's is not there: not reviewed yet, or the model did not make it. */
function missingItem(page: WeeklyPage, item: 'removeRules' | 'directions', notYet: string): string | undefined {
  const { suggestions } = page
  if (suggestions === null) return notYet
  if (suggestions[item] !== null) return undefined
  return `这一项没生成出来：${sentence(suggestions.failures[item] ?? '原因没有记下来')}`
}

function Course({ page }: { page: WeeklyPage }) {
  const { lessons } = page.stats
  const missing = missingItem(page, 'directions', '还没有复盘，没有归纳。')
  const directions = page.suggestions?.directions ?? []
  return (
    <Block title="课程">
      <NumberTable
        caption="课程的数字"
        rows={[
          ['没赶上审、改上自习的课', `${count(lessons.studyHallsForUnreviewed)} 节`],
          ['你手改的地方', `${count(lessons.edits)} 处`],
          ['让大模型重写的段', `${count(lessons.segmentRewrites)} 段`],
          ['整节课重写', `${count(lessons.lessonRewrites)} 节`],
        ]}
      />
      <Listed title="大模型归纳的修改方向" hint="从你这一周写的重写理由里归纳出来。改不改由你决定，系统不会自动改。">
        {(titleId) =>
          missing !== undefined ? (
            <p>{missing}</p>
          ) : directions.length === 0 ? (
            <p>大模型没有归纳出建议：这一周没有写过重写理由，或者理由里看不出共同的方向。</p>
          ) : (
            <ol className="list-inside list-decimal space-y-2" aria-labelledby={titleId}>
              {directions.map((direction, i) => (
                <li key={i} className="rounded-md bg-indigo-50 px-3 py-2 text-indigo-900 marker:font-medium">
                  {direction}
                </li>
              ))}
            </ol>
          )
        }
      </Listed>
    </Block>
  )
}

function Teacher({ stats }: { stats: WeeklyStats }) {
  const { teacher } = stats
  return (
    <Block title="老师">
      <NumberTable
        caption="老师的数字"
        rows={[
          ['大模型调用失败（答疑和点评）', `${count(teacher.llmFailures)} 次`],
          ['退回模板话', `${count(teacher.fallbacks)} 次`],
          ['老师的话被审核拦下', `${count(teacher.blockedLines)} 次`],
          ['厂商拒绝处理（所有用途）', `${count(teacher.refusals)} 次`],
        ]}
      />
    </Block>
  )
}

/** Says what dropping a rule took back; it takes the focus the dialog's button had. */
function Dropped({ text }: { text: string }) {
  const self = useFocusOnMount<HTMLParagraphElement>()
  return (
    <p ref={self} tabIndex={-1} className="mt-3 rounded-md bg-green-50 px-4 py-3 text-sm text-green-800" role="status">
      {text}
    </p>
  )
}

function droppedText(rule: SuggestedRule, outcome: { revoked: number; lifted: number[] }): string {
  const done = rule.kind === 'word' ? '已删除。' : '已停用。'
  if (outcome.revoked === 0 && outcome.lifted.length === 0) return `${done}没有要撤销的违纪。`
  const lifted =
    outcome.lifted.length === 0
      ? '没有学生的处罚因此解除。'
      : `解除了 ${outcome.lifted.length} 个学生的处罚：学号 ${outcome.lifted.join('、')}。`
  return `${done}撤销了 ${count(outcome.revoked)} 条违纪，${lifted}`
}

/** A student's line with when it was said: a grid of two columns. */
function Line({ at, text }: { at: string; text: string }) {
  const zone = useSchoolZone()
  return (
    <li className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 py-2">
      <span className="text-xs whitespace-nowrap text-gray-600 tabular-nums">{weekMoment(at, zone)}</span>
      <span className="text-gray-900 [overflow-wrap:anywhere]">{text}</span>
    </li>
  )
}

/** A rule the model found blocking by mistake: its examples, and dropping it, asked first. */
function Suggestion({ rule, gone, onDropped }: { rule: SuggestedRule; gone: boolean; onDropped: () => void }) {
  const [asking, setAsking] = useState(false)
  const [said, setSaid] = useState<string>()
  const opener = useRef<HTMLButtonElement>(null)
  const word = rule.kind === 'word'
  const name = `${RULE_KIND_NAMES[rule.kind]}“${rule.value}”`

  return (
    <li className="rounded-lg border border-gray-200 p-4">
      <div className="flex items-center gap-3">
        <p className="font-medium text-gray-900 [overflow-wrap:anywhere]">{name}</p>
        {said === undefined &&
          (gone ? (
            <span className="ml-auto">
              <Badge tone="gray">{word ? '已经删掉了。' : '已经停用了。'}</Badge>
            </span>
          ) : (
            <Button type="danger" size="small" className="ml-auto" ref={opener} onClick={() => setAsking(true)}>
              确认删除
            </Button>
          ))}
      </div>
      {rule.examples.length === 0 ? (
        <p className="mt-2 text-xs text-gray-600">这条规则的例子已经过了消息的保存期限，看不到了。</p>
      ) : (
        <ul className="mt-2 divide-y divide-gray-100" aria-label={`${name}拦下的例子`}>
          {rule.examples.map((example) => (
            <Line key={example.messageId} at={example.at} text={example.text} />
          ))}
        </ul>
      )}
      {said !== undefined && <Dropped text={said} />}
      {asking && (
        <Confirm
          title={word ? `删掉词“${rule.value}”？` : `停用话术规则“${rule.value}”？`}
          confirm={word ? '删掉这个词' : '停用这条规则'}
          danger
          busy={word ? '正在删除' : '正在停用'}
          cancel={word ? '先不删' : '先不停用'}
          onCancel={() => {
            setAsking(false)
            opener.current?.focus()
          }}
          onConfirm={async () => {
            const outcome = await dropRule(rule.kind, rule.value)
            setAsking(false)
            setSaid(droppedText(rule, outcome))
            onDropped()
          }}
        >
          <p>{word ? '删掉以后，词库不再用它拦消息' : '停用以后，这条规则不再拦消息'}，两个服务几秒内读到。</p>
          <p>回看的天数以内，因为它记下的违反校规会撤销；撤销以后够不上处罚的学生，处罚会解除。</p>
          <p>后台没有恢复的按钮。它会列在本页最下面，记得照着改词库文件。</p>
        </Confirm>
      )}
    </li>
  )
}

function Moderation({ page, onDropped }: { page: WeeklyPage; onDropped: () => void }) {
  const { moderation } = page.stats
  const missing = missingItem(page, 'removeRules', '还没有复盘，没有建议。')
  const rules = page.suggestions?.removeRules ?? []
  const gone = (rule: SuggestedRule) =>
    page.exclusions.some((exclusion) => exclusion.kind === rule.kind && exclusion.value === rule.value)

  return (
    <Block title="审核">
      <Listed
        title="建议停用的词和规则"
        hint="大模型从这一周被拦下的消息里，找出看起来拦错了的词和话术规则。删不删由你决定。"
      >
        {(titleId) =>
          missing !== undefined ? (
            <p>{missing}</p>
          ) : rules.length === 0 ? (
            <p>大模型没有找到误伤：被拦下的消息里，没有哪个词或规则看起来拦错了。</p>
          ) : (
            <ul className="space-y-3" aria-labelledby={titleId}>
              {rules.map((rule) => (
                <Suggestion key={`${rule.kind}/${rule.value}`} rule={rule} gone={gone(rule)} onDropped={onDropped} />
              ))}
            </ul>
          )
        }
      </Listed>
      <div className="grid grid-cols-2 items-start gap-6 border-t border-gray-200 pt-4">
        <DataTable
          wide
          caption="每天拦下的消息"
          head={['日期', '违规内容', '骗 AI', '隐私', '第二层', '合计']}
          numeric={[1, 2, 3, 4, 5]}
        >
          {moderation.byDay.map((day) => (
            <tr key={day.date}>
              <th scope="row" className={`${ROW_HEAD} whitespace-nowrap`}>
                {shortDayName(day.date)}
              </th>
              <td className={NUM}>{count(day.sensitive)}</td>
              <td className={NUM}>{count(day.injection)}</td>
              <td className={NUM}>{count(day.privacy)}</td>
              <td className={NUM}>{count(day.secondLayer)}</td>
              <td className={`${NUM} font-medium text-gray-900`}>
                {count(day.sensitive + day.injection + day.privacy + day.secondLayer)}
              </td>
            </tr>
          ))}
        </DataTable>
        {moderation.topRules.length === 0 ? (
          <p>这一周词库没有拦下消息。</p>
        ) : (
          <DataTable wide caption="拦得最多的词和规则" head={['词或规则', '种类', '拦下']} numeric={[2]}>
            {moderation.topRules.map((rule) => (
              <tr key={`${rule.kind}/${rule.rule}`}>
                <th scope="row" className={`${ROW_HEAD} [overflow-wrap:anywhere]`}>
                  {rule.rule}
                </th>
                <td className={CELL}>
                  <Badge tone={rule.kind === 'word' ? 'blue' : 'indigo'}>{RULE_KIND_NAMES[rule.kind]}</Badge>
                </td>
                <td className={NUM}>{count(rule.count)}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </div>
      <Listed title="审课时点过“这是误伤”的词">
        {(titleId) =>
          moderation.falsePositiveMarks.length === 0 ? (
            <p>这一周审课时没有点过“这是误伤”。</p>
          ) : (
            <ul className="flex flex-wrap gap-2" aria-labelledby={titleId}>
              {moderation.falsePositiveMarks.map((mark) => (
                <li key={mark}>
                  <Badge tone="gray">{mark}</Badge>
                </li>
              ))}
            </ul>
          )
        }
      </Listed>
      <Listed title="第二层拦下的同学消息" hint="这些不算违反校规。看看拦得准不准。">
        {(titleId) =>
          moderation.secondLayerChat.length === 0 ? (
            <p>这一周第二层没有拦下同学的消息。</p>
          ) : (
            // Up to 200 lines: they scroll in a box of their own, which the keyboard can reach and scroll.
            <div
              className="max-h-80 overflow-auto rounded-md border border-gray-200 px-3 focus-visible:outline-offset-[-2px]"
              tabIndex={0}
              role="region"
              aria-labelledby={titleId}
            >
              <ul className="divide-y divide-gray-100">
                {moderation.secondLayerChat.map((line) => (
                  <Line key={line.messageId} at={line.at} text={line.text} />
                ))}
              </ul>
            </div>
          )
        }
      </Listed>
    </Block>
  )
}

function Students({ stats }: { stats: WeeklyStats }) {
  const { students } = stats
  return (
    <Block title="学生">
      <NumberTable
        caption="学生的数字"
        rows={[
          ['这周入学的新生', `${count(students.newcomers)} 人`],
          ['其中上了第二节课的', `${count(students.cameBackForSecond)} 人`],
          ['自动退学（按最后上课的日子估算）', `${count(students.dropped)} 人`],
          ['停课', `${count(students.suspended)} 人`],
          ['开除', `${count(students.expelled)} 人`],
        ]}
      />
    </Block>
  )
}

function Cost({ stats }: { stats: WeeklyStats }) {
  const { byPurpose, perAttendee, attendees } = stats.cost
  const purposes = Object.entries(PURPOSE_NAMES) as [LlmPurpose, string][]
  const total = purposes.reduce((sum, [purpose]) => sum + byPurpose[purpose], 0)
  return (
    <Block title="花费">
      <DataTable wide caption="按用途分的花费" head={['用途', '花费']} numeric={[1]}>
        {purposes.map(([purpose, name]) => (
          <tr key={purpose}>
            <th scope="row" className={`${ROW_HEAD} font-normal text-gray-700`}>
              {name}
            </th>
            <td className={NUM}>{preciseYuan(byPurpose[purpose])}</td>
          </tr>
        ))}
        <tr className="border-t-2 border-gray-200">
          <th scope="row" className={ROW_HEAD}>
            合计
          </th>
          <td className={`${NUM} font-semibold text-gray-900`}>{preciseYuan(total)}</td>
        </tr>
      </DataTable>
      <p>
        {attendees === 0
          ? '这一周没有学生来上课，算不出平均每人花了多少。'
          : `这一周有 ${attendees} 个学生来上课，平均每人花了 ${preciseYuan(perAttendee)}。`}
      </p>
    </Block>
  )
}

function Exclusions({ page }: { page: WeeklyPage }) {
  const zone = useSchoolZone()
  return (
    <Block
      title="已删的词和已停用的规则"
      description="删掉的词和停用的规则存在数据库里，叠加在词库文件上生效。照着这张表改词库文件，两边就一致了。"
    >
      {page.exclusions.length === 0 ? (
        <p>还没有删过词，也没有停用过规则。</p>
      ) : (
        <DataTable wide quietCaption caption="已删的词和已停用的规则" head={['种类', '词或规则', '删除时间']}>
          {page.exclusions.map((exclusion) => (
            <tr key={`${exclusion.kind}/${exclusion.value}`}>
              <td className={`${CELL} whitespace-nowrap`}>
                <Badge tone={exclusion.kind === 'word' ? 'blue' : 'indigo'}>{RULE_KIND_NAMES[exclusion.kind]}</Badge>
              </td>
              <td className={`${CELL} font-medium text-gray-900 [overflow-wrap:anywhere]`}>{exclusion.value}</td>
              <td className={`${CELL} whitespace-nowrap`}>{dayMoment(exclusion.createdAt, zone)}</td>
            </tr>
          ))}
        </DataTable>
      )}
    </Block>
  )
}

function WeekPicker({
  shown,
  reviewed,
  known,
  weeks,
  onPick,
}: {
  shown: string | undefined
  /** Whether the week shown has a review. */
  reviewed: boolean
  /** Whether the week shown has been read: its review state is known. */
  known: boolean
  weeks: Loaded<{ weeks: string[] }>
  onPick: (monday: string) => void
}) {
  const pickerId = useId()
  const listed = weeks.data?.weeks ?? []
  const options = [...new Set([...listed, ...(shown === undefined ? [] : [shown])])].sort().reverse()
  if (options.length === 0 && weeks.error === undefined) return null
  const notReviewed = (monday: string) => !listed.includes(monday) && !(monday === shown && reviewed)

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 lift rounded-lg border border-gray-200 bg-white px-6 py-4">
      {options.length > 0 && (
        <div className="flex items-center gap-3">
          <label className="text-sm font-medium text-gray-700" htmlFor={pickerId}>
            看哪一周
          </label>
          <select
            id={pickerId}
            className="w-80 rounded-md border border-edge bg-white px-3 py-2 text-sm text-gray-900 shadow-xs focus:border-accent focus:outline-2 focus:outline-offset-0 focus:outline-accent"
            value={shown}
            onChange={(event) => onPick(event.target.value)}
          >
            {options.map((monday) => (
              <option key={monday} value={monday}>
                {weekName(monday)}
                {notReviewed(monday) ? '（还没复盘）' : ''}
              </option>
            ))}
          </select>
          {known && <Badge tone={reviewed ? 'green' : 'yellow'}>{reviewed ? '已复盘' : '还没复盘'}</Badge>}
          {known && (
            <Tip about="复盘">
              {reviewed
                ? '这一周已经复盘，下面的数字是复盘时算好存下的。'
                : '这一周还没有复盘，下面的数字是现在算的。大模型的两项建议，要等每周一 0 点复盘上一周时才有。'}
            </Tip>
          )}
        </div>
      )}
      {weeks.error !== undefined && (
        <div className="flex items-center gap-3 text-sm text-gray-700">
          <p>没能读取复盘过的那几周。{weeks.error.message}</p>
          <Button size="small" onClick={weeks.reload}>
            重新读取
          </Button>
        </div>
      )}
    </div>
  )
}

export function Weekly() {
  // Undefined: the last week that has ended, which the server picks.
  const [week, setWeek] = useState<string>()
  const page = useLoad<WeeklyPage>(weeklyPath(week))
  const weeks = useLoad<{ weeks: string[] }>(WEEKS_PATH)
  // The answer kept while another week is read is not that week's.
  const data = week === undefined || page.data?.stats.weekStart === week ? page.data : undefined
  const shown = week ?? data?.stats.weekStart

  let body
  if (data === undefined) {
    body = (
      <Card>
        {page.error !== undefined && !page.loading ? (
          <Failed what="这一周的复盘" reason={page.error.message} retry={page.reload} />
        ) : (
          <Loading what="这一周的复盘" />
        )}
      </Card>
    )
  } else {
    const reload = () => {
      page.reload()
      weeks.reload()
    }
    body = (
      <>
        {page.error !== undefined && (
          <Card>
            <Failed what="这一周的最新复盘（下面是上次读到的）" reason={page.error.message} retry={page.reload} />
          </Card>
        )}
        {quiet(data) ? (
          <Card>
            <Empty why="这一周学校没有上课，也没有花钱：可能还没开学，或者正在放假。换一周看看。" />
          </Card>
        ) : (
          <>
            <Headline stats={data.stats} />
            <Lessons stats={data.stats} />
            <div className="grid grid-cols-2 items-start gap-6">
              <Course page={data} />
              <Teacher stats={data.stats} />
            </div>
            <Moderation page={data} onDropped={reload} />
            <div className="grid grid-cols-2 items-start gap-6">
              <Students stats={data.stats} />
              <Cost stats={data.stats} />
            </div>
          </>
        )}
        <Exclusions page={data} />
      </>
    )
  }

  return (
    <div className="space-y-6">
      <WeekPicker
        shown={shown}
        reviewed={data?.suggestions != null}
        known={data !== undefined}
        weeks={weeks}
        onPick={setWeek}
      />
      {body}
    </div>
  )
}
