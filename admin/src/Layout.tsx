import { useEffect, useId, useState, type ReactNode } from 'react'
import { LESSON_QUEUE_PATH, lessonsToReview, logout, useLoad, type ApiError, type LessonQueue } from './api.js'
import { Clubs } from './pages/Clubs.js'
import { Data } from './pages/Data.js'
import { Notices } from './pages/Notices.js'
import { Review } from './pages/Review.js'
import { Students } from './pages/Students.js'
import { Switches } from './pages/Switches.js'
import { Weekly } from './pages/Weekly.js'
import { Button, PAGE_ACTIONS_ID } from './ui.js'

// The frame of the admin pages, after HyperUI's analytics dashboard template: the school's name and the pages down a
// white sidebar, the operator and logging out at its foot; on the right, a header with the page's name and its main
// actions (PageActions), and the page itself on the light grey.

/** The school's name, at the top of the sidebar and over the login card. */
export function Brand() {
  return (
    <p className="flex items-center gap-3">
      <span aria-hidden="true" className="grid size-10 place-content-center rounded-lg bg-gray-900 text-base font-bold text-white">
        校
      </span>
      <span className="flex flex-col leading-tight">
        <span className="text-sm font-semibold text-gray-900">机器人网校</span>
        <span className="text-xs text-gray-600">运营后台</span>
      </span>
    </p>
  )
}

/** The pages, in the order of the sidebar. */
const PAGES = [
  { key: 'data', name: '学校数据' },
  { key: 'review', name: '审课' },
  { key: 'weekly', name: '每周复盘' },
  { key: 'students', name: '查学生' },
  { key: 'clubs', name: '社团' },
  { key: 'switches', name: '开关' },
  { key: 'notices', name: '公告' },
] as const

type Tab = (typeof PAGES)[number]['key']

const isTab = (key: string): key is Tab => PAGES.some((page) => page.key === key)

/** The open page, kept in the address (`#review`), so a reload or a new login comes back to it. */
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

function NavItem({
  page,
  current,
  badge,
  onOpen,
}: {
  page: (typeof PAGES)[number]
  current: boolean
  badge?: string
  onOpen: () => void
}) {
  return (
    <li>
      <a
        href={`#${page.key}`}
        aria-current={current ? 'page' : undefined}
        aria-label={badge === undefined ? undefined : `${page.name} · ${badge}`}
        onClick={(event) => {
          event.preventDefault()
          onOpen()
        }}
        className={
          'flex items-center justify-between gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ' +
          (current ? 'bg-gray-100 text-gray-900' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900')
        }
      >
        {page.name}
        {badge !== undefined && (
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">{badge}</span>
        )}
      </a>
    </li>
  )
}

export function Layout({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [tab, setTab] = useTab()
  const queue = useLoad<LessonQueue>(LESSON_QUEUE_PATH)
  const titleId = useId()
  // The count beside 审课; a list that could not be read says so, rather than looking like nothing to review.
  let reviewBadge: string | undefined
  if (queue.data !== undefined) {
    const toReview = lessonsToReview(queue.data)
    if (toReview > 0) reviewBadge = `待审 ${toReview}`
  } else if (queue.error !== undefined && !queue.loading) reviewBadge = '待审数没读到'
  const [leaving, setLeaving] = useState(false)
  const [leaveFailure, setLeaveFailure] = useState<string>()
  const page = PAGES.find((one) => one.key === tab) ?? PAGES[0]

  useEffect(() => {
    document.title = `${page.name} · 机器人网校后台`
  }, [page.name])

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

  const content: Record<Tab, ReactNode> = {
    data: <Data onGoReview={() => setTab('review')} />,
    review: <Review queue={queue} />,
    weekly: <Weekly />,
    students: <Students />,
    clubs: <Clubs />,
    switches: <Switches />,
    notices: <Notices />,
  }

  return (
    <div className="flex min-h-screen bg-gray-50">
      <aside className="sticky top-0 flex h-screen w-64 shrink-0 flex-col justify-between overflow-y-auto border-r border-gray-200 bg-white">
        <div className="p-4">
          <Brand />
          <nav aria-label="后台页面" className="mt-6">
            <ul className="space-y-1">
              {PAGES.map((one) => (
                <NavItem
                  key={one.key}
                  page={one}
                  current={one.key === tab}
                  onOpen={() => setTab(one.key)}
                  badge={one.key === 'review' ? reviewBadge : undefined}
                />
              ))}
            </ul>
          </nav>
        </div>
        <div className="sticky inset-x-0 bottom-0 border-t border-gray-200 bg-white p-4">
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="grid size-10 place-content-center rounded-full bg-gray-100 text-sm font-medium text-gray-700">
              运
            </span>
            <p className="min-w-0 flex-1 text-xs text-gray-900">
              <strong className="block font-medium">运营者</strong>
              <span className="text-gray-600">学校只有这一个后台账号</span>
            </p>
          </div>
          {leaveFailure !== undefined && (
            <p className="mt-3 text-xs text-gray-700" role="alert">
              {leaveFailure}
            </p>
          )}
          <Button className="mt-3" block size="small" onClick={leave} disabled={leaving}>
            {leaving ? '正在退出' : '退出登录'}
          </Button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-[69px] items-center justify-between gap-4 border-b border-gray-200 bg-white px-6 py-4">
          <h1 id={titleId} className="text-lg font-semibold text-gray-900">
            {page.name}
          </h1>
          <div id={PAGE_ACTIONS_ID} className="flex flex-wrap items-center justify-end gap-2" />
        </header>
        <main aria-labelledby={titleId} className="w-full flex-1 p-6">
          <div key={tab}>{content[tab]}</div>
        </main>
      </div>
    </div>
  )
}

/** Before the session is known (checking it, or failing to): the page with nothing in the sidebar. */
export function Waiting({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center bg-gray-50 px-6 pt-24">
      <Brand />
      <main className="mt-8 w-full max-w-md">{children}</main>
    </div>
  )
}
