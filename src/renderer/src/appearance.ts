import { useSyncExternalStore } from 'react'
import { tr } from '../../shared/i18n'

export type ThemePreference = 'system' | 'dark' | 'light'
export type ChatWidth = 'full' | 'wide' | 'comfortable'
export type TableStyle = 'striped' | 'grid' | 'minimal'

export type Appearance = {
  theme: ThemePreference
  accent: string // an ACCENTS id
  uiScale: number // whole-app zoom, 0.9 – 1.25
  chatSize: number // conversation text, px
  chatWidth: ChatWidth
  tableStyle: TableStyle
  /** Desktop notifications (and a flashing taskbar button) when a session needs you or finishes. Off unless turned on. */
  notifications: boolean
  /** "While you were away": a digest of what changed when you come back to a session. On unless turned off. */
  awayDigest: boolean
}

/** Accent colours, each tuned separately for dark and light backgrounds. */
export const ACCENTS: { id: string; label: string; dark: string; light: string }[] = [
  { id: 'teal', label: tr('appearance.accent.teal'), dark: '#4fb3c8', light: '#0e7c90' },
  { id: 'blue', label: tr('appearance.accent.blue'), dark: '#6ea8fe', light: '#2563c9' },
  { id: 'violet', label: tr('appearance.accent.violet'), dark: '#a78bfa', light: '#6d4fd6' },
  { id: 'green', label: tr('appearance.accent.green'), dark: '#5cc98a', light: '#1f8a4f' },
  { id: 'amber', label: tr('appearance.accent.amber'), dark: '#e8b24f', light: '#a86a00' },
  { id: 'rose', label: tr('appearance.accent.rose'), dark: '#f07892', light: '#c23a5a' }
]

export const UI_SCALES = [0.9, 1, 1.1, 1.25]
export const CHAT_SIZES = [13, 14, 15, 16, 18]
const WIDTHS: Record<ChatWidth, string> = { full: 'none', wide: '1200px', comfortable: '860px' }

const KEY = 'glassbox.appearance'
const DEFAULTS: Appearance = { theme: 'system', accent: 'blue', uiScale: 1, chatSize: 15, chatWidth: 'full', tableStyle: 'striped', notifications: false, awayDigest: true }

function load(): Appearance {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Appearance> | null
    // Older builds stored only the theme, under its own key.
    const legacyTheme = localStorage.getItem('glassbox.theme') as ThemePreference | null
    return { ...DEFAULTS, ...(legacyTheme ? { theme: legacyTheme } : {}), ...(saved ?? {}) }
  } catch {
    return DEFAULTS
  }
}

let current = load()
const listeners = new Set<() => void>()

export function setAppearance(change: Partial<Appearance>) {
  current = { ...current, ...change }
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    /* kept for this run only */
  }
  applyLayout(current)
  listeners.forEach((l) => l())
}

export function resetAppearance() {
  setAppearance(DEFAULTS)
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current
  )
}

export function accentFor(a: Appearance, base: 'dark' | 'light'): string {
  const preset = ACCENTS.find((x) => x.id === a.accent) ?? ACCENTS[0]
  return preset[base]
}

/** Size and width settings, as CSS variables and the window zoom. Colours are applied by the theme. */
function applyLayout(a: Appearance) {
  const root = document.documentElement
  root.style.setProperty('--chat-size', `${a.chatSize}px`)
  root.style.setProperty('--chat-code-size', `${Math.round(a.chatSize * 0.88)}px`)
  root.style.setProperty('--reading-width', WIDTHS[a.chatWidth])
  root.dataset.tables = a.tableStyle
  // The native window buttons don't zoom, so keep the title bar at their height.
  root.style.setProperty('--titlebar-h', `${40 / a.uiScale}px`)
  window.glassbox.setZoom(a.uiScale)
}

applyLayout(current)
