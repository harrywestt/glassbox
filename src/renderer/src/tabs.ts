import { newSession, sessionReducer, type SessionAction, type SessionState } from './session'
import type { PendingStart, SessionKind } from './launch'

export const DASHBOARD = 'dashboard'

/**
 * `view`: how much of the engineering side the session shows. Everyday is the conversation with
 * diagrams, decisions and files; Engineering adds the map, changes, git, services and tests.
 * Unset, it follows the folder (a git repository opens in Engineering).
 */
export type SessionViewMode = 'everyday' | 'engineering'
export type Tab = { id: string; cwd: string; title: string; resumeId?: string; kind?: SessionKind; pendingStart?: PendingStart; view?: SessionViewMode }

export type AppState = { tabs: Tab[]; active: string; sessions: Record<string, SessionState> }

export type AppAction =
  | { type: 'open'; tab: Tab }
  | { type: 'close'; id: string }
  | { type: 'activate'; id: string }
  | { type: 'move'; id: string; to: number }
  | { type: 'started'; id: string }
  | { type: 'view'; id: string; view: SessionViewMode }
  | { type: 'session'; tabId: string; action: SessionAction }
  /** Several session updates applied in one go (events that arrived within one frame). */
  | { type: 'batch'; actions: AppAction[] }

const KEY = 'glassbox.tabs'

export function loadTabs(): AppState {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { tabs: Tab[]; active: string } | null
    if (saved?.tabs) {
      return { tabs: saved.tabs, active: saved.active ?? DASHBOARD, sessions: Object.fromEntries(saved.tabs.map((t) => [t.id, newSession()])) }
    }
  } catch {
    /* start fresh */
  }
  return { tabs: [], active: DASHBOARD, sessions: {} }
}

/** Persist open tabs, pointing each at its session id so it can be resumed on next launch. */
export function saveTabs(state: AppState) {
  const tabs = state.tabs.map((t) => ({ ...t, resumeId: state.sessions[t.id]?.sessionId ?? t.resumeId, title: tabTitle(t, state.sessions[t.id]) }))
  try {
    localStorage.setItem(KEY, JSON.stringify({ tabs, active: state.active }))
  } catch {
    /* not persisted this time */
  }
}

export function tabTitle(tab: Tab, session?: SessionState): string {
  if (tab.kind && tab.kind !== 'blank') return tab.title
  const first = session?.timeline.find((i) => i.kind === 'user')
  const text = first && first.kind === 'user' ? first.text : tab.title
  return text.length > 42 ? text.slice(0, 40) + '…' : text
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'open':
      return {
        tabs: [...state.tabs, action.tab],
        active: action.tab.id,
        sessions: { ...state.sessions, [action.tab.id]: newSession() }
      }
    case 'close': {
      const index = state.tabs.findIndex((t) => t.id === action.id)
      const tabs = state.tabs.filter((t) => t.id !== action.id)
      const sessions = { ...state.sessions }
      delete sessions[action.id]
      const active = state.active === action.id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? DASHBOARD) : state.active
      return { tabs, active, sessions }
    }
    case 'activate':
      return { ...state, active: action.id }
    case 'view':
      return { ...state, tabs: state.tabs.map((t) => (t.id === action.id ? { ...t, view: action.view } : t)) }
    case 'started':
      return { ...state, tabs: state.tabs.map((t) => (t.id === action.id ? { ...t, pendingStart: undefined } : t)) }
    case 'move': {
      const tabs = state.tabs.filter((t) => t.id !== action.id)
      const tab = state.tabs.find((t) => t.id === action.id)
      if (!tab) return state
      tabs.splice(action.to, 0, tab)
      return { ...state, tabs }
    }
    case 'batch':
      return action.actions.reduce(appReducer, state)
    case 'session': {
      const current = state.sessions[action.tabId]
      if (!current) return state
      return { ...state, sessions: { ...state.sessions, [action.tabId]: sessionReducer(current, action.action) } }
    }
  }
}

const VIEW_KEY = 'glassbox.view'
/** The view new sessions open in: Engineering, unless you last picked Everyday. */
export function defaultView(): SessionViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === 'everyday' ? 'everyday' : 'engineering'
  } catch {
    return 'engineering'
  }
}
/** Remember the view you picked, for the sessions you open next. */
export function rememberView(view: SessionViewMode) {
  try {
    localStorage.setItem(VIEW_KEY, view)
  } catch {
    /* this run only */
  }
}
