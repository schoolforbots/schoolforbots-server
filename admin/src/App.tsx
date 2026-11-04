import { useCallback, useEffect, useState } from 'react'
import { getSession, onSessionEnded, type ApiError } from './api.js'
import { Failed, Loading } from './components/States.js'
import { Layout, TopBar } from './Layout.js'
import { Login } from './pages/Login.js'
import { SchoolZone } from './zone.js'

type Stage =
  | { name: 'checking' }
  | { name: 'failed'; reason: string }
  | { name: 'login'; notice?: string }
  /** `zone`: the school's time zone, from the session. */
  | { name: 'in'; zone: string }

/** Asks the server whether the session is still good, then shows the login page or the admin pages. */
export function App() {
  const [stage, setStage] = useState<Stage>({ name: 'checking' })

  const check = useCallback(() => {
    setStage({ name: 'checking' })
    getSession().then(
      (session) => setStage({ name: 'in', zone: session.timeZone }),
      (error: ApiError) =>
        setStage(error.status === 401 ? { name: 'login' } : { name: 'failed', reason: error.message }),
    )
  }, [])

  useEffect(check, [check])

  // Any request of the admin pages that finds the session gone brings the login page back; the open tab stays in
  // the address, so logging in again returns to it.
  useEffect(
    () =>
      onSessionEnded(() =>
        setStage((current) =>
          current.name === 'in' ? { name: 'login', notice: '登录已经过期，重新登录后回到刚才那一页。' } : current,
        ),
      ),
    [],
  )

  switch (stage.name) {
    case 'checking':
      return (
        <>
          <TopBar />
          <main className="content">
            <Loading what="登录状态" />
          </main>
        </>
      )
    case 'failed':
      return (
        <>
          <TopBar />
          <main className="content">
            <Failed what="登录状态" reason={stage.reason} retry={check} />
          </main>
        </>
      )
    case 'login':
      return <Login notice={stage.notice} onLoggedIn={(zone) => setStage({ name: 'in', zone })} />
    case 'in':
      return (
        <SchoolZone value={stage.zone}>
          <Layout onLoggedOut={() => setStage({ name: 'login' })} />
        </SchoolZone>
      )
  }
}
