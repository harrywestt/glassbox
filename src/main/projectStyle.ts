import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

/**
 * The project's own look, read from its stylesheets (no model involved): the colour tokens it
 * declares as CSS variables (shadcn/Tailwind, design-token files, plain :root variables), a
 * Tailwind config's colours, or SCSS variables. Sketches are drawn in these so a proposed screen
 * looks like the app it's for. Mapped onto the names the sketch kit uses (--bg, --fg, --accent…).
 */

export type StyleVars = Partial<Record<'bg' | 'surface' | 'surface2' | 'elevated' | 'border' | 'fg' | 'muted' | 'subtle' | 'accent' | 'accentFg' | 'ok' | 'warn' | 'err' | 'info' | 'radius', string>>
export type ProjectStyle = { light?: StyleVars; dark?: StyleVars; source?: string }

/** Project names for each sketch colour, most specific first. */
const NAMES: Record<keyof StyleVars, string[]> = {
  bg: ['background', 'color-background', 'bg', 'background-color', 'color-bg', 'body-bg', 'page-bg', 'surface-background'],
  fg: ['foreground', 'color-foreground', 'fg', 'text', 'color-text', 'text-primary', 'body-color', 'text-color'],
  surface: ['card', 'color-card', 'surface', 'color-surface', 'panel', 'popover', 'bg-secondary', 'background-secondary'],
  surface2: ['input', 'color-input', 'muted', 'color-muted', 'secondary', 'color-secondary', 'surface-2'],
  elevated: ['popover', 'color-popover', 'elevated', 'surface-raised', 'accent', 'color-accent'],
  border: ['border', 'color-border', 'border-color', 'divider', 'line'],
  muted: ['muted-foreground', 'color-muted-foreground', 'text-muted', 'text-secondary', 'muted-text', 'secondary-text'],
  subtle: ['text-subtle', 'text-tertiary', 'placeholder'],
  accent: ['primary', 'color-primary', 'brand', 'color-brand', 'primary-color', 'accent-color', 'theme-primary'],
  accentFg: ['primary-foreground', 'color-primary-foreground', 'on-primary', 'primary-contrast'],
  ok: ['success', 'color-success', 'green'],
  warn: ['warning', 'color-warning', 'amber', 'yellow'],
  err: ['destructive', 'color-destructive', 'danger', 'error', 'color-error', 'red'],
  info: ['info', 'color-info', 'blue'],
  radius: ['radius', 'border-radius', 'radius-md']
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage', 'release', 'vendor', '.turbo', '.cache', 'bin', 'obj'])
const STYLE_FILE = /(^|[\\/])(globals?|index|app|main|styles?|theme|tokens?|variables|vars|colou?rs|base|tailwind)\.(css|scss|sass|less)$/i
const TW_CONFIG = /(^|[\\/])tailwind\.config\.(js|cjs|mjs|ts)$/i
const SAFE = /^[\w#%(),. -]{1,60}$/

const cache = new Map<string, { at: number; style: ProjectStyle }>()

export function projectStyle(cwd: string, stylesheet?: string): ProjectStyle {
  if (stylesheet) return named(cwd, stylesheet)
  const key = cwd.toLowerCase()
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.style
  let style: ProjectStyle = {}
  try {
    style = read(cwd)
  } catch {
    /* no style found */
  }
  cache.set(key, { at: Date.now(), style })
  return style
}

/** The colours from one stylesheet or Tailwind config the sketch names (relative to the project, or absolute). */
function named(cwd: string, stylesheet: string): ProjectStyle {
  const file = isAbsolute(stylesheet) ? stylesheet : join(cwd, stylesheet)
  try {
    const text = readFileSync(file, 'utf8')
    const sets = TW_CONFIG.test(file) ? { light: tailwind(text) } : cssSets(text)
    return { light: mapVars(sets.light ?? {}), dark: sets.dark ? mapVars(sets.dark) : undefined, source: relative(cwd, file).replace(/\\/g, '/') }
  } catch {
    return {}
  }
}

function read(cwd: string): ProjectStyle {
  const files = find(cwd)
  let best: { score: number; style: ProjectStyle } | null = null
  for (const file of files) {
    let text: string
    try {
      if (statSync(file).size > 400_000) continue
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const sets = TW_CONFIG.test(file) ? { light: tailwind(text) } : cssSets(text)
    const light = mapVars(sets.light ?? {})
    const dark = sets.dark ? mapVars(sets.dark) : undefined
    const score = Object.keys(light).length + (light.accent ? 4 : 0) + (light.bg ? 2 : 0) + (dark ? Object.keys(dark).length / 2 : 0)
    if (score >= 3 && (!best || score > best.score)) best = { score, style: { light, dark, source: relative(cwd, file).replace(/\\/g, '/') } }
  }
  return best?.style ?? {}
}

/** Likely stylesheet and Tailwind config files, a few folders deep. */
function find(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || out.length > 40) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (SKIP.has(name) || name.startsWith('.')) continue
      const full = join(dir, name)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDir) walk(full, depth + 1)
      else if (STYLE_FILE.test(name) || TW_CONFIG.test(name)) out.push(full)
    }
  }
  if (existsSync(root)) walk(root, 0)
  return out
}

