import { Badge, Button, Card, Checkbox, Input, TextArea } from '../ui.js'
import { useId, useRef, useState, type RefObject } from 'react'
import {
  MAINTENANCE_PATH,
  setMaintenance,
  setSwitch,
  SWITCHES_PATH,
  useLoad,
  type Loaded,
  type MaintenanceState,
  type SwitchName,
  type SwitchState,
} from '../api.js'
import { Confirm } from '../components/Confirm.js'
import { Empty, Failed, Loading } from '../components/States.js'
import { useFocusOnMount } from '../focus.js'
import { moment, SWITCH_NAMES } from '../labels.js'
import { useSchoolZone } from '../zone.js'

// The runtime switches, drawn as the notifications card of HyperUI's settings template: one row each, with what the
// school does while it is on and while it is off, where it stands and when it last changed, and a toggle on the
// right. The toggle only asks: switching happens in the dialog it opens. The class service reads the switches every
// few seconds, so a change reaches the lessons under way without stopping them. Maintenance is a card of its own
// above, tinted yellow while the school is under it.

/** What each switch does, on and off. */
const EFFECTS: Record<SwitchName, { on: string; off: string }> = {
  teacherLlm: {
    on: '开着：老师用大模型答疑（每段正文之后答一个和话题有关的问题），也用大模型点评点名时的回答。',
    off: '关着：老师不答疑，点评退回固定的模板话，这两项不再花大模型的钱。',
  },
  secondLayerTeacher: {
    on: '开着：老师用大模型要说的话和同学的点名回答，过完词库，再交给第三方 AI 服务审一遍，会晚几秒。',
    off: '关着：只用词库审。',
  },
  secondLayerChat: {
    on: '开着：同学之间的消息过完词库，也送去第三方 AI 服务审；攒一两秒一批再审，所以晚几秒才送到，也要多花钱。',
    off: '关着：同学之间的消息只用词库审，不再送去第三方 AI 服务。',
  },
}

const DONE = 'mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800'
const WRONG = 'rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800'
const LABEL = 'mt-2 block text-sm font-medium text-gray-700'

/** Said after a switch changed; it takes the focus the dialog's button had. */
function Switched({ text }: { text: string }) {
  const self = useFocusOnMount<HTMLParagraphElement>()
  return (
    <p ref={self} tabIndex={-1} className={DONE} role="status">
      {text}
    </p>
  )
}

/**
 * The template's toggle switch, drawn on a button: it does not switch, it asks (the dialog does it). Its name is what
 * it would do, 关掉 or 打开; the badge beside the title says where the switch stands.
 */
function Toggle({
  on,
  label,
  opener,
  onClick,
}: {
  on: boolean
  label: string
  opener: RefObject<HTMLButtonElement | null>
  onClick: () => void
}) {
  return (
    <button
      ref={opener}
      type="button"
      onClick={onClick}
      className={
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full ring-1 ring-inset ' +
        (on ? 'bg-indigo-600 ring-indigo-600 hover:bg-indigo-700' : 'bg-gray-200 ring-gray-400 hover:bg-gray-300')
      }
    >
      <span className="sr-only">{label}</span>
      <span
        aria-hidden="true"
        className={
          'inline-block size-5 rounded-full bg-white shadow-sm ring-1 ring-gray-900/10 ' +
          (on ? 'translate-x-5.5' : 'translate-x-0.5')
        }
      />
    </button>
  )
}

