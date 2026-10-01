import { useEffect, useState } from 'react'

/**
 * The Browser's tabs, per session. Kept outside React so the tabs (and the pages in them) survive
 * switching views, and so Claude's browser tools can open a tab and wait for its page to be ready.
 * Every tab shares one saved profile, so sign-ins and cookies carry across tabs and restarts.
 */

export type BrowserTabState = { id: string; url: string; title?: string; icon?: string; loading?: boolean; /** The page's webContents id once it's attached (what Claude's tools drive). */ wcId?: number }
type State = { tabs: BrowserTabState[]; active: string | null }

const states = new Map<string, State>()
const listeners = new Map<string, Set<() => void>>()
const waiters = new Map<string, ((wcId: number) => void)[]>()
let seq = 1

const get = (sid: string): State => states.get(sid) ?? { tabs: [], active: null }
function set(sid: string, next: State) {
  states.set(sid, next)
  for (const l of listeners.get(sid) ?? []) l()
}

export function useBrowser(sid: string): State {
  const [, bump] = useState(0)
  useEffect(() => {
    const l = () => bump((n) => n + 1)
    const all = listeners.get(sid) ?? new Set()
    all.add(l)
    listeners.set(sid, all)
    return () => void all.delete(l)
  }, [sid])
  return get(sid)
}

export function browserTabs(sid: string): BrowserTabState[] {
  return get(sid).tabs
}

export function activeBrowserTab(sid: string): string | null {
  return get(sid).active
}

/** Open a page: in a new tab, or (newTab false) in the current one. Returns the tab's id. */
export function openInBrowser(sid: string, url: string, newTab = true): string {
  const s = get(sid)
  const current = s.tabs.find((t) => t.id === s.active)
  if (!newTab && current) {
    set(sid, { ...s, tabs: s.tabs.map((t) => (t.id === current.id ? { ...t, url, loading: true } : t)) })
    return current.id
  }
  const id = `b${seq++}`
  set(sid, { tabs: [...s.tabs, { id, url, loading: true }], active: id })
  return id
}

export function closeBrowserTab(sid: string, id: string) {
  const s = get(sid)
  const i = s.tabs.findIndex((t) => t.id === id)
  const tabs = s.tabs.filter((t) => t.id !== id)
  set(sid, { tabs, active: s.active === id ? (tabs[Math.max(0, i - 1)]?.id ?? null) : s.active })
}

export function activateBrowserTab(sid: string, id: string) {
  set(sid, { ...get(sid), active: id })
}

export function updateBrowserTab(sid: string, id: string, patch: Partial<BrowserTabState>) {
  const s = get(sid)
  if (!s.tabs.some((t) => t.id === id)) return
  set(sid, { ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) })
  if (patch.wcId !== undefined) {
    for (const w of waiters.get(`${sid}:${id}`) ?? []) w(patch.wcId)
    waiters.delete(`${sid}:${id}`)
  }
}

/** The tab's page, once it's attached (Claude's browser_open waits on this). */
export function waitForPage(sid: string, id: string, ms = 15000): Promise<number> {
  const t = get(sid).tabs.find((x) => x.id === id)
  if (t?.wcId !== undefined) return Promise.resolve(t.wcId)
  return new Promise((resolve, reject) => {
    const key = `${sid}:${id}`
    const timer = setTimeout(() => reject(new Error('The browser tab didn’t open in time.')), ms)
    waiters.set(key, [...(waiters.get(key) ?? []), (wc) => (clearTimeout(timer), resolve(wc))])
  })
}
