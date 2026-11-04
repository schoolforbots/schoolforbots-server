import { Tabs } from 'antd'
import { useEffect, useState, type ReactNode } from 'react'
import { LESSON_QUEUE_PATH, lessonsToReview, logout, useLoad, type ApiError, type LessonQueue } from './api.js'
import { Empty } from './components/States.js'
import { Data } from './pages/Data.js'

/** The green bar on top of every page: the school's name, and whatever acts on the whole session. */
export function TopBar({ children }: { children?: ReactNode }) {
  return (
    <header className="topbar">
      <h1 className="topbar-title">机器人网校 · 后台</h1>
      {children}
    </header>
  )
}

const TABS = ['data', 'review', 'weekly', 'students', 'switches'] as const
type Tab = (typeof TABS)[number]

const isTab = (key: string): key is Tab => (TABS as readonly string[]).includes(key)

/** The open tab, kept in the address (`#review`), so a reload or a new login comes back to it. */
function useTab(): [Tab, (tab: Tab) => void] {
  const fromAddress = () => {
    const key = window.location.hash.slice(1)
    return isTab(key) ? key : 'data'
  }
  const [tab, setTab] = useState<Tab>(fromAddress)

  useEffect(() => {
    const follow = () => setTab(fromAddress())
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [])

  const open = (next: Tab) => {
    window.history.replaceState(null, '', `#${next}`)
    setTab(next)
  }
  return [tab, open]
}

export function Layout({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [tab, setTab] = useTab()
  const queue = useLoad<LessonQueue>(LESSON_QUEUE_PATH)
  const toReview = queue.data === undefined ? 0 : lessonsToReview(queue.data)
  const [leaving, setLeaving] = useState(false)
  const [leaveFailure, setLeaveFailure] = useState<string>()

  async function leave() {
    setLeaving(true)
    setLeaveFailure(undefined)
    try {
      await logout()
      onLoggedOut()
    } catch (error) {
      setLeaveFailure(`没能退出：${(error as ApiError).message}`)
      setLeaving(false)
    }
  }

  const notYet = (
    <div className="panel">
      <Empty why="这一页还在做。" />
    </div>
  )
  const items = [
    { key: 'data', label: '学校数据', children: <Data onGoReview={() => setTab('review')} /> },
    { key: 'review', label: toReview > 0 ? `审课 · 待审 ${toReview}` : '审课', children: notYet },
    { key: 'weekly', label: '每周复盘', children: notYet },
    { key: 'students', label: '查学生', children: notYet },
    { key: 'switches', label: '开关', children: notYet },
  ]

  return (
    <div className="shell">
      <TopBar>
        <div className="topbar-actions">
          {leaveFailure !== undefined && (
            <p className="topbar-failure" role="alert">
              {leaveFailure}
            </p>
          )}
          <button type="button" className="topbar-button" onClick={leave} disabled={leaving}>
            退出登录
          </button>
        </div>
      </TopBar>
      <main className="content">
        <Tabs activeKey={tab} onChange={(key) => isTab(key) && setTab(key)} items={items} />
      </main>
    </div>
  )
}