function SwitchRow({ state, onChanged }: { state: SwitchState; onChanged: (state: SwitchState) => void }) {
  const zone = useSchoolZone()
  const titleId = useId()
  const [asking, setAsking] = useState(false)
  const [done, setDone] = useState<{ text: string; n: number }>()
  const opener = useRef<HTMLButtonElement>(null)
  const name = SWITCH_NAMES[state.name]
  const effects = EFFECTS[state.name]
  const verb = state.on ? '关掉' : '打开'

  return (
    <li className="py-5 first:pt-0 last:pb-0">
      <section aria-labelledby={titleId}>
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id={titleId} className="text-sm font-medium text-gray-900">
                {name}
              </h3>
              <Badge tone={state.on ? 'green' : 'gray'}>{state.on ? '现在开着' : '现在关着'}</Badge>
            </div>
            <ul className="mt-2 space-y-1 text-sm">
              {/* The effect in force now reads darker than the other. */}
              <li className={state.on ? 'text-gray-900' : 'text-gray-500'}>{effects.on}</li>
              <li className={state.on ? 'text-gray-500' : 'text-gray-900'}>{effects.off}</li>
            </ul>
            <p className="mt-2 text-xs text-gray-600">
              {state.updatedAt === null
                ? '还没切换过，用的是配置里的默认值。'
                : `最近一次切换：${moment(state.updatedAt, zone)}`}
            </p>
          </div>
          <Toggle on={state.on} label={verb} opener={opener} onClick={() => setAsking(true)} />
        </div>
        {done !== undefined && <Switched key={done.n} text={done.text} />}
        {asking && (
          <Confirm
            title={`${verb}“${name}”？`}
            confirm={verb}
            busy={`正在${verb}`}
            cancel={state.on ? '先不关' : '先不开'}
            onCancel={() => {
              setAsking(false)
              opener.current?.focus()
            }}
            onConfirm={async () => {
              const next = await setSwitch(state.name, !state.on)
              onChanged(next)
              setAsking(false)
              setDone((last) => ({ text: `已${verb}。上课服务几秒内读到。`, n: (last?.n ?? 0) + 1 }))
            }}
          >
            <p>{state.on ? effects.off : effects.on}</p>
            <p>上课服务每隔几秒读一次开关，几秒内生效，正在上的课不用断。</p>
          </Confirm>
        )}
      </section>
    </li>
  )
}

const MAX_MESSAGE = 200

/**
 * Maintenance: while it is on the class service lets nobody in and disconnects the plugins that are, and the school
 * calendar tells them why (the message) and when to come back. Switching on asks for the message first.
 */
