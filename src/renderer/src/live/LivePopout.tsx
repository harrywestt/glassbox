import { useEffect, useMemo, useState } from 'react'
import { sessionReducer, type SessionState } from '../session'
import type { Tab } from '../tabs'
import type { SessionEvent } from '../../../shared/events'
import { useTheme } from '../theme'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { LiveScreen, type LiveNav } from './LiveScreen'
import { tr } from '../../../shared/i18n'

/**
 * Live in its own window, for a second screen. It starts from the main window's copy of the
 * session, then follows the session's events itself; anything it opens opens in the main window.
 */
export function LivePopout({ tabId }: { tabId: string }) {
  useTheme()
  const [state, setState] = useState<{ tab: Tab; s: SessionState } | 'loading' | 'gone'>('loading')

  useEffect(() => {
    let ready = false
    let queue: SessionEvent[] = []
    let pending = false
    // Many small events a second while Claude streams: applied together once a frame.
    const flush = () => {
      if (!pending) return
      pending = false
      const events = queue
      queue = []
      setState((p) => (typeof p === 'string' ? p : { ...p, s: events.reduce((s, event) => sessionReducer(s, { type: 'event', event }), p.s) }))
    }
    const off = window.glassbox.onEvent(({ tabId: id, event }) => {
      if (id !== tabId || !ready) return
      queue.push(event)
      if (pending) return
      pending = true
      requestAnimationFrame(flush)
      setTimeout(flush, 120)
    })
    void window.glassbox.live.snapshot(tabId).then((snap) => {
      const got = snap as { tab: Tab; s: SessionState } | null
      if (!got) return setState('gone')
      ready = true
      setState(got)
    })
    return off
  }, [tabId])

  const nav = useMemo<LiveNav>(
    () => ({
      show: (target) => void window.glassbox.live.show(tabId, target),
      tell: (text) => window.dispatchEvent(new CustomEvent('glassbox:live-tell', { detail: text }))
    }),
    [tabId]
  )

  useEffect(() => {
    if (typeof state !== 'string') document.title = tr('live.windowTitle', { name: state.tab.title ?? state.tab.cwd })
  }, [state])

  if (state === 'loading') return <div className="live live-popout live-loading">{tr('live.loading')}</div>
  if (state === 'gone') return <div className="live live-popout live-loading">{tr('live.gone')}</div>
  return (
    <ErrorBoundary where="live-popout">
      <LiveScreen tab={state.tab} s={state.s} nav={nav} active popout />
    </ErrorBoundary>
  )
}
