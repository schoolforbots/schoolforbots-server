import { Button, Input } from 'antd'
import { useId, useRef, useState } from 'react'
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

// The runtime switches: one row each, with what the school does while it is on and while it is off, where it stands
// and when it last changed. Switching asks first. The class service reads the switches every few seconds, so a
// change reaches the lessons under way without stopping them.

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

/** Said after a switch changed; it takes the focus the dialog's button had. */
function Switched({ text }: { text: string }) {
  const self = useFocusOnMount<HTMLParagraphElement>()
  return (
    <p ref={self} tabIndex={-1} className="action-done" role="status">
      {text}
    </p>
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
    <section className="switch" aria-labelledby={titleId}>
      <div className="switch-head">
        <h2 id={titleId} className="switch-name">
          {name}
        </h2>
        <p className="switch-state">{state.on ? '现在开着' : '现在关着'}</p>
        <Button ref={opener} onClick={() => setAsking(true)}>
          {verb}
        </Button>
      </div>
      <ul className="switch-effects">
        {/* The effect in force now reads darker than the other. */}
        <li className={state.on ? 'switch-now' : undefined}>{effects.on}</li>
        <li className={state.on ? undefined : 'switch-now'}>{effects.off}</li>
      </ul>
      <p className="switch-when">
        {state.updatedAt === null ? '还没切换过，用的是配置里的默认值。' : `最近一次切换：${moment(state.updatedAt, zone)}`}
      </p>
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
  const [editing, setEditing] = useState(false)
  const asksMessage = turningOn || editing
  const verb = turningOn ? '开始维护' : editing ? '修改说明' : '结束维护'
  const hoursNumber = hours.trim() === '' ? null : Number(hours)
  const hoursOk = hoursNumber === null || (Number.isFinite(hoursNumber) && hoursNumber > 0)
  const messageOk = message.trim().length >= 1 && [...message.trim()].length <= MAX_MESSAGE

  function open(edit = false) {
    setEditing(edit)
    setMessage(current?.message ?? '')
    setHours('')
    setAsking(true)
  }

  return (
    <section className="switch" aria-labelledby={titleId}>
      <div className="switch-head">
        <h2 id={titleId} className="switch-name">
          维护中
        </h2>
        <p className="switch-state">{read.data === undefined ? '' : turningOn ? '现在没在维护' : '现在维护中'}</p>
        {read.data !== undefined && (
          <>
            {!turningOn && (
              <Button onClick={() => open(true)}>修改说明</Button>
            )}
            <Button ref={opener} onClick={() => open(false)}>
              {turningOn ? '开始维护' : '结束维护'}
            </Button>
          </>
        )}
      </div>
      {read.error !== undefined && <p className="action-error" role="alert">没能读取维护状态。{read.error.message}</p>}
      <ul className="switch-effects">
        <li className={turningOn ? undefined : 'switch-now'}>
          维护中：上课服务不让任何人进，在线的插件都会被断开；校历接口把说明和预计恢复时间告诉插件。
        </li>
        <li className={turningOn ? 'switch-now' : undefined}>没在维护：一切照常。</li>
      </ul>
      {current !== null && (
        <>
          <p className="switch-when">说明：{current.message}</p>
          <p className="switch-when">开始时间：{moment(current.since, zone)}</p>
          <p className="switch-when">
            预计恢复：{current.expectedBackAt === null ? '没有写' : moment(current.expectedBackAt, zone)}
          </p>
        </>
      )}
      {done !== undefined && <Switched key={done.n} text={done.text} />}
      {asking && (
        <Confirm
          title={`${verb}？`}
          confirm={verb}
          busy={`正在${verb}`}
          cancel={turningOn ? '先不维护' : editing ? '先不改' : '先不结束'}
          canConfirm={!asksMessage || (messageOk && hoursOk)}
          onCancel={() => {
            setAsking(false)
            opener.current?.focus()
          }}
          onConfirm={async () => {
            const body = asksMessage
              ? {
                  on: true,
                  message: message.trim(),
                  expectedBackAt: hoursNumber === null ? null : new Date(Date.now() + hoursNumber * 3_600_000).toISOString(),
                }
              : { on: false }
            read.set(await setMaintenance(body))
            setAsking(false)
            setDone((last) => ({ text: `已${verb}。`, n: (last?.n ?? 0) + 1 }))
          }}
        >
          {asksMessage ? (
            <>
              {turningOn ? <p>开始维护以后，在线的插件都会被断开，新的连接也不让进，直到结束维护。</p> : <p>只改说明和预计恢复时间，维护照常进行。</p>}
              <label className="field-label" htmlFor={messageId}>
                说明（插件会看到，最多 {MAX_MESSAGE} 字）
              </label>
              <Input.TextArea
                id={messageId}
                value={message}
                maxLength={MAX_MESSAGE}
                showCount
                autoSize={{ minRows: 2, maxRows: 5 }}
                onChange={(event) => setMessage(event.target.value)}
              />
              <label className="field-label" htmlFor={hoursId}>
                预计几小时后恢复（可以不填）
              </label>
              <Input id={hoursId} type="number" min={0} step={0.5} value={hours} onChange={(event) => setHours(event.target.value)} />
              {!hoursOk && <p className="action-error">预计恢复的小时数要大于 0。</p>}
              {turningOn && <p>维护的日子不算进自动退学的天数。</p>}
            </>
          ) : (
            <p>结束以后，插件可以重新连上，课照常上。</p>
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
      <div className="panel">
        {read.error !== undefined ? (
          <Failed what="开关" reason={read.error.message} retry={read.reload} />
        ) : (
          <Loading what="开关" />
        )}
      </div>
    )
  }
  const { switches } = read.data
  if (switches.length === 0) {
    return (
      <div className="panel">
        <Empty why="服务器这次没有列出开关，重新读取看看。" action={<Button onClick={read.reload}>重新读取</Button>} />
      </div>
    )
  }
  return (
    <div className="panel switches">
      <MaintenanceRow read={maintenance} />
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
    </div>
  )
}
