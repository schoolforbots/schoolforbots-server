import { Tabs } from 'antd'
import { useEffect, useState, type ReactNode } from 'react'
import { LESSON_QUEUE_PATH, lessonsToReview, logout, useLoad, type ApiError, type LessonQueue } from './api.js'
import { Data } from './pages/Data.js'
import { Review } from './pages/Review.js'
import { Students } from './pages/Students.js'
import { Switches } from './pages/Switches.js'
import { Weekly } from './pages/Weekly.js'

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
  // The count on the tab; a list that could not be read says so, rather than looking like nothing to review.
  let reviewLabel = '审课'
  if (queue.data !== undefined) {
    const toReview = lessonsToReview(queue.data)
    if (toReview > 0) reviewLabel = `审课 · 待审 ${toReview}`
  } else if (queue.error !== undefined && !queue.loading) reviewLabel = '审课 · 待审数没读到'
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

  const items = [
    { key: 'data', label: '学校数据', children: <Data onGoReview={() => setTab('review')} /> },
    { key: 'review', label: reviewLabel, children: <Review queue={queue} /> },
    { key: 'weekly', label: '每周复盘', children: <Weekly /> },
    { key: 'students', label: '查学生', children: <Students /> },
    { key: 'switches', label: '开关', children: <Switches /> },
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
            {leaving ? '正在退出' : '退出登录'}
          </button>
        </div>
      </TopBar>
      <main className="content">
        <Tabs activeKey={tab} onChange={(key) => isTab(key) && setTab(key)} items={items} />
      </main>
    </div>
  )
}
