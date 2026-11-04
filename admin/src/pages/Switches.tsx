import { Button } from 'antd'
import { useId, useRef, useState } from 'react'
import { setSwitch, SWITCHES_PATH, useLoad, type SwitchName, type SwitchState } from '../api.js'
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
    on: '开着：老师当场要说的话和同学的点名回答，过完词库，再交给第三方 AI 服务审一遍，会晚一两秒。',
    off: '关着：只用词库审。',
  },
  secondLayerChat: {
    on: '开着：同学之间的消息过完词库，也送去第三方 AI 服务审；攒一两秒一批，所以晚一两秒才送到，也要多花钱。',
    off: '关着：同学之间的消息只用词库审，不送。',
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

export function Switches() {
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
