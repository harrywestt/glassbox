import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { THEMES, useTheme, type ThemeTokens } from './theme'
import { appReducer, DASHBOARD, loadTabs, rememberView, saveTabs, type SessionViewMode } from './tabs'
import { disposeTerminal } from './work/TerminalTab'
import { TitleBar } from './components/TitleBar'
import { Dashboard } from './views/Dashboard'
import { SessionView } from './views/SessionView'
import { newId } from './lib'
import { NewSessionDialog, type LaunchRequest } from './components/NewSessionDialog'
import { Tooltips } from './components/Tooltips'
import { AdminPrompt } from './views/AdminCard'
import type { PendingStart, SessionKind } from './launch'
import { emptyRequirements } from '../../shared/events'
import { loadAccess } from './session-ui/AccessToggle'
import type { OpenTarget, Requirements } from '../../shared/events'
import { bangContext, type CommentTarget } from './session'
import { commentPrompt } from './review'
import { tr } from '../../shared/i18n'

const ThemeContext = createContext<ThemeTokens>(THEMES['glassbox-dark'])
export const useThemeTokens = () => useContext(ThemeContext)

export type AppActions = {
  openSession: (cwd: string, opts?: { resumeId?: string; title?: string; kind?: SessionKind; pendingStart?: PendingStart }) => void
  showLauncher: (cwd?: string) => void
  closeTab: (id: string) => void
  activate: (id: string) => void
  send: (tabId: string, text: string, display?: string, opts?: { plan?: boolean }) => Promise<void>
  /** "! command": run it yourself in the session's folder; Claude sees it with your next message. */
  runShell: (tabId: string, cwd: string, command: string) => void
  stopShell: (id: string) => void
  comment: (tabId: string, target: CommentTarget, text: string) => Promise<void>
  planStatus: (tabId: string, status: 'approved' | 'changes-requested') => void
  /** Bring up a view in a session (a file, the map on some modules…), with an optional note above it. */
  show: (tabId: string, target: OpenTarget, why?: string) => void
  /** Close questions without answering (Claude isn't told). */
  dismissQuestions: (tabId: string, ids: string[]) => void
  dismissLoader: (tabId: string, id: string) => void
  dismissAlert: (tabId: string, at: number) => void
  findingStatus: (tabId: string, id: string, status: 'sent' | 'dismissed') => void
  recordPrompt: (tabId: string, text: string) => void
  setRequirements: (tabId: string, req: Requirements) => void
  retarget: (tabId: string, cwd: string) => void
  /** Everyday or Engineering: how much of the engineering side this session shows. */
  setView: (tabId: string, view: SessionViewMode) => void
}

const ActionsContext = createContext<AppActions | null>(null)
export const useActions = () => useContext(ActionsContext)!

