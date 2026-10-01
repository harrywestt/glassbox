import { useEffect, useMemo, useState } from 'react'
import { accentFor, setAppearance, useAppearance, type Appearance } from './appearance'

/**
 * Themes are plain token maps applied as CSS custom properties, so a user-defined theme
 * later is just another entry here (or one loaded from disk).
 */
export type ThemeTokens = {
  base: 'dark' | 'light'
  bg: string // editor / main surface
  surface: string // side bars, panels
  surface2: string // title bar, tab strip, inputs
  elevated: string // popovers, dialogs, hovered rows
  border: string
  fg: string
  muted: string
  subtle: string
  accent: string
  accentFg: string
  accentSoft: string
  ok: string
  warn: string
  err: string
  info: string
  tallyLive: string // the on-air lamp: a session Claude is working in
  userBubble: string
  selection: string
}

export const THEMES: Record<string, ThemeTokens> = {
  // Gallery: a control room at night. Graphite desk, charcoal monitors, hairline bezels.
  'glassbox-dark': {
    base: 'dark',
    bg: '#1c1f24',
    surface: '#22262c',
    surface2: '#16181b',
    elevated: '#2b3037',
    border: '#31363e',
    fg: '#e6e8eb',
    muted: '#9aa1ab',
    subtle: '#7c838d',
    accent: '#6ea8fe',
    accentFg: '#0b1524',
    accentSoft: 'rgba(110, 168, 254, 0.16)',
    ok: '#43b96f',
    warn: '#e5a53c',
    err: '#f0604f',
    info: '#6aa6e8',
    tallyLive: '#ff4f3f',
    userBubble: '#282c33',
    selection: '#26395a'
  },
  // Gallery by day: pale desk, white monitors, grey bezels.
  'glassbox-light': {
    base: 'light',
    bg: '#ffffff',
    surface: '#f5f6f8',
    surface2: '#e9ecef',
    elevated: '#e6e9ed',
    border: '#d7dbe0',
    fg: '#15181c',
    muted: '#535b66',
    subtle: '#6c7480',
    accent: '#2563c9',
    accentFg: '#ffffff',
    accentSoft: 'rgba(37, 99, 201, 0.1)',
    ok: '#1c8649',
    warn: '#a66a00',
    err: '#c8352b',
    info: '#2563c9',
    tallyLive: '#e2301f',
    userBubble: '#eef0f3',
    selection: '#d6e3f7'
  }
}

export type { ThemePreference } from './appearance'

const media = window.matchMedia('(prefers-color-scheme: dark)')

function resolve(a: Appearance): ThemeTokens {
  const dark = a.theme === 'dark' || (a.theme === 'system' && media.matches)
  const base = THEMES[dark ? 'glassbox-dark' : 'glassbox-light']
  const accent = accentFor(a, base.base)
  return { ...base, accent, accentSoft: `color-mix(in srgb, ${accent} ${base.base === 'dark' ? 16 : 12}%, transparent)` }
}

function apply(t: ThemeTokens) {
  const root = document.documentElement
  root.dataset.theme = t.base
  root.style.colorScheme = t.base
  for (const [k, v] of Object.entries(t)) {
    if (k !== 'base') root.style.setProperty(`--${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`, v)
  }
  void window.glassbox.setTitleBar(t.surface2, t.fg)
}

export function useTheme() {
  const appearance = useAppearance()
  const [system, setSystem] = useState(media.matches)
  useEffect(() => {
    const update = () => setSystem(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const tokens = useMemo(() => resolve(appearance), [appearance, system])
  useEffect(() => apply(tokens), [tokens])
  // The main process sends notifications only when they're turned on.
  useEffect(() => void window.glassbox.setNotifications(appearance.notifications), [appearance.notifications])

  const toggle = () => setAppearance({ theme: tokens.base === 'dark' ? 'light' : 'dark' })
  return { pref: appearance.theme, tokens, toggle }
}