function MaintenanceRow({ read }: { read: Loaded<{ maintenance: MaintenanceState | null }> }) {
  const zone = useSchoolZone()
  const titleId = useId()
  const messageId = useId()
  const hoursId = useId()
  const [asking, setAsking] = useState(false)
  const [message, setMessage] = useState('')
  const [hours, setHours] = useState('')
  const [done, setDone] = useState<{ text: string; n: number }>()
  const opener = useRef<HTMLButtonElement>(null)

  const current = read.data?.maintenance ?? null
  const turningOn = current === null
  const under = current !== null
  const [editing, setEditing] = useState(false)
  const [clearBack, setClearBack] = useState(false)
  const asksMessage = turningOn || editing
  const verb = turningOn ? '开始维护' : editing ? '修改说明' : '结束维护'
  const hoursNumber = hours.trim() === '' ? null : Number(hours)
  const hoursOk = hoursNumber === null || (Number.isFinite(hoursNumber) && hoursNumber > 0)
  const messageOk = message.trim().length >= 1 && [...message.trim()].length <= MAX_MESSAGE

  function open(edit = false) {
    setEditing(edit)
    setMessage(current?.message ?? '')
    setHours('')
    setClearBack(false)
    setAsking(true)
  }

  return (
    <section
      className={'rounded-lg border p-6 ' + (under ? 'border-yellow-300 bg-yellow-50' : 'border-gray-200 bg-white')}
      aria-labelledby={titleId}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={titleId} className="text-base font-semibold text-gray-900">
              维护中
            </h2>
            {read.data !== undefined && (
              <Badge tone={under ? 'yellow' : 'gray'}>{turningOn ? '现在没在维护' : '现在维护中'}</Badge>
            )}
          </div>
          <ul className="mt-2 space-y-1 text-sm">
            <li className={under ? 'text-gray-900' : 'text-gray-500'}>
              维护中：上课服务和社团服务都不让任何人进，在线的插件都会被断开，社团里打到一半的牌局由托管替所有人打完；校历接口把说明和预计恢复时间告诉插件。
            </li>
            <li className={under ? 'text-gray-500' : 'text-gray-900'}>没在维护：一切照常。</li>
          </ul>
        </div>
        {read.data !== undefined && (
          <div className="flex shrink-0 gap-2">
            {!turningOn && <Button onClick={() => open(true)}>修改说明</Button>}
            <Button ref={opener} type={turningOn ? 'default' : 'primary'} onClick={() => open(false)}>
              {turningOn ? '开始维护' : '结束维护'}
            </Button>
          </div>
        )}
      </div>
      {read.error !== undefined && (
        <p className={`mt-3 ${WRONG}`} role="alert">
          没能读取维护状态。{read.error.message}
        </p>
      )}
      {current !== null && (
        <div className="mt-4 grid grid-cols-3 gap-4 rounded-md border border-yellow-200 bg-white p-4 text-sm">
          <p className="text-gray-900">说明：{current.message}</p>
          <p className="text-gray-700">开始时间：{moment(current.since, zone)}</p>
          <p className="text-gray-700">
            预计恢复：{current.expectedBackAt === null ? '没有写' : moment(current.expectedBackAt, zone)}
          </p>
        </div>
      )}
      {done !== undefined && <Switched key={done.n} text={done.text} />}
      {asking && (
        <Confirm
          title={`${verb}？`}
          confirm={verb}
          busy={`正在${verb}`}
          cancel={turningOn ? '先不维护' : editing ? '先不改' : '先不结束'}
          canConfirm={!asksMessage || (messageOk && (hoursOk || clearBack))}
          onCancel={() => {
            setAsking(false)
            opener.current?.focus()
          }}
          onConfirm={async () => {
            const body = asksMessage
              ? {
                  on: true,
                  message: message.trim(),
                  ...(hoursNumber !== null && !clearBack
                    ? { expectedBackAt: new Date(Date.now() + hoursNumber * 3_600_000).toISOString() }
                    : clearBack || (turningOn && hoursNumber === null)
                      ? { expectedBackAt: null }
                      : {}),
                }
              : { on: false }
            read.set(await setMaintenance(body))
            setAsking(false)
            setDone((last) => ({ text: `已${verb}。`, n: (last?.n ?? 0) + 1 }))
          }}
        >
          {asksMessage ? (
            <>
              {turningOn ? (
                <p>开始维护以后，在线的插件都会被断开（社团里打到一半的牌局由托管打完），新的连接也不让进，直到结束维护。</p>
              ) : (
                <p>只改说明和预计恢复时间，维护照常进行。</p>
              )}
              <label className={LABEL} htmlFor={messageId}>
                说明（插件会看到，最多 {MAX_MESSAGE} 字）
              </label>
              <TextArea
                id={messageId}
                value={message}
                maxLength={MAX_MESSAGE}
                showCount
                autoSize={{ minRows: 2, maxRows: 5 }}
                onChange={(event) => setMessage(event.target.value)}
              />
              <label className={LABEL} htmlFor={hoursId}>
                预计几小时后恢复（可以不填）
              </label>
              <Input
                id={hoursId}
                type="number"
                disabled={clearBack}
                min={0}
                step={0.5}
                value={hours}
                onChange={(event) => setHours(event.target.value)}
              />
              {editing && current?.expectedBackAt != null && (
                <>
                  <p>
                    现在的预计恢复时间是 {moment(current.expectedBackAt, zone)}。这一栏不填，就保持不变；填了，改成从现在起的这么多小时后。
                  </p>
                  <Checkbox checked={clearBack} onChange={(event) => setClearBack(event.target.checked)}>
                    不写预计时间（清掉现在的）
                  </Checkbox>
                </>
              )}
              {!hoursOk && <p className={WRONG}>预计恢复的小时数要大于 0。</p>}
              {turningOn && <p>哪个时段从开门到下课之间碰上维护，这个时段今天就不上课了，哪怕维护提前结束，以后也不补。</p>}
              {turningOn && <p>维护的日子不算进自动退学的天数。</p>}
            </>
          ) : (
            <p>结束以后，插件可以重新连上。今天从开门到下课之间碰上过维护的时段不再上课，其余的课照常上。</p>
          )}
        </Confirm>
      )}
    </section>
  )
}

export function Switches() {
  const maintenance = useLoad<{ maintenance: MaintenanceState | null }>(MAINTENANCE_PATH)
  const read = useLoad<{ switches: SwitchState[] }>(SWITCHES_PATH)

  if (read.data === undefined) {
    return (
      <Card>
        {read.error !== undefined ? (
          <Failed what="开关" reason={read.error.message} retry={read.reload} />
        ) : (
          <Loading what="开关" />
        )}
      </Card>
    )
  }
  const { switches } = read.data
  if (switches.length === 0) {
    return (
      <Card>
        <Empty why="服务器这次没有列出开关，重新读取看看。" action={<Button onClick={read.reload}>重新读取</Button>} />
      </Card>
    )
  }
  return (
    <div className="space-y-6">
      <MaintenanceRow read={maintenance} />
      <Card
        title="运行时开关"
        description="上课服务每隔几秒读一次开关，切换以后几秒内生效，正在上的课不用断。每次切换都先确认。"
      >
        <ul className="mt-6 divide-y divide-gray-200">
          {switches.map((state) => (
            <SwitchRow
              key={state.name}
              state={state}
              // The switch as the server now has it, with the time it changed.
              onChanged={(next) =>
                read.set({ switches: switches.map((other) => (other.name === next.name ? next : other)) })
              }
            />
          ))}
        </ul>
      </Card>
    </div>
  )
}
