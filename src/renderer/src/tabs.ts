import { newSession, sessionReducer, type SessionAction, type SessionState } from './session'
import type { PendingStart, SessionKind } from './launch'

export const DASHBOARD = 'dashboard'

/**
 * `view`: how much of the engineering side the session shows. Everyday is the conversation with
 * diagrams, decisions and files; Engineering adds the map, changes, git, services and tests.
 * Unset, it follows the folder (a git repository opens in Engineering).
 */
export type SessionViewMode = 'everyday' | 'engineering'
export type Tab = { id: string; cwd: string; title: string; resumeId?: string; kind?: SessionKind; pendingStart?: PendingStart; view?: SessionViewMode; /** A QA session that also screenshots every screen for the UX reviewer. */ deep?: boolean }

/** What the session host needs to know about the tab's kind (a deep QA run sends every screenshot to the UX reviewer). */
export const hostKind = (t: Tab): string | undefined => (t.kind === 'qa' && t.deep ? 'qa-deep' : t.kind)

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
/** The last list that had tabs in it: a fall-back if the main copy is lost or unreadable. */
const PREV = 'glassbox.tabs.prev'

type Saved = { tabs: Tab[]; active: string }
const parse = (raw: string | null | undefined): Saved | null => {
  try {
    const v = raw ? (JSON.parse(raw) as Saved) : null
    return v && Array.isArray(v.tabs) ? v : null
  } catch {
    return null
  }
}

/**
 * The tabs you had open. Kept three ways, read in turn: the page's storage, a backup of the last
 * list with tabs in it, and a copy on disk the main process writes safely (temp file, then rename).
 * A crash can lose the newest storage writes or leave one copy unreadable; it shouldn't lose all three.
 */
export function loadTabs(): AppState {
  const local = (() => {
    try {
      return { main: localStorage.getItem(KEY), prev: localStorage.getItem(PREV) }
    } catch {
      return { main: null, prev: null }
    }
  })()
  const main = parse(local.main)
  // An empty list you closed down to stays empty; a missing or unreadable one falls back.
  const saved = main ?? parse(local.prev) ?? parse(window.glassbox.tabs.loadSync())
  if (saved) {
    // Each tab once (a duplicate would show the same session twice).
    const tabs = saved.tabs.filter((t, i, all) => all.findIndex((x) => x.id === t.id) === i)
    return { tabs, active: saved.active ?? DASHBOARD, sessions: Object.fromEntries(tabs.map((t) => [t.id, newSession()])) }
  }
  return { tabs: [], active: DASHBOARD, sessions: {} }
}

/** Persist open tabs, pointing each at its session id so it can be resumed on next launch. */
export function saveTabs(state: AppState) {
  const tabs = state.tabs.map((t) => ({ ...t, resumeId: state.sessions[t.id]?.sessionId ?? t.resumeId, title: tabTitle(t, state.sessions[t.id]) }))
  const json = JSON.stringify({ tabs, active: state.active })
  try {
    localStorage.setItem(KEY, json)
    if (tabs.length) localStorage.setItem(PREV, json)
  } catch {
    /* the disk copy below still goes */
  }
  void window.glassbox.tabs.save(json).catch(() => undefined)
}

/** What a save depends on: the tabs, which is open, and each one's session id (not every streamed word). */
export function tabsSignature(state: AppState): string {
  return JSON.stringify([state.active, state.tabs.map((t) => [t.id, t.title, t.cwd, state.sessions[t.id]?.sessionId ?? t.resumeId ?? '', tabTitle(t, state.sessions[t.id])])])
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
      // A tab that's already open is shown, not opened twice (two views of one session would each answer for it).
      if (state.tabs.some((t) => t.id === action.tab.id)) return { ...state, active: action.tab.id }
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
