import { isHex, mix, textOn } from './colour'
import { useEffect, useMemo, useState } from 'react'
import { accentFor, setAppearance, useAppearance, type Appearance, type CustomTheme } from './appearance'

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
  },
  // Midnight: a deep navy desk for late nights, blue light from the screens.
  midnight: {
    base: 'dark',
    bg: '#0f1420',
    surface: '#131a28',
    surface2: '#0a0e17',
    elevated: '#1b2335',
    border: '#232d41',
    fg: '#e3e8f2',
    muted: '#8f9ab0',
    subtle: '#6f7a90',
    accent: '#7aa2ff',
    accentFg: '#0a1022',
    accentSoft: 'color-mix(in srgb, #7aa2ff 16%, transparent)',
    ok: '#4cc38a',
    warn: '#e8b04f',
    err: '#f26b6b',
    info: '#7aa2ff',
    tallyLive: '#ff5a4a',
    userBubble: '#192133',
    selection: '#25365c'
  },
  // Dusk: plum and violet, with a neon-pink accent.
  dusk: {
    base: 'dark',
    bg: '#1e1a2a',
    surface: '#241f33',
    surface2: '#17141f',
    elevated: '#2e2841',
    border: '#3b3451',
    fg: '#ece8f5',
    muted: '#a69ebd',
    subtle: '#867e9d',
    accent: '#f28fca',
    accentFg: '#2a0f20',
    accentSoft: 'color-mix(in srgb, #f28fca 16%, transparent)',
    ok: '#6fd6a0',
    warn: '#f2c66d',
    err: '#ff6f8a',
    info: '#9d8cff',
    tallyLive: '#ff5c7a',
    userBubble: '#2c2641',
    selection: '#463760'
  },
  // Forest: deep pine greens with a moss accent.
  forest: {
    base: 'dark',
    bg: '#172019',
    surface: '#1c261f',
    surface2: '#111813',
    elevated: '#243028',
    border: '#2e3b33',
    fg: '#e2ebe4',
    muted: '#97a89c',
    subtle: '#79897e',
    accent: '#a3d36f',
    accentFg: '#13200a',
    accentSoft: 'color-mix(in srgb, #a3d36f 16%, transparent)',
    ok: '#4fbf86',
    warn: '#e3b25a',
    err: '#ef6f5e',
    info: '#6fb7d6',
    tallyLive: '#ff5a46',
    userBubble: '#212c25',
    selection: '#2e4a37'
  },
  // Ember: warm charcoal by firelight, with an orange accent.
  ember: {
    base: 'dark',
    bg: '#1f1b18',
    surface: '#25201c',
    surface2: '#171412',
    elevated: '#2f2924',
    border: '#3b332c',
    fg: '#f0e9e2',
    muted: '#ada196',
    subtle: '#8d8278',
    accent: '#ff9b54',
    accentFg: '#2a1405',
    accentSoft: 'color-mix(in srgb, #ff9b54 16%, transparent)',
    ok: '#8cc56b',
    warn: '#f2c14e',
    err: '#f2675a',
    info: '#7fb0d9',
    tallyLive: '#ff4f3f',
    userBubble: '#2c2621',
    selection: '#4b3727'
  },
  // Paper: warm notebook paper and ink-blue.
  paper: {
    base: 'light',
    bg: '#fbf8f2',
    surface: '#f4efe5',
    surface2: '#e9e2d5',
    elevated: '#ece5d8',
    border: '#ddd4c4',
    fg: '#2b2620',
    muted: '#655b4f',
    subtle: '#7f7466',
    accent: '#2f5d8a',
    accentFg: '#ffffff',
    accentSoft: 'color-mix(in srgb, #2f5d8a 12%, transparent)',
    ok: '#3d7d3a',
    warn: '#965f00',
    err: '#b3362b',
    info: '#2f5d8a',
    tallyLive: '#d6301f',
    userBubble: '#efe8db',
    selection: '#d6e0ea'
  },
  // Blossom: soft pink with a berry accent.
  blossom: {
    base: 'light',
    bg: '#fdf8f9',
    surface: '#f8eff2',
    surface2: '#f0e2e7',
    elevated: '#f2e6ea',
    border: '#e6d3da',
    fg: '#2e2226',
    muted: '#6c575e',
    subtle: '#876f77',
    accent: '#c2407a',
    accentFg: '#ffffff',
    accentSoft: 'color-mix(in srgb, #c2407a 12%, transparent)',
    ok: '#2f8657',
    warn: '#9e6008',
    err: '#c8352b',
    info: '#5b63c8',
    tallyLive: '#e2301f',
    userBubble: '#f6e9ee',
    selection: '#f3d3e1'
  },
  // Carbon: near-black with bright text and a violet accent, for the darkest rooms.
  carbon: {
    base: 'dark',
    bg: '#111113',
    surface: '#151517',
    surface2: '#0b0b0c',
    elevated: '#1d1d20',
    border: '#27272b',
    fg: '#f2f2f4',
    muted: '#a2a2ab',
    subtle: '#7e7e88',
    accent: '#b693ff',
    accentFg: '#1a0b33',
    accentSoft: 'color-mix(in srgb, #b693ff 16%, transparent)',
    ok: '#4fd18b',
    warn: '#f2b84b',
    err: '#ff6b6b',
    info: '#7cb7ff',
    tallyLive: '#ff4f3f',
    userBubble: '#1b1b1e',
    selection: '#2f2749'
  },
  // Mint: a fresh, pale green-tinted light theme with a deep teal accent.
  mint: {
    base: 'light',
    bg: '#f8fcfa',
    surface: '#eff7f3',
    surface2: '#e2eee8',
    elevated: '#e5f0ea',
    border: '#cfe0d7',
    fg: '#17241e',
    muted: '#4c6156',
    subtle: '#687d72',
    accent: '#0f8a6a',
    accentFg: '#ffffff',
    accentSoft: 'color-mix(in srgb, #0f8a6a 12%, transparent)',
    ok: '#1f8a4f',
    warn: '#985f00',
    err: '#c23b3b',
    info: '#2a6fb0',
    tallyLive: '#e2301f',
    userBubble: '#e8f3ed',
    selection: '#cdeadf'
  }
}

