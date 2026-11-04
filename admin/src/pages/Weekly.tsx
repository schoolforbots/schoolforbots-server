import { Button } from 'antd'
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
import { DataTable, NumberTable } from '../components/Tables.js'
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

/** A part of the review: a panel named by its heading. */
function Block({ title, children }: { title: string; children: ReactNode }) {
  const titleId = useId()
  return (
    <section className="panel review-block" aria-labelledby={titleId}>
      <h2 id={titleId} className="panel-title">
        {title}
      </h2>
      {children}
    </section>
  )
}

/** A list under its own heading, or the sentence that says why there is none. */
function Listed({ title, hint, children }: { title: string; hint?: string; children: (titleId: string) => ReactNode }) {
  const titleId = useId()
  return (
    <div className="listed">
      <h3 id={titleId} className="sub-title">
        {title}
      </h3>
      {hint !== undefined && <p className="field-hint">{hint}</p>}
      {children(titleId)}
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
      <p className="lead">
        {called === 0
          ? '这一周没有点名。'
          : `点名回答率 ${percent(callOn.rate)}：点名 ${count(called)} 次，答了 ${count(answers)} 次。`}
      </p>
      <div className="tables">
        <DataTable caption="点名，按学部" head={['学部', '点名', '答了', '回答率']}>
          {divisions.map(([division, d]) => (
            <tr key={division}>
              <th scope="row">{DIVISION_NAMES[division]}</th>
              <td className="num">{count(d.called)}</td>
              <td className="num">{count(d.answered)}</td>
              <td className="num">{answered(d.called, d.answered)}</td>
            </tr>
          ))}
        </DataTable>
        {callOn.byPlugin.length > 0 && (
          <DataTable caption="点名，按插件" head={['插件', '版本', '点名', '答了', '回答率']}>
            {callOn.byPlugin.map((p) => (
              <tr key={`${p.type}/${p.version}`}>
                <th scope="row">{p.type}</th>
                <td>{p.version}</td>
                <td className="num">{count(p.called)}</td>
                <td className="num">{count(p.answered)}</td>
                <td className="num">{answered(p.called, p.answered)}</td>
              </tr>
            ))}
          </DataTable>
        )}
        {reconnects.length === 0 ? (
          <p>这一周没有学生来上课，也就没有掉线重连。</p>
        ) : (
          <DataTable caption="掉线重连，按插件版本" head={['插件', '版本', '重连次数']}>
            {reconnects.map((r) => (
              <tr key={`${r.type}/${r.version}`}>
                <th scope="row">{r.type}</th>
                <td>{r.version}</td>
                <td className="num">{count(r.count)}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </div>
      <p>
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
            <ol className="plain-list" aria-labelledby={titleId}>
              {directions.map((direction, i) => (
                <li key={i}>{direction}</li>
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
    <p ref={self} tabIndex={-1} className="action-done" role="status">
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

/** A rule the model found blocking by mistake: its examples, and dropping it, asked first. */
function Suggestion({ rule, gone, onDropped }: { rule: SuggestedRule; gone: boolean; onDropped: () => void }) {
  const zone = useSchoolZone()
  const [asking, setAsking] = useState(false)
  const [said, setSaid] = useState<string>()
  const opener = useRef<HTMLButtonElement>(null)
  const word = rule.kind === 'word'
  const name = `${RULE_KIND_NAMES[rule.kind]}“${rule.value}”`

  return (
    <li className="suggestion">
      <div className="suggestion-head">
        <p className="suggestion-rule">{name}</p>
        {said === undefined &&
          (gone ? (
            <p className="field-hint">{word ? '已经删掉了。' : '已经停用了。'}</p>
          ) : (
            <Button ref={opener} onClick={() => setAsking(true)}>
              确认删除
            </Button>
          ))}
      </div>
      {rule.examples.length === 0 ? (
        <p className="field-hint">这条规则的例子已经过了消息的保存期限，看不到了。</p>
      ) : (
        <ul className="lines" aria-label={`${name}拦下的例子`}>
          {rule.examples.map((example) => (
            <li key={example.messageId}>
              <span className="line-when">{weekMoment(example.at, zone)}</span>
              <span className="line">{example.text}</span>
            </li>
          ))}
        </ul>
      )}
      {said !== undefined && <Dropped text={said} />}
      {asking && (
        <Confirm
          title={word ? `删掉词“${rule.value}”？` : `停用话术规则“${rule.value}”？`}
          confirm={word ? '删掉这个词' : '停用这条规则'}
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
  const zone = useSchoolZone()
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
            <ul className="suggestions" aria-labelledby={titleId}>
              {rules.map((rule) => (
                <Suggestion key={`${rule.kind}/${rule.value}`} rule={rule} gone={gone(rule)} onDropped={onDropped} />
              ))}
            </ul>
          )
        }
      </Listed>
      <div className="tables">
        <DataTable caption="每天拦下的消息" head={['日期', '违规内容', '骗 AI', '隐私', '第二层', '合计']}>
          {moderation.byDay.map((day) => (
            <tr key={day.date}>
              <th scope="row">{shortDayName(day.date)}</th>
              <td className="num">{count(day.sensitive)}</td>
              <td className="num">{count(day.injection)}</td>
              <td className="num">{count(day.privacy)}</td>
              <td className="num">{count(day.secondLayer)}</td>
              <td className="num">{count(day.sensitive + day.injection + day.privacy + day.secondLayer)}</td>
            </tr>
          ))}
        </DataTable>
        {moderation.topRules.length === 0 ? (
          <p>这一周词库没有拦下消息。</p>
        ) : (
          <DataTable caption="拦得最多的词和规则" head={['词或规则', '种类', '拦下']}>
            {moderation.topRules.map((rule) => (
              <tr key={`${rule.kind}/${rule.rule}`}>
                <th scope="row" className="line">
                  {rule.rule}
                </th>
                <td>{RULE_KIND_NAMES[rule.kind]}</td>
                <td className="num">{count(rule.count)}</td>
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
            <ul className="marks" aria-labelledby={titleId}>
              {moderation.falsePositiveMarks.map((mark) => (
                <li key={mark}>{mark}</li>
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
            <div className="scroll-box" tabIndex={0} role="region" aria-labelledby={titleId}>
              <ul className="lines" aria-labelledby={titleId}>
                {moderation.secondLayerChat.map((line) => (
                  <li key={line.messageId}>
                    <span className="line-when">{weekMoment(line.at, zone)}</span>
                    <span className="line">{line.text}</span>
                  </li>
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
  const { byPurpose, perAttendee } = stats.cost
  const purposes = Object.entries(PURPOSE_NAMES) as [LlmPurpose, string][]
  const total = purposes.reduce((sum, [purpose]) => sum + byPurpose[purpose], 0)
  return (
    <Block title="花费">
      <DataTable caption="按用途分的花费" head={['用途', '花费']}>
        {purposes.map(([purpose, name]) => (
          <tr key={purpose}>
            <th scope="row">{name}</th>
            <td className="num">{preciseYuan(byPurpose[purpose])}</td>
          </tr>
        ))}
        <tr className="total">
          <th scope="row">合计</th>
          <td className="num">{preciseYuan(total)}</td>
        </tr>
      </DataTable>
      <p>
        {perAttendee === 0 && total > 0
          ? '这一周没有学生来上课，算不出平均每人花了多少。'
          : `平均每个来上课的学生花了 ${preciseYuan(perAttendee)}。`}
      </p>
    </Block>
  )
}

function Exclusions({ page }: { page: WeeklyPage }) {
  const zone = useSchoolZone()
  return (
    <Block title="已删的词和已停用的规则">
      <p className="field-hint">
        删掉的词和停用的规则存在数据库里，叠加在词库文件上生效。照着这张表改词库文件，两边就一致了。
      </p>
      {page.exclusions.length === 0 ? (
        <p>还没有删过词，也没有停用过规则。</p>
      ) : (
        <DataTable quietCaption caption="已删的词和已停用的规则" head={['种类', '词或规则', '删除时间']}>
          {page.exclusions.map((exclusion) => (
            <tr key={`${exclusion.kind}/${exclusion.value}`}>
              <td className="nowrap">{RULE_KIND_NAMES[exclusion.kind]}</td>
              <td className="line">{exclusion.value}</td>
              <td className="nowrap">{dayMoment(exclusion.createdAt, zone)}</td>
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
  weeks,
  onPick,
}: {
  shown: string | undefined
  /** Whether the week shown has a review. */
  reviewed: boolean
  weeks: Loaded<{ weeks: string[] }>
  onPick: (monday: string) => void
}) {
  const pickerId = useId()
  const listed = weeks.data?.weeks ?? []
  const options = [...new Set([...listed, ...(shown === undefined ? [] : [shown])])].sort().reverse()
  if (options.length === 0 && weeks.error === undefined) return null
  const notReviewed = (monday: string) => !listed.includes(monday) && !(monday === shown && reviewed)

  return (
    <div className="panel week-picker">
      {options.length > 0 && (
        <div className="picker-row">
          <label className="field-label" htmlFor={pickerId}>
            看哪一周
          </label>
          <select
            id={pickerId}
            className="native-select"
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
        </div>
      )}
      {weeks.error !== undefined && (
        <div className="picker-failure">
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
      <div className="panel">
        {page.error !== undefined && !page.loading ? (
          <Failed what="这一周的复盘" reason={page.error.message} retry={page.reload} />
        ) : (
          <Loading what="这一周的复盘" />
        )}
      </div>
    )
  } else {
    const reload = () => {
      page.reload()
      weeks.reload()
    }
    body = (
      <>
        {page.error !== undefined && (
          <div className="panel">
            <Failed what="这一周的最新复盘（下面是上次读到的）" reason={page.error.message} retry={page.reload} />
          </div>
        )}
        <p className="week-note">
          {data.suggestions === null
            ? '这一周还没有复盘，下面的数字是现在算的。大模型的两项建议，要等每周一 0 点复盘上一周时才有。'
            : '这一周已经复盘，下面的数字是复盘时算好存下的。'}
        </p>
        {quiet(data) ? (
          <div className="panel">
            <Empty why="这一周学校没有上课，也没有花钱：可能还没开学，或者正在放假。换一周看看。" />
          </div>
        ) : (
          <>
            <Lessons stats={data.stats} />
            <Course page={data} />
            <Teacher stats={data.stats} />
            <Moderation page={data} onDropped={reload} />
            <Students stats={data.stats} />
            <Cost stats={data.stats} />
          </>
        )}
        <Exclusions page={data} />
      </>
    )
  }

  return (
    <div className="page">
      <WeekPicker shown={shown} reviewed={data?.suggestions != null} weeks={weeks} onPick={setWeek} />
      {body}
    </div>
  )
}
