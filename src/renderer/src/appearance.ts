import { useSyncExternalStore } from 'react'
import { tr } from '../../shared/i18n'
import { AUTOMATION_DEFAULTS, type Automation } from '../../shared/events'
import { isHex, readableOn } from './colour'

export type ThemePreference = 'system' | 'dark' | 'light' | 'midnight' | 'dusk' | 'forest' | 'ember' | 'paper' | 'blossom' | 'carbon' | 'mint' | 'custom'
/** A theme you made: the four colours the rest is worked out from. */
export type CustomTheme = { base: 'dark' | 'light'; bg: string; surface: string; fg: string; accent: string }
export type ChatWidth = 'full' | 'wide' | 'comfortable'
export type TableStyle = 'striped' | 'grid' | 'minimal'
/** How the panels sit over a moving background: from clear glass to fully solid. */
export type PanelFrost = 'clear' | 'frosted' | 'heavy' | 'solid'
export type BackdropKind = 'none' | 'lava' | 'stars' | 'fireflies' | 'waves' | 'aurora' | 'snow' | 'ripples'
export type Spinner = 'spark' | 'orbit' | 'heartbeat' | 'equaliser' | 'shapeshift' | 'snake' | 'ripple' | 'bounce'

export type Appearance = {
  theme: ThemePreference
  /** Your own theme, once you've made one (kept when you switch away from it). */
  customTheme?: CustomTheme
  accent: string // an ACCENTS id, 'theme' (a named theme's own), or a colour you picked (#rrggbb)
  uiScale: number // whole-app zoom, 0.9 – 1.25
  chatSize: number // conversation text, px
  chatWidth: ChatWidth
  tableStyle: TableStyle
  /** The animation beside "Working…" while Claude works. */
  spinner: Spinner
  /** A slow, faint moving background behind the whole app. Off unless picked. */
  backdrop: BackdropKind
  /** How strongly the background shows, 1 (faint) to 4 (strong). */
  backdropStrength: 1 | 2 | 3 | 4
  /** Frosted: the panels let the background faintly through. Solid: it shows only around and behind them. */
  backdropPanels: PanelFrost
  /** Desktop notifications (and a flashing taskbar button) when a session needs you or finishes. Off unless turned on. */
  notifications: boolean
  /** "While you were away": a digest of what changed when you come back to a session. On unless turned off. */
  awayDigest: boolean
  /** The automatic features (quick answers, the watchdog, voice). */
  automation: Automation
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
/** The accent Glassbox starts with. */
export const DEFAULT_ACCENT = '#49c1e9'
const DEFAULTS: Appearance = { theme: 'system', accent: DEFAULT_ACCENT, uiScale: 1, chatSize: 15, chatWidth: 'full', tableStyle: 'striped', spinner: 'spark', backdrop: 'none', backdropStrength: 2, backdropPanels: 'frosted', notifications: false, awayDigest: false, automation: AUTOMATION_DEFAULTS }

function load(): Appearance {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Appearance> | null
    // Older builds stored only the theme, under its own key.
    const legacyTheme = localStorage.getItem('glassbox.theme') as ThemePreference | null
    const merged = { ...DEFAULTS, ...(legacyTheme ? { theme: legacyTheme } : {}), ...(saved ?? {}) }
    const automation = { ...AUTOMATION_DEFAULTS, ...(saved?.automation ?? {}) }
    // Once, for settings saved before the token rule: quick answers and the watchdog's nudges are
    // model calls nobody asked for, so they start off (turn them back on in Settings).
    if (saved?.automation && !localStorage.getItem('glassbox.tokenRule')) {
      automation.quickAnswers = false
      automation.watchdog = false
      automation.autoCommit = localStorage.getItem('glassbox.autoCommit') === 'on'
      localStorage.setItem('glassbox.tokenRule', '1')
      localStorage.setItem(KEY, JSON.stringify({ ...saved, automation }))
    }
    return { ...merged, automation }
  } catch {
    return DEFAULTS
  }
}

let current = load()
const listeners = new Set<() => void>()

/** The settings as they are now (outside React). */
export const getAppearance = (): Appearance => current

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
  setAppearance({ ...DEFAULTS, customTheme: current.customTheme })
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current
  )
}

export function accentFor(a: Appearance, base: 'dark' | 'light'): string {
  // A colour you picked from the wheel, kept readable on this theme's darkest (or lightest) surface.
  if (isHex(a.accent)) return readableOn(a.accent, base === 'dark' ? '#16181b' : '#e9ecef', base)
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
