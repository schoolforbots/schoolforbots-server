import { useEffect, useId, useState, type ReactNode } from 'react'
import { LESSON_QUEUE_PATH, lessonsToReview, logout, useLoad, type ApiError, type LessonQueue } from './api.js'
import { Data } from './pages/Data.js'
import { Notices } from './pages/Notices.js'
import { Review } from './pages/Review.js'
import { Students } from './pages/Students.js'
import { Switches } from './pages/Switches.js'
import { Weekly } from './pages/Weekly.js'

// The frame of the admin pages, after HyperUI's analytics dashboard: the school's name and the pages down a white
// sidebar, logging out at its foot; on the right, a header naming the page and the page itself on the light grey.

/** The school's name, at the top of the sidebar and over the login card. */
export function Brand() {
  return (
    <p className="flex items-center gap-3">
      <span aria-hidden="true" className="grid size-9 place-items-center rounded-lg bg-brand text-base font-semibold text-white">
        校
      </span>
      <span className="flex flex-col leading-tight">
        <span className="text-[15px] font-semibold text-gray-900">机器人网校</span>
        <span className="text-xs text-gray-600">后台</span>
      </span>
    </p>
  )
}

/** The pages, in the order of the sidebar, each with what it is for. */
const PAGES = [
  { key: 'data', name: '学校数据', about: '今天和昨天的数字，要做的事，最近几天的曲线。' },
  { key: 'review', name: '审课', about: '开门以前审完这几天的课；用红笔标出的地方逐处看过。' },
  { key: 'weekly', name: '每周复盘', about: '一周的上课、课程、老师、审核、学生和花费，以及要改的词库。' },
  { key: 'students', name: '查学生', about: '按学号查资料、消息和违纪记录，也在这里停课、退学、解除处罚。' },
  { key: 'switches', name: '开关', about: '学校运行时的开关和维护。每次切换都先确认。' },
  { key: 'notices', name: '公告', about: '写公告、发布到网站、撤下或删掉。' },
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
          'flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm font-medium ' +
          (current
            ? 'bg-brand-tint text-brand shadow-[inset_3px_0_0_var(--color-brand)]'
            : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900')
        }
      >
        {page.name}
        {badge !== undefined && (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">{badge}</span>
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
    switches: <Switches />,
    notices: <Notices />,
  }

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-gray-200 bg-white">
        <div className="px-5 pt-5 pb-6">
          <Brand />
        </div>
        <nav aria-label="后台页面" className="flex-1 overflow-y-auto px-3">
          <ul className="flex flex-col gap-1">
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
        <div className="flex flex-col gap-2 border-t border-gray-200 px-5 py-4">
          {leaveFailure !== undefined && (
            <p className="text-[13px] text-gray-700" role="alert">
              {leaveFailure}
            </p>
          )}
          <button
            type="button"
            onClick={leave}
            disabled={leaving}
            className="ui-button inline-flex h-9 items-center justify-center rounded-md border border-edge bg-white px-4 text-sm font-medium text-gray-900 shadow-xs hover:bg-gray-50 disabled:border-gray-200 disabled:bg-gray-100 disabled:text-disabled"
          >
            {leaving ? '正在退出' : '退出登录'}
          </button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-gray-200 bg-white px-8 py-5">
          <h1 id={titleId} className="text-xl font-semibold text-gray-900">
            {page.name}
          </h1>
          <p className="mt-1 text-sm text-gray-600">{page.about}</p>
        </header>
        <main aria-labelledby={titleId} className="mx-auto w-full max-w-[1440px] flex-1 px-8 py-6">
          {content[tab]}
        </main>
      </div>
    </div>
  )
}

/** Before the session is known (checking it, or failing to): the page with nothing in the sidebar. */
export function Waiting({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center px-6 pt-24">
      <Brand />
      <main className="mt-8 w-full max-w-md">{children}</main>
    </div>
  )
}