export function App() {
  const theme = useTheme()
  const [state, dispatch] = useReducer(appReducer, undefined, loadTabs)
  const opened = useRef(new Set<string>())
  const [launcher, setLauncher] = useState<{ cwd?: string } | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(
    () =>
      window.glassbox.onEvent(({ tabId, event }) => dispatch({ type: 'session', tabId, action: { type: 'event', event } })),
    []
  )

  // A desktop notification click brings its session to the front.
  useEffect(() => window.glassbox.onFocusTab((id) => dispatch({ type: 'activate', id })), [])

  useEffect(() => {
    const t = setTimeout(() => saveTabs(state), 300)
    return () => clearTimeout(t)
  }, [state])

  // Sessions start lazily, the first time their tab is shown, so restored tabs don't all spawn at launch.
  useEffect(() => {
    const tab = state.tabs.find((t) => t.id === state.active)
    if (!tab || opened.current.has(tab.id)) return
    opened.current.add(tab.id)
    void window.glassbox.session.open(tab.id, tab.cwd, tab.resumeId, loadAccess())
  }, [state.active, state.tabs])

  const actions = useMemo<AppActions>(
    () => ({
      openSession(cwd, opts) {
        const existing = opts?.resumeId
          ? stateRef.current.tabs.find((t) => t.resumeId === opts.resumeId || stateRef.current.sessions[t.id]?.sessionId === opts.resumeId)
          : undefined
        if (existing) return dispatch({ type: 'activate', id: existing.id })
        dispatch({ type: 'open', tab: { id: newId(), cwd, title: opts?.title ?? tr('app.newSession'), resumeId: opts?.resumeId, kind: opts?.kind, pendingStart: opts?.pendingStart } })
      },
      closeTab(id) {
        opened.current.delete(id)
        void window.glassbox.session.close(id)
        disposeTerminal(id)
        dispatch({ type: 'close', id })
      },
      activate: (id) => dispatch({ type: 'activate', id }),
      showLauncher: (cwd) => setLauncher({ cwd }),
      async send(tabId, text, display, opts) {
        const uuid = newId()
        dispatch({ type: 'session', tabId, action: { type: 'user-prompt', text: display ?? text, uuid } })
        // Commands you ran yourself since your last message go along with it (finished ones only).
        const bangs = Object.values(stateRef.current.sessions[tabId]?.bangs ?? {}).filter((b) => !b.sent && b.status !== 'running')
        if (bangs.length) dispatch({ type: 'session', tabId, action: { type: 'bang-sent', ids: bangs.map((b) => b.id) } })
        await window.glassbox.session.send(tabId, bangs.length ? `${bangContext(bangs)}\n\n${text}` : text, { uuid, plan: opts?.plan })
      },
      runShell(tabId, cwd, command) {
        const id = newId()
        dispatch({ type: 'session', tabId, action: { type: 'bang-start', id, command } })
        void window.glassbox.session.runShell(tabId, id, cwd, command)
      },
      stopShell: (id) => void window.glassbox.session.stopShell(id),
      async comment(tabId, target, text) {
        const uuid = newId()
        dispatch({ type: 'session', tabId, action: { type: 'comment', text, target, uuid } })
        await window.glassbox.session.send(tabId, commentPrompt(target, text), { uuid, priority: 'now' })
      },
      planStatus: (tabId, status) => dispatch({ type: 'session', tabId, action: { type: 'plan-status', status } }),
      show: (tabId, target, why) => dispatch({ type: 'session', tabId, action: { type: 'show', target, why } }),
      dismissQuestions: (tabId, ids) => dispatch({ type: 'session', tabId, action: { type: 'dismiss-questions', ids } }),
      dismissLoader: (tabId, id) => dispatch({ type: 'session', tabId, action: { type: 'dismiss-loader', id } }),
      dismissAlert: (tabId, at) => dispatch({ type: 'session', tabId, action: { type: 'dismiss-alert', at } }),
      findingStatus: (tabId, id, status) => dispatch({ type: 'session', tabId, action: { type: 'finding-status', id, status } }),
      recordPrompt: (tabId, text) => dispatch({ type: 'session', tabId, action: { type: 'user-prompt', text } }),
      setRequirements(tabId, req) {
        dispatch({ type: 'session', tabId, action: { type: 'requirements', requirements: req } })
        void window.glassbox.session.setRequirements(tabId, req)
      },
      setView: (tabId, view) => (rememberView(view), dispatch({ type: 'view', id: tabId, view })),
      retarget(tabId, cwd) {
        const tab = stateRef.current.tabs.find((t) => t.id === tabId)
        if (!tab) return
        tab.cwd = cwd
        opened.current.add(tabId)
        void window.glassbox.session.open(tabId, cwd, undefined, loadAccess())
        dispatch({ type: 'activate', id: tabId })
      }
    }),
    []
  )

  // Sessions started from the launcher send their first message as soon as Claude is ready.
  useEffect(() => {
    for (const tab of state.tabs) {
      const s = state.sessions[tab.id]
      if (!tab.pendingStart || s?.status !== 'ready') continue
      const start = tab.pendingStart
      dispatch({ type: 'started', id: tab.id })
      if (start.requirements) actions.setRequirements(tab.id, { ...emptyRequirements, ...s.requirements, ...start.requirements })
      void actions.send(tab.id, start.prompt, start.display, { plan: start.plan })
    }
  }, [state.tabs, state.sessions, actions])

  const cycleTabs = useCallback((dir: 1 | -1) => {
    const ids = [DASHBOARD, ...stateRef.current.tabs.map((t) => t.id)]
    const i = ids.indexOf(stateRef.current.active)
    dispatch({ type: 'activate', id: ids[(i + dir + ids.length) % ids.length] })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return
      if (e.key === 'Tab') {
        e.preventDefault()
        cycleTabs(e.shiftKey ? -1 : 1)
      } else if (e.key.toLowerCase() === 'w' && stateRef.current.active !== DASHBOARD) {
        e.preventDefault()
        actions.closeTab(stateRef.current.active)
      } else if (e.key.toLowerCase() === 't') {
        e.preventDefault()
        setLauncher({ cwd: stateRef.current.tabs.find((t) => t.id === stateRef.current.active)?.cwd })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, cycleTabs])

  const activeTab = state.tabs.find((t) => t.id === state.active)

  return (
    <ThemeContext.Provider value={theme.tokens}>
      <ActionsContext.Provider value={actions}>
        <div className="app">
          <TitleBar state={state} dispatch={dispatch} themePref={theme.pref} onToggleTheme={theme.toggle} themeBase={theme.tokens.base} />
          <div className="app-body">
            <div className="view" hidden={state.active !== DASHBOARD}>
              <Dashboard tabs={state.tabs} sessions={state.sessions} visible={state.active === DASHBOARD} active={state.active} />
            </div>
            {state.tabs.map((tab) => (
              <div key={tab.id} className="view" hidden={tab !== activeTab}>
                {opened.current.has(tab.id) && <SessionView tab={tab} session={state.sessions[tab.id]} active={tab === activeTab} peers={state.tabs.filter((t) => t.id !== tab.id && state.sessions[t.id]).map((t) => ({ tab: t, s: state.sessions[t.id] }))} />}
              </div>
            ))}
          </div>
          <Tooltips />
          <AdminPrompt />
          {launcher && (
            <NewSessionDialog
              initialCwd={launcher.cwd}
              onClose={() => setLauncher(null)}
              onLaunch={(r: LaunchRequest) => {
                setLauncher(null)
                actions.openSession(r.cwd, { title: r.title, kind: r.kind, pendingStart: r.start })
              }}
            />
          )}
        </div>
      </ActionsContext.Provider>
    </ThemeContext.Provider>
  )
}