/** CSS custom properties in :root/@theme (light) and dark-mode selectors (dark). SCSS $variables count as light. */
function cssSets(text: string): { light: Record<string, string>; dark?: Record<string, string> } {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const light: Record<string, string> = {}
  const dark: Record<string, string> = {}
  const block = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = block.exec(clean))) {
    const selector = m[1].trim()
    const isDark = /\.dark\b|\[data-theme=["']?dark|data-mode=["']?dark|prefers-color-scheme:\s*dark|\.theme-dark/i.test(selector) || /prefers-color-scheme:\s*dark/i.test(clean.slice(Math.max(0, m.index - 80), m.index))
    const isRoot = /(^|,|\s)(:root|html|body|@theme)\b|^:host/i.test(selector) || selector.endsWith('@theme') || /@theme/.test(selector)
    if (!isDark && !isRoot) continue
    const target = isDark ? dark : light
    for (const d of m[2].matchAll(/--([\w-]+)\s*:\s*([^;]+);?/g)) target[d[1].toLowerCase()] = d[2].trim()
  }
  for (const d of clean.matchAll(/^\s*\$([\w-]+)\s*:\s*([^;]+);/gm)) light[d[1].toLowerCase()] ??= d[2].replace(/!default/, '').trim()
  return { light, dark: Object.keys(dark).length ? dark : undefined }
}

/** A Tailwind config's theme colours: primary: '#…' or primary: { DEFAULT: '#…', foreground: '#…' }. */
function tailwind(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of text.matchAll(/['"]?([\w-]+)['"]?\s*:\s*['"](#[0-9a-f]{3,8}|rgb[a]?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\))['"]/gi)) out[m[1].toLowerCase()] ??= m[2]
  for (const m of text.matchAll(/['"]?([\w-]+)['"]?\s*:\s*\{\s*DEFAULT\s*:\s*['"](#[0-9a-f]{3,8})['"](?:\s*,\s*foreground\s*:\s*['"](#[0-9a-f]{3,8})['"])?/gi)) {
    out[m[1].toLowerCase()] = m[2]
    if (m[3]) out[`${m[1].toLowerCase()}-foreground`] = m[3]
  }
  return out
}

/** Project variables onto sketch colours, resolving var() references and bare HSL/OKLCH channels. */
function mapVars(vars: Record<string, string>): StyleVars {
  const out: StyleVars = {}
  const value = (raw: string, depth = 0): string | undefined => {
    let v = raw.replace(/!important/i, '').trim()
    const ref = /^var\(\s*--([\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(v)
    if (ref) {
      if (depth > 4) return undefined
      const next = vars[ref[1].toLowerCase()] ?? ref[2]
      return next ? value(next, depth + 1) : undefined
    }
    // shadcn's "222.2 84% 4.9%" and Tailwind v4's "0.21 0.006 285.88" channels.
    if (/^\d+(\.\d+)?(deg)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%$/.test(v)) v = `hsl(${v})`
    else if (/^0?\.\d+\s+0?\.\d+\s+\d+(\.\d+)?$/.test(v)) v = `oklch(${v})`
    v = v.replace(/\s*\/\s*[\d.]+%?\)$/, ')')
    return SAFE.test(v) && !/^\d+$/.test(v) ? v : undefined
  }
  for (const [k, names] of Object.entries(NAMES) as [keyof StyleVars, string[]][]) {
    for (const n of names) {
      const raw = vars[n]
      if (!raw) continue
      const v = value(raw)
      if (!v) continue
      if (k === 'radius' ? /^\d+(\.\d+)?(px|rem|em)$/.test(v) : !/^\d/.test(v)) {
        out[k] = v
        break
      }
    }
  }
  return out
}

/** One line for Claude: where the colours came from and the main ones. */
export function describeStyle(s: ProjectStyle): string | null {
  const l = s.light ?? s.dark
  if (!l || !s.source) return null
  const parts = (['bg', 'fg', 'accent', 'border'] as const).filter((k) => l[k]).map((k) => `${k} ${l[k]}`)
  return `the project's colours from ${s.source} (${parts.join(', ')}${s.dark ? '; it has a dark set too' : ''})`
}