/** The themes offered in Settings → Appearance, in order: the system's own, Glassbox dark and light, then the named ones. */
export const THEME_CHOICES = ['system', 'dark', 'light', 'midnight', 'dusk', 'forest', 'ember', 'carbon', 'paper', 'blossom', 'mint'] as const

/**
 * A theme you made: four colours you pick, and every other shade worked out from them (borders,
 * the darker strip, muted text, selection); status colours come from Glassbox's own theme.
 */
export function customTokens(c: CustomTheme): ThemeTokens {
  const g = THEMES[c.base === 'dark' ? 'glassbox-dark' : 'glassbox-light']
  const dark = c.base === 'dark'
  return {
    ...g,
    base: c.base,
    bg: c.bg,
    surface: c.surface,
    surface2: dark ? mix(c.bg, '#000000', 0.28) : mix(c.surface, '#000000', 0.05),
    elevated: mix(c.surface, c.fg, dark ? 0.07 : 0.05),
    border: mix(c.bg, c.fg, dark ? 0.15 : 0.16),
    fg: c.fg,
    muted: mix(c.fg, c.bg, dark ? 0.33 : 0.3),
    subtle: mix(c.fg, c.bg, dark ? 0.46 : 0.42),
    accent: c.accent,
    accentFg: textOn(c.accent),
    accentSoft: `color-mix(in srgb, ${c.accent} ${dark ? 16 : 12}%, transparent)`,
    userBubble: mix(c.bg, c.fg, dark ? 0.07 : 0.05),
    selection: mix(c.bg, c.accent, dark ? 0.3 : 0.2)
  }
}

/** A custom theme to start from: the colours of the theme you're looking at. */
export const customFrom = (t: ThemeTokens): CustomTheme => ({ base: t.base, bg: t.bg, surface: t.surface, fg: t.fg, accent: isHex(t.accent) ? t.accent : THEMES[t.base === 'dark' ? 'glassbox-dark' : 'glassbox-light'].accent })

/** The tokens a theme choice stands for (system follows Windows between Glassbox dark and light). */
export function themeTokens(pref: string, systemDark = media.matches, custom?: CustomTheme): ThemeTokens {
  if (pref === 'custom' && custom) return customTokens(custom)
  if (THEMES[pref]) return THEMES[pref]
  const dark = pref === 'dark' || (pref === 'system' && systemDark)
  return THEMES[dark ? 'glassbox-dark' : 'glassbox-light']
}

export type { ThemePreference } from './appearance'

const media = window.matchMedia('(prefers-color-scheme: dark)')

function resolve(a: Appearance): ThemeTokens {
  const base = themeTokens(a.theme, media.matches, a.customTheme)
  // A named theme brings its own accent unless you pick another.
  if (a.accent === 'theme') return base
  const accent = accentFor(a, base.base)
  // A picked colour can be light or dark: text on it takes whichever of black and white reads.
  const accentFg = isHex(a.accent) || THEMES[a.theme] || a.theme === 'custom' ? textOn(accent) : base.accentFg
  return { ...base, accent, accentFg, accentSoft: `color-mix(in srgb, ${accent} ${base.base === 'dark' ? 16 : 12}%, transparent)` }
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
  useEffect(() => void window.glassbox.setAutomation(appearance.automation), [appearance.automation])

  const toggle = () => setAppearance({ theme: tokens.base === 'dark' ? 'light' : 'dark' })
  return { pref: appearance.theme, tokens, toggle }
}
