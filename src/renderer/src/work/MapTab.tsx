import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '../views/SessionView'
import { moduleOf, type ArchLink, type ArchModule, type Architecture } from '../../../shared/architecture'
import { useArchitecture, touchVerb, isEditTouch, createdFiles } from '../architecture'
import { tallyOf } from '../tally'
import { tabTitle } from '../tabs'
import { baseName } from '../lib'

const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p
import type { SessionState } from '../session'
import type { FileMark, PlanMap } from '../../../shared/events'
import type { MapGroups } from '../../../main/mapGroups'
import type { MapAnswer } from '../../../main/mapAsk'
import { searchHits, taskOf } from '../session'
import { Icon, IconButton, Segmented } from '../components/ui'
import { tr } from '../../../shared/i18n'
import './MapTab.css'

const LABEL_W = 112
const BOX_H = 124
/** A module shown only for context: name and folder, no activity. */
const CONTEXT_H = 64
const BOX_MIN_W = 176
const FOOT_H = 28
const GAP = 14
const BAND_PAD = 12
const MAX_COLS = 5
const MIN_W = 360

type Box = ArchModule & { x: number; y: number; w: number; h: number }
type Layout = { boxes: Record<string, Box>; bands: { layer: string; y: number; h: number; count: number; folded: boolean }[]; height: number }
/** A folded group: just its heading and how many modules it holds. */
const FOLDED_H = 44

/**
 * Layers as bands top to bottom, modules as boxes across each band. The map is laid out at the
 * width it's given (as many columns as fit), so it never needs a sideways scroll.
 */
function layout(arch: Architecture, W: number, compact?: Set<string> | null, folded?: Set<string>, order?: Map<string, number> | null): Layout {
  // Stable order (by path) so modules never jump around when the map refreshes; the modules the
  // conversation works in lead each band, the ones shown for context follow, smaller.
  const small = (id: string) => !!compact?.has(id)
  const byLayer = arch.layers
    .map((l) => ({ layer: l, mods: arch.modules.filter((m) => m.layer === l).sort((a, b) => (order ? (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9) : 0) || Number(small(a.id)) - Number(small(b.id)) || Number(!!a.external) - Number(!!b.external) || a.path.localeCompare(b.path) || a.name.localeCompare(b.name)) }))
    .filter((b) => b.mods.length)
  const fit = Math.max(1, Math.floor((W - LABEL_W - GAP) / (BOX_MIN_W + GAP)))
  const cols = Math.min(MAX_COLS, fit, Math.max(1, ...byLayer.map((b) => b.mods.length)))
  const bw = (W - LABEL_W - GAP * (cols + 1)) / cols
  const boxes: Record<string, Box> = {}
  const bands: Layout['bands'] = []
  let y = 8
  for (const b of byLayer) {
    const top = y
    if (folded?.has(b.layer)) {
      bands.push({ layer: b.layer, y: top, h: FOLDED_H, count: b.mods.length, folded: true })
      y = top + FOLDED_H + GAP
      continue
    }
    let rowY = y + BAND_PAD
    for (let r = 0; r * cols < b.mods.length; r++) {
      const row = b.mods.slice(r * cols, r * cols + cols)
      const rowH = Math.max(...row.map((m) => (small(m.id) ? CONTEXT_H : BOX_H)))
      row.forEach((m, c) => {
        boxes[m.id] = { ...m, x: LABEL_W + GAP + c * (bw + GAP), y: rowY, w: bw, h: small(m.id) ? CONTEXT_H : BOX_H }
      })
      rowY += rowH + GAP
    }
    const h = rowY - GAP + BAND_PAD - top
    bands.push({ layer: b.layer, y: top, h, count: b.mods.length, folded: false })
    y = top + h + GAP
  }
  return { boxes, bands, height: y }
}

const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
/** A connection from one box's edge to the other's: down or up between rows, sideways within one. */
function wire(a: Box, b: Box): string {
  const ca = center(a), cb = center(b)
  // Same column, with other boxes between: bow out past the right-hand side rather than through them.
  const gapY = Math.abs(ca.y - cb.y) - (a.h + b.h) / 2
  if (Math.abs(ca.x - cb.x) < 1 && gapY > GAP * 2) {
    const x = a.x + a.w, bow = Math.min(60, 18 + gapY / 8)
    return `M${x},${ca.y} C${x + bow},${ca.y} ${x + bow},${cb.y} ${x},${cb.y}`
  }
  if (Math.abs(ca.y - cb.y) > (a.h + b.h) / 2) {
    const down = cb.y > ca.y
    const A = { x: ca.x, y: down ? a.y + a.h : a.y }, B = { x: cb.x, y: down ? b.y : b.y + b.h }
    const dy = (B.y - A.y) / 2
    return `M${A.x},${A.y} C${A.x},${A.y + dy} ${B.x},${B.y - dy} ${B.x},${B.y}`
  }
  const right = cb.x > ca.x
  const A = { x: right ? a.x + a.w : a.x, y: ca.y }, B = { x: right ? b.x : b.x + b.w, y: cb.y }
  const dx = (B.x - A.x) / 2
  return `M${A.x},${A.y} C${A.x + dx},${A.y} ${B.x - dx},${B.y} ${B.x},${B.y}`
}
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return tr('mapTab.elapsed.seconds', { s })
  if (s < 3600) return tr('mapTab.elapsed.minutes', { m: Math.floor(s / 60), s: String(s % 60).padStart(2, '0') })
  return tr('mapTab.elapsed.hours', { h: Math.floor(s / 3600), m: String(Math.floor((s % 3600) / 60)).padStart(2, '0') })
}

const MAX_CONTEXT = 8
/** Claude's grouping of each session's map, kept while the tab is open (the map remounts on switching). */
const groupedFor = new Map<string, { sig: string; groups: MapGroups }>()
/** Whole project: a group with more modules than this starts folded (unless the conversation is in it). */
const AUTO_FOLD = 12
/** The last show_on_map request each session's map has acted on. */
const handledMapOpen = new Map<string, number>()
/** Each session's last "show me a feature" answer, kept while the tab is open. */
const askedFor = new Map<string, MapAnswer>()
/** What you've asked the map before, per project, newest first (offered as suggestions). */
const recentKey = (root: string) => `glassbox.mapAsks.${root.toLowerCase()}`
const recentAsks = (root: string): string[] => {
  try {
    return JSON.parse(localStorage.getItem(recentKey(root)) ?? '[]') as string[]
  } catch {
    return []
  }
}
/** Features you've asked the map about, kept per project with their answers (newest first), so you can go back to one without asking again. */
const SAVED_MAX = 10
const savedKey = (root: string) => `glassbox.mapFeatures.${root.toLowerCase()}`
const savedFeatures = (root: string): MapAnswer[] => {
  try {
    return JSON.parse(localStorage.getItem(savedKey(root)) ?? '[]') as MapAnswer[]
  } catch {
    return []
  }
}
const saveFeatures = (root: string, list: MapAnswer[]) => {
  try {
    localStorage.setItem(savedKey(root), JSON.stringify(list.slice(0, SAVED_MAX)))
  } catch {
    /* a nicety */
  }
}

const rememberAsk = (root: string, q: string) => {
  try {
    localStorage.setItem(recentKey(root), JSON.stringify([q, ...recentAsks(root).filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 8)))
  } catch {
    /* suggestions are a nicety */
  }
}

/**
 * The part of the project a conversation is about: the modules Claude has read or changed, or that
 * the plan names ("focus"), plus the modules most tightly connected to them ("context", at most
 * eight, busiest connections first). Everything else stays off the map unless you ask for it.
 */
function conversationScope(arch: Architecture, s: SessionState, plan: PlanShape | null): { focus: Set<string>; context: Set<string>; moreContext: number } {
  const focus = new Set<string>()
  const add = (p: string) => {
    const m = moduleOf(arch, p.includes(':') || p.startsWith('/') ? p : `${arch.root}/${p}`)
    if (m) focus.add(m.id)
  }
  for (const f of s.files) add(f.path)
  for (const st of taskOf(s)?.steps ?? []) for (const p of st.files ?? []) add(p)
  // Anything Claude has pointed at on the map (show_on_map) is part of the conversation too.
  if (s.open?.target.view === 'map') for (const p of s.open.target.paths) add(p)
  // And everything the plan touches, including modules it hasn't created yet.
  if (plan) {
    for (const id of plan.modules.keys()) focus.add(id)
    for (const e of plan.edges) focus.add(e.from), focus.add(e.to)
  }
  const weight = new Map<string, number>()
  for (const e of arch.edges) {
    const other = focus.has(e.from) && !focus.has(e.to) ? e.to : focus.has(e.to) && !focus.has(e.from) ? e.from : null
    if (other) weight.set(other, (weight.get(other) ?? 0) + e.weight)
  }
  const ranked = [...weight].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  return { focus, context: new Set(ranked.slice(0, MAX_CONTEXT)), moreContext: Math.max(0, ranked.length - MAX_CONTEXT) }
}

/**
 * Claude's plan (show_plan_on_map) resolved onto the map: the modules it changes, the ones it
 * will create (drawn as outlines, "ghosts", until they exist), and the connections it adds or removes.
 */
type PlanShape = {
  ghosts: ArchModule[]
  modules: Map<string, { change: 'change' | 'new'; why?: string }>
  edges: { from: string; to: string; change: 'new' | 'removed'; why?: string; http?: boolean }[]
}

const GHOST = 'plan:'
const isGhost = (id: string) => id.startsWith(GHOST)

function planShape(arch: Architecture, pm: PlanMap | undefined): PlanShape | null {
  if (!pm?.modules.length) return null
  const root = norm(arch.root)
  const rel = (p: string) => {
    const n = p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    return n.toLowerCase().startsWith(root + '/') ? n.slice(root.length + 1) : n
  }
  const ghosts: ArchModule[] = []
  const modules: PlanShape['modules'] = new Map()
  for (const m of pm.modules) {
    const path = rel(m.path)
    if (m.change === 'new') {
      const parent = moduleOf(arch, `${arch.root}/${path}/x`)
      // A "new" folder that is already a module is a change to it.
      if (parent && parent.path.toLowerCase() === path.toLowerCase()) {
        modules.set(parent.id, { change: 'change', why: m.why })
        continue
      }
      const id = GHOST + path.toLowerCase()
      if (!ghosts.some((g) => g.id === id)) {
        const leaf = path.split('/').filter(Boolean).pop() ?? path
        const name = leaf.replace(/\.[a-z0-9]+$/i, '').replace(/[-_.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
        // It joins the band its sibling folders are in (src/lib/discounts sits with src/lib/money).
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')).toLowerCase() : ''
        const votes = new Map<string, number>()
        for (const x of arch.modules) {
          const xp = x.path.toLowerCase()
          if (!x.external && (xp.includes('/') ? xp.slice(0, xp.lastIndexOf('/')) : '') === dir && xp !== dir) votes.set(x.layer, (votes.get(x.layer) ?? 0) + 1)
        }
        const sibling = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0]
        ghosts.push({ id, name: name.charAt(0).toUpperCase() + name.slice(1), path, layer: sibling ?? parent?.layer ?? arch.layers[0] ?? 'Other', files: 0, tests: 0 })
      }
      modules.set(id, { change: 'new', why: m.why })
    } else {
      const mod = moduleOf(arch, `${arch.root}/${path}`)
      if (mod) modules.set(mod.id, { change: 'change', why: m.why })
    }
  }
  const idOf = (p: string) => {
    const path = rel(p).toLowerCase()
    const g = ghosts.filter((x) => path === x.path.toLowerCase() || path.startsWith(x.path.toLowerCase() + '/')).sort((a, b) => b.path.length - a.path.length)[0]
    return g?.id ?? moduleOf(arch, `${arch.root}/${rel(p)}`)?.id
  }
  const edges: PlanShape['edges'] = []
  for (const c of pm.connections) {
    const from = idOf(c.from), to = idOf(c.to)
    if (from && to && from !== to && !edges.some((e) => e.from === from && e.to === to)) edges.push({ from, to, change: c.change, why: c.why, http: c.http })
  }
  return { ghosts, modules, edges }
}

/** A planned connection that's already real (a new one the code now makes, a removed one that's gone) isn't drawn as planned any more. */
const planEdgeDone = (arch: Architecture, e: PlanShape['edges'][number]) => {
  const exists = arch.edges.some((x) => x.from === e.from && x.to === e.to)
  return e.change === 'new' ? exists : !exists
}

type Bound = Extract<FileMark, 'avoid' | 'ask' | 'api'>
/** Labels and notes are i18n keys, looked up when shown. */
const BOUNDS: { value: Bound | null; label: string; note: string }[] = [
  { value: null, label: 'mapTab.bounds.free.label', note: 'mapTab.bounds.free.note' },
  { value: 'ask', label: 'mapTab.bounds.ask.label', note: 'mapTab.bounds.ask.note' },
  { value: 'api', label: 'mapTab.bounds.api.label', note: 'mapTab.bounds.api.note' },
  { value: 'avoid', label: 'mapTab.bounds.avoid.label', note: 'mapTab.bounds.avoid.note' }
]
const BOUND_TAG: Record<Bound, string> = { avoid: 'mapTab.boundTag.avoid', ask: 'mapTab.boundTag.ask', api: 'mapTab.boundTag.api' }

type Moment = { at: number; kind: 'you' | 'edit' | 'decision'; label: string }

/**
 * The key moments of a session, in order: your messages, Claude's decisions and questions, and
 * edits (a run of edits in one module counts once). Reads and searches aren't moments.
 */
function keyMoments(s: SessionState, arch: Architecture | null): Moment[] {
  const out: Moment[] = []
  for (const i of s.timeline) {
    if (i.kind === 'user') out.push({ at: i.at, kind: 'you', label: tr('mapTab.moments.you', { text: i.text.replace(/\s+/g, ' ').slice(0, 80) }) })
    else if (i.kind === 'comment') out.push({ at: i.at, kind: 'you', label: tr('mapTab.moments.youReplied', { text: i.text.replace(/\s+/g, ' ').slice(0, 70) }) })
  }
  for (const d of s.decisions) out.push({ at: d.at, kind: 'decision', label: tr(d.kind === 'question' ? 'mapTab.moments.asked' : d.kind === 'assumption' ? 'mapTab.moments.assumed' : 'mapTab.moments.decided', { title: d.title }) })
  let run: { mod: string; name: string; files: Set<string>; moment: Moment } | null = null
  for (const f of s.files) {
    if (!isEditTouch(f, s)) continue
    const m = arch ? moduleOf(arch, f.path) : null
    const mod = m?.id ?? f.path
    if (run && run.mod === mod) {
      run.files.add(f.path)
      run.moment.label = tr('mapTab.moments.editedFiles', { count: run.files.size, name: run.name })
      continue
    }
    const moment: Moment = { at: f.at, kind: 'edit', label: tr('mapTab.moments.edited', { name: baseName(f.path) }) }
    run = { mod, name: m?.name ?? baseName(f.path), files: new Set([f.path]), moment }
    out.push(moment)
  }
  return out.sort((a, b) => a.at - b.at)
}

type Crew = { key: string; who: string; say: string; mod: string; kind: 'main' | 'agent' | 'peer' }

/**
 * The session as it moves through the system: each module's edits and reads, where Claude and its
 * agents are, the plan drawn as a route, and modules you've kept Claude out of. The replay bar
 * underneath winds the whole map back to any earlier moment.
 */
export function MapTab() {
  const { tab, s, peers, markFile, openRipple, openDiff, openFile, composerRef, openPlan } = useSession()
  const writes = s.files.filter((f) => f.tool === 'Write').length
  const arch = useArchitecture(tab.cwd, writes)
  const scroller = useRef<HTMLDivElement>(null)
  const [W, setW] = useState(0)
  // What the map shows: by default only the part of the project this conversation is working in.
  // Or a feature you asked to see ("ask"), drawn as the steps the work flows through.
  const [mode, setMode] = useState<'conv' | 'whole' | 'ask'>(() => (askedFor.has(tab.id) ? 'ask' : 'conv'))
  const whole = mode === 'whole'
  const setWhole = (on: boolean) => setMode(on ? 'whole' : 'conv')
  const [feature, setFeature] = useState<MapAnswer | null>(() => askedFor.get(tab.id) ?? null)
  const [asking, setAsking] = useState<{ q: string; since: number } | null>(null)
  const [askError, setAskError] = useState<string | null>(null)
  const [askText, setAskText] = useState('')
  const [saved, setSaved] = useState<MapAnswer[]>([])
  useEffect(() => setSaved(arch ? savedFeatures(arch.root) : []), [arch?.root])
  // The feature's step list, folded by default: the map's numbered bands already show the steps.
  const [stepsOpen, setStepsOpen] = useState(false)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!asking) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [asking])
  // Whole project: groups you folded or opened (null until you do: big groups start folded), and a search.
  const [folds, setFolds] = useState<Set<string> | null>(null)
  const [query, setQuery] = useState('')
  // Claude's plan drawn over the map (until you hide it).
  const [showPlan, setShowPlan] = useState(true)
  const planAll = useMemo(() => (arch ? planShape(arch, s.planMap) : null), [arch, s.planMap])
  const plan = showPlan ? planAll : null
  const scope = useMemo(() => (arch ? conversationScope(arch, s, plan) : null), [arch, s.files, s.task, s.todos, s.open, plan])
  const planPending = s.permissions.some((p) => p.toolName === 'ExitPlanMode')
  // Modules Claude has edited this session: those parts of the plan are under way.
  const editedMods = useMemo(() => {
    const out = new Set<string>()
    if (arch) for (const f of s.files) if (isEditTouch(f, s)) { const m = moduleOf(arch, f.path); if (m) out.add(m.id) }
    return out
  }, [arch, s.files])
  // Claude's show_on_map: outline the modules it named and open the first. Each request acts once,
  // even though the map tab remounts when you switch away and back.
  const [pointed, setPointed] = useState<Set<string>>(new Set())
  useEffect(() => {
    const o = s.open
    if (!arch || !o || o.target.view !== 'map' || (handledMapOpen.get(tab.id) ?? 0) >= o.n) return
    handledMapOpen.set(tab.id, o.n)
    const ids = [...new Set(o.target.paths.map((p) => moduleOf(arch, p.includes(':') || p.startsWith('/') ? p : `${arch.root}/${p}`)?.id).filter((x): x is string => !!x))]
    setWhole(false)
    setPointed(new Set(ids))
    if (ids[0]) setSel(ids[0])
  }, [arch, s.open, tab.id])
  // This session's heat per module (what it read, edited and searched), for Claude to group.
  const heat = useMemo(() => {
    if (!arch || !scope) return []
    const per = new Map<string, { reads: number; edits: number; searches: number; files: Map<string, number> }>()
    const bump = (path: string, kind: 'reads' | 'edits' | 'searches') => {
      const m = moduleOf(arch, path.includes(':') || path.startsWith('/') ? path : `${arch.root}/${path}`)
      if (!m) return
      const h = per.get(m.id) ?? { reads: 0, edits: 0, searches: 0, files: new Map() }
      h[kind]++
      const name = basename(path.replace(/\\/g, '/'))
      h.files.set(name, (h.files.get(name) ?? 0) + 1)
      per.set(m.id, h)
    }
    for (const f of s.files) bump(f.path, isEditTouch(f, s) ? 'edits' : 'reads')
    for (const c of Object.values(s.toolCalls)) if (c.name === 'Grep' || c.name === 'Glob') for (const p of searchHits(c).slice(0, 20)) bump(p, 'searches')
    const out = [...per].map(([id, h]) => {
      const m = arch.modules.find((x) => x.id === id)!
      return { id, name: m.name, path: m.path, files: m.files, reads: h.reads, edits: h.edits, searches: h.searches, top: [...h.files].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n) }
    })
    for (const id of scope.context) {
      const m = arch.modules.find((x) => x.id === id)
      if (m && !per.has(id)) out.push({ id, name: m.name, path: m.path, files: m.files, reads: 0, edits: 0, searches: 0, top: [], context: true } as (typeof out)[number] & { context: boolean })
    }
    return out.filter((m) => !arch.modules.find((x) => x.id === m.id)?.external)
  }, [arch, scope, s.files, s.toolCalls])
  // Ask Claude to group it once a turn has finished (not on every step while it works).
  const heatSig = heat.map((m) => `${m.id}:${m.reads}:${m.edits}:${m.searches}`).sort().join('|')
  const [grouping, setGrouping] = useState<{ sig: string; groups: MapGroups } | null>(() => groupedFor.get(tab.id) ?? null)
  const [regroupN, setRegroupN] = useState(0)
  const [busyGrouping, setBusyGrouping] = useState(false)
  useEffect(() => {
    if (!arch || mode !== 'conv' || heat.length < 2 || s.status === 'running') return
    if (grouping?.sig === heatSig && !regroupN) return
    let live = true
    setBusyGrouping(true)
    const t = setTimeout(() => {
      void window.glassbox.architecture.group(arch.root, heat, regroupN > 0).then((g) => {
        if (!live) return
        setBusyGrouping(false)
        if (g.error || !g.groups.length) return
        const next = { sig: heatSig, groups: g }
        groupedFor.set(tab.id, next)
        setGrouping(next)
        setRegroupN(0)
      }, () => live && setBusyGrouping(false))
    }, 600)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [arch, mode, heatSig, s.status, regroupN])
  const groups = mode === 'conv' && grouping && grouping.groups.groups.length ? grouping.groups : null

  const shown = useMemo(() => {
    if (!arch || !scope) return null
    const modules = [...arch.modules, ...(plan?.ghosts ?? [])]
    if (whole) return { ...arch, modules }
    // A feature you asked about: its steps become the bands, in the order the work flows.
    if (mode === 'ask' && feature) {
      const layerOf = new Map<string, string>()
      feature.steps.forEach((st, i) => {
        const name = `${i + 1}. ${st.name}`
        for (const id of st.modules) if (!layerOf.has(id)) layerOf.set(id, name)
        for (const f of st.files) {
          const m = moduleOf(arch, `${arch.root}/${f.path}`)
          if (m && !layerOf.has(m.id)) layerOf.set(m.id, name)
        }
      })
      const mods = arch.modules.filter((m) => layerOf.has(m.id)).map((m) => ({ ...m, layer: layerOf.get(m.id)! }))
      const ids = new Set(mods.map((m) => m.id))
      return { ...arch, layers: feature.steps.map((st, i) => `${i + 1}. ${st.name}`), modules: mods, edges: arch.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) }
    }
    // Claude's grouping: its groups become the bands, and what it left out stays off the map.
    if (groups) {
      const layerOf = new Map<string, string>()
      for (const g of groups.groups) for (const id of g.modules) layerOf.set(id, g.name)
      const ghosts = (plan?.ghosts ?? []).map((m) => ({ ...m, layer: layerOf.get(m.id) ?? tr('mapTab.plannedGroup') }))
      const mods = [...arch.modules.filter((m) => layerOf.has(m.id)).map((m) => ({ ...m, layer: layerOf.get(m.id)! })), ...ghosts]
      const ids = new Set(mods.map((m) => m.id))
      const layers = [...groups.groups.map((g) => g.name), ...(ghosts.some((g) => g.layer === tr('mapTab.plannedGroup')) ? [tr('mapTab.plannedGroup')] : [])]
      return { ...arch, layers, modules: mods, edges: arch.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) }
    }
    const ids = new Set([...scope.focus, ...scope.context])
    return { ...arch, modules: modules.filter((m) => ids.has(m.id)), edges: arch.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) }
  }, [arch, scope, whole, mode, feature, plan, groups])
  // What each module does for the feature you asked about: its key files, and why they matter.
  const notes = useMemo(() => {
    if (mode !== 'ask' || !feature || !arch) return null
    const out = new Map<string, string[]>()
    for (const st of feature.steps)
      for (const f of st.files) {
        const m = moduleOf(arch, `${arch.root}/${f.path}`)
        if (m) out.set(m.id, [...(out.get(m.id) ?? []), f.why ? `${basename(f.path)}: ${f.why}` : basename(f.path)])
      }
    return out
  }, [mode, feature, arch])
  // A feature you asked about, in order: each module's place in the flow (1, 2, 3…), so the map
  // reads as a route rather than a sprawl. A module named in two steps keeps its first.
  const order = useMemo(() => {
    if (mode !== 'ask' || !feature || !arch) return null
    const out = new Map<string, number>()
    let n = 0
    for (const st of feature.steps) {
      const ids = [...st.modules, ...st.files.map((f) => moduleOf(arch, `${arch.root}/${f.path}`)?.id).filter((x): x is string => !!x)]
      for (const id of ids) if (!out.has(id)) out.set(id, ++n)
    }
    return out
  }, [mode, feature, arch])
  // Search (whole project): modules whose name or folder matches.
  const found = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!whole || !q || !shown) return null
    return new Set(shown.modules.filter((m) => `${m.name} ${m.path}`.toLowerCase().includes(q)).map((m) => m.id))
  }, [query, whole, shown])
  // Which groups are folded: what you chose, or to begin with every big group the conversation isn't
  // in. A group with a search match always opens.
  const folded = useMemo(() => {
    if (!whole || !shown || !scope) return new Set<string>()
    const busy = new Set([...scope.focus, ...(plan?.modules.keys() ?? [])])
    const out = new Set<string>()
    for (const l of shown.layers) {
      const mods = shown.modules.filter((m) => m.layer === l)
      const auto = mods.length > AUTO_FOLD && !mods.some((m) => busy.has(m.id))
      if (folds ? folds.has(l) : auto) out.add(l)
    }
    if (found) for (const m of shown.modules) if (found.has(m.id)) out.delete(m.layer)
    return out
  }, [whole, shown, scope, plan, folds, found])
  const toggleFold = (layer: string) => setFolds(() => {
    const next = new Set(folded)
    if (next.has(layer)) next.delete(layer)
    else next.add(layer)
    return next
  })
  // Whole project: modules the conversation hasn't touched are compact (name, folder, size), so the
  // shape of the project fits on screen; the ones it works in keep room for their activity.
  const compact = useMemo(() => {
    if (mode === 'ask') return null
    if (!whole) return scope?.context ?? null
    if (!shown || !scope) return null
    return new Set(shown.modules.filter((m) => !scope.focus.has(m.id) && !plan?.modules.has(m.id)).map((m) => m.id))
  }, [whole, mode, shown, scope, plan])
  const lay = useMemo(() => (shown && shown.modules.length && W ? layout(shown, W, compact, folded, order) : null), [shown, W, compact, folded, order])
  // Searching: bring the first match into view (it may be far down a long project).
  useEffect(() => {
    const first = found && lay ? [...found].map((id) => lay.boxes[id]).filter(Boolean).sort((a, b) => a.y - b.y)[0] : undefined
    if (first) scroller.current?.scrollTo({ top: Math.max(0, first.y - 24), behavior: 'smooth' })
  }, [found, lay])
  const [sel, setSel] = useState<string | null>(null)
  // Counts up when you right-click a module, so its inspector opens on the limits you can set.
  const [boundsFocus, setBoundsFocus] = useState(0)
  // The connected module you're pointing at in the panel, drawn strongest on the map.
  const [hoverOther, setHoverOther] = useState<string | null>(null)
  useEffect(() => setHoverOther(null), [sel])
  // null is now; otherwise the moment the replay bar is parked on.
  const [at, setAt] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = () => {
      const cs = getComputedStyle(el)
      setW(Math.max(MIN_W, Math.floor(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [arch])

  useEffect(() => {
    if (!sel) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSel(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sel])

  const moments = useMemo(() => keyMoments(s, arch), [s.timeline, s.decisions, s.files, arch])

  // Play steps through the moments (about ten seconds for the whole session, however long it
  // ran) and stops on the last one; "Back to now" or the end of the track returns to live.
  useEffect(() => {
    if (!playing) return
    const every = Math.min(900, Math.max(120, 10000 / Math.max(1, moments.length)))
    const t = setInterval(() => {
      setAt((cur) => {
        const next = moments.find((m) => m.at > (cur ?? Infinity))
        if (!next) setPlaying(false)
        return next ? next.at : cur
      })
    }, every)
    return () => clearInterval(t)
  }, [playing, moments])

  const view = useMemo(() => {
    if (!arch || !lay) return null
    const past = at !== null
    const files = past ? s.files.filter((f) => f.at <= at) : s.files
    const created = createdFiles(s)
    const mods: Record<string, { edits: number; reads: number; files: { name: string; isNew: boolean; path: string }[]; lastRead: number }> = {}
    for (const id in lay.boxes) mods[id] = { edits: 0, reads: 0, files: [], lastRead: 0 }
    const latest = new Map<string | null, (typeof s.files)[number]>()
    for (const f of files) {
      const m = moduleOf(arch, f.path)
      if (!m || !mods[m.id]) continue
      latest.set(f.agentId, f)
      if (isEditTouch(f, s)) {
        mods[m.id].edits++
        if (!mods[m.id].files.some((x) => x.path === f.path)) mods[m.id].files.push({ name: baseName(f.path), isNew: created.has(f.path), path: f.path })
      } else {
        mods[m.id].reads++
        mods[m.id].lastRead = Math.max(mods[m.id].lastRead, f.at)
      }
    }
    // The crew: Claude, plus any subagent still running, each at the module it last touched.
    const tally = past ? 'idle' : tallyOf(s)
    const crew: Crew[] = []
    for (const [agentId, f] of latest) {
      if (!past && agentId && s.agents[agentId]?.status !== 'running') continue
      const m = moduleOf(arch, f.path)
      if (!m) continue
      const main = agentId === null
      const type = s.agents[agentId!]?.type
      const who = main ? tr('mapTab.crew.claude') : type ? tr('mapTab.crew.typedAgent', { type: type[0].toUpperCase() + type.slice(1) }) : tr('mapTab.crew.agent')
      const doing = tr('mapTab.crew.doing', { verb: touchVerb(f.tool).toLowerCase(), file: baseName(f.path) })
      const say = past || !main ? doing : tally === 'wait' ? tr('mapTab.crew.waiting') : s.status !== 'running' ? (tally === 'ok' ? tr('mapTab.crew.finishedHere') : tr('mapTab.crew.lastHere')) : doing
      crew.push({ key: agentId ?? 'main', who, say, mod: m.id, kind: main ? 'main' : 'agent' })
    }
    // Other sessions in the same project, faintly, so overlapping work is visible.
    if (!past)
      for (const p of peers) {
        if (norm(p.tab.cwd) !== norm(tab.cwd) && norm(p.s.git?.root ?? '') !== norm(arch.root)) continue
        const f = [...p.s.files].reverse().find((x) => x.agentId === null)
        if (!f || p.s.status === 'stopped') continue
        const m = moduleOf(arch, f.path)
        if (!m) continue
        crew.push({ key: 'peer:' + p.tab.id, who: tabTitle(p.tab, p.s), say: '', mod: m.id, kind: 'peer' })
      }
    const mainNow = crew.find((c) => c.kind === 'main')
    const last = latest.get(null)
    const liveMod = (past || s.status === 'running') && mainNow && last && isEditTouch(last, s) ? mainNow.mod : null
    const waitMod = tally === 'wait' && mainNow ? mainNow.mod : null
    // The limits you've set on modules (from the inspector): hands off, ask first, public API only.
    const bounds = new Map<string, Bound>()
    for (const b of Object.values(lay.boxes)) {
      const f = s.requirements.files.find((x) => (x.mark === 'avoid' || x.mark === 'ask' || x.mark === 'api') && norm(x.path) === norm(`${arch.root}/${b.path}`))
      if (f && !isGhost(b.id)) bounds.set(b.id, f.mark as Bound)
    }
    const steps = (mode === 'ask' ? [] : taskOf(s)?.steps ?? []).map((st, i) => {
      const m = st.files?.map((p) => moduleOf(arch, p.includes(':') || p.startsWith('/') ? p : `${arch.root}/${p}`)).find(Boolean)
      return { n: i + 1, status: st.status, label: st.label, mod: m?.id }
    })
    return { mods, crew, liveMod, waitMod, bounds, steps, tally, past, plan: past ? null : plan }
  }, [arch, lay, s, peers, tab.cwd, at, plan, mode])

  const body = (() => {
    if (!arch) return <div className="map-empty">{tr('mapTab.mapping')}</div>
    if (arch.error && !arch.modules.length) return <div className="map-empty">{tr('mapTab.mapError', { error: arch.error })}</div>
    if (!arch.modules.length) return <div className="map-empty">{tr('mapTab.noSourceFolders')}</div>
    if (mode === 'ask' && feature && !feature.steps.length) return null
    if (mode === 'conv' && scope && !scope.focus.size)
      return (
        <div className="map-empty map-empty-scope">
          <strong>{tr('mapTab.convEmpty.title')}</strong>
          <span>{tr('mapTab.convEmpty.body', { project: basename(arch.root) })}</span>
          <button className="btn" onClick={() => setWhole(true)}>
            {tr('mapTab.convEmpty.showWhole')}
          </button>
        </div>
      )
    if (!lay || !view || !shown) return null
    return (
      <MapSvg
        arch={shown}
        lay={lay}
        view={view}
        sel={sel}
        setSel={setSel}
        W={W}
        hoverOther={hoverOther}
        context={mode === 'conv' ? scope?.context ?? null : null}
        notes={notes}
        order={order}
        pointed={pointed}
        whole={whole}
        found={found}
        onToggleFold={toggleFold}
        onBoundsMenu={(id) => (setSel(id), setBoundsFocus((n) => n + 1))}
      />
    )
  })()
  const ask = async (question: string, force = false) => {
    const q = question.trim()
    if (!arch || !q || asking) return
    setAsking({ q, since: Date.now() })
    setAskError(null)
    const mods = arch.modules.filter((m) => !m.external).map((m) => ({ id: m.id, name: m.name, path: m.path }))
    const a = await window.glassbox.architecture.ask(arch.root, q, mods, force).catch((e: unknown) => ({ error: String(e) }) as MapAnswer)
    setAsking(null)
    if (a.error) return setAskError(a.error)
    askedFor.set(tab.id, a)
    setFeature(a)
    setMode('ask')
    setSel(null)
    setAskText('')
    rememberAsk(arch.root, q)
    // Kept for next time (an answer to the same question replaces the old one), if it found anything.
    const list = [...(a.steps.length ? [a] : []), ...savedFeatures(arch.root).filter((x) => x.question.toLowerCase() !== q.toLowerCase())]
    saveFeatures(arch.root, list)
    setSaved(list)
  }
  const openSaved = (f: MapAnswer) => {
    askedFor.set(tab.id, f)
    setFeature(f)
    setMode('ask')
    setSel(null)
  }
  const forget = (f: MapAnswer) => {
    if (!arch) return
    const list = savedFeatures(arch.root).filter((x) => x.question !== f.question)
    saveFeatures(arch.root, list)
    setSaved(list)
  }
  const recent = arch ? recentAsks(arch.root) : []
  const askBox = arch && arch.modules.length > 0 && (
    <>
    <form
      className={asking ? 'map-ask busy' : 'map-ask'}
      onSubmit={(e) => {
        e.preventDefault()
        void ask(askText)
      }}
    >
      <Icon name={asking ? 'loading' : 'sparkle'} className={asking ? 'codicon-modifier-spin accent' : 'accent'} />
      {asking ? (
        <span className="map-ask-busy">
          {tr('mapTab.ask.finding', { q: asking.q })} <span className="muted">{elapsed(Date.now() - asking.since)}</span>
        </span>
      ) : (
        <input
          className="grow"
          list={`map-asks-${tab.id}`}
          placeholder={tr('mapTab.ask.placeholder')}
          aria-label={tr('mapTab.ask.label')}
          value={askText}
          onChange={(e) => setAskText(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setAskText('')}
        />
      )}
      <datalist id={`map-asks-${tab.id}`}>
        {recent.map((q) => (
          <option key={q} value={q} />
        ))}
      </datalist>
      {!asking && (
        <button className="btn" type="submit" disabled={!askText.trim()}>
          {tr('mapTab.showMe')}
        </button>
      )}
    </form>
    {saved.length > 0 && !asking && (
      <div className="map-saved" aria-label={tr('mapTab.saved.label')}>
        <span className="muted small">{tr('mapTab.saved.label')}</span>
        {saved.map((f) => (
          <span key={f.question} className={feature?.question === f.question && mode === 'ask' ? 'map-saved-chip on' : 'map-saved-chip'}>
            <button className="map-saved-open" title={f.question} onClick={() => openSaved(f)}>
              {f.title}
            </button>
            <button className="map-saved-x" title={tr('mapTab.saved.forget')} aria-label={tr('mapTab.saved.forget')} onClick={() => forget(f)}>
              <Icon name="close" />
            </button>
          </span>
        ))}
      </div>
    )}
    </>
  )
  const scopeBar = arch && arch.modules.length > 0 && scope && (
    <div className="map-bar">
      <Segmented<'conv' | 'whole' | 'ask'>
        value={mode}
        onChange={(v) => (setMode(v), setSel(null), setQuery(''))}
        options={[
          { value: 'conv', label: tr('mapTab.bar.thisConversation') },
          { value: 'whole', label: tr('mapTab.bar.wholeProject') },
          ...(feature ? [{ value: 'ask' as const, label: feature.title }] : [])
        ]}
      />
      {whole && (
        <input
          className="map-search"
          type="search"
          placeholder={tr('mapTab.bar.findPlaceholder')}
          aria-label={tr('mapTab.bar.findLabel')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && found?.size) setSel([...found][0])
            if (e.key === 'Escape') setQuery('')
          }}
        />
      )}
      {mode === 'conv' && (groups || busyGrouping) && (
        <span className="map-grouped" title={groups ? tr('mapTab.bar.groupedTitle') : undefined}>
          <Icon name={busyGrouping ? 'loading' : 'sparkle'} className={busyGrouping ? 'codicon-modifier-spin' : undefined} />
          {busyGrouping ? tr('mapTab.bar.grouping') : tr('mapTab.bar.grouped')}
          {groups && !busyGrouping && (
            <button className="link small" onClick={() => setRegroupN((n) => n + 1)}>
              {tr('mapTab.bar.regroup')}
            </button>
          )}
        </span>
      )}
      <span className="map-bar-note">
        {whole && found
          ? tr(found.size ? 'mapTab.bar.matchesEnter' : 'mapTab.bar.matches', { count: found.size })
          : whole
          ? tr('mapTab.bar.allModules', { count: arch.modules.length })
          : mode === 'ask'
          ? feature && shown && feature.steps.length
            ? tr('mapTab.bar.askSummary', { modules: tr('mapTab.bar.modulesCount', { count: shown.modules.length }), steps: tr('mapTab.bar.stepsCount', { count: feature.steps.length }) })
            : ''
          : scope.focus.size
          ? tr(scope.moreContext ? 'mapTab.bar.convSummaryHidden' : 'mapTab.bar.convSummary', { count: scope.focus.size, context: scope.context.size, more: scope.moreContext })
          : ''}
      </span>
    </div>
  )
  // The feature you asked about, in words: what it is, and its steps with the files that matter.
  const featureBar = arch && mode === 'ask' && feature && (
    <div className="map-feature">
      <div className="map-feature-head">
        <strong>{feature.title}</strong>
        <span className="spacer" />
        <button className="btn quiet" onClick={() => void ask(feature.question, true)} disabled={!!asking} title={tr('mapTab.feature.askAgainTitle', { q: feature.question })}>
          <Icon name="refresh" /> {tr('mapTab.feature.askAgain')}
        </button>
        <IconButton icon="close" title={tr('mapTab.feature.close')} onClick={() => (askedFor.delete(tab.id), setFeature(null), setMode('conv'), setSel(null))} />
      </div>
      {feature.summary && <p className="map-feature-summary" title={feature.summary}>{feature.summary}</p>}
      {feature.steps.length === 0 ? (
        <p className="muted small">{feature.summary ? tr('mapTab.feature.tryAgain') : tr('mapTab.feature.noMatch')}</p>
      ) : !stepsOpen ? (
        <button className="link small map-feature-toggle" onClick={() => setStepsOpen(true)}>
          {tr('mapTab.feature.showSteps', { count: feature.steps.length })}
        </button>
      ) : (
        <ol className="map-feature-steps">
          {feature.steps.map((st, i) => (
            <li key={i}>
              <span className="map-feature-n">{i + 1}</span>
              <span className="map-feature-step">{st.name}</span>
              <span className="map-feature-files">
                {st.files.map((f) => (
                  <button key={f.path} className="link small" title={`${f.path}${f.why ? `\n${f.why}` : ''}`} onClick={() => openFile(`${arch.root}/${f.path}`)}>
                    {basename(f.path)}
                  </button>
                ))}
              </span>
            </li>
          ))}
          <li>
            <button className="link small" onClick={() => setStepsOpen(false)}>
              {tr('mapTab.feature.hideSteps')}
            </button>
          </li>
        </ol>
      )}
    </div>
  )
  // The plan's shape in words, with the way back to approving it when it's waiting on you.
  const planBar = arch && planAll && (
    <div className={planPending ? 'map-plan-bar waiting' : 'map-plan-bar'}>
      <span className="map-plan-key" aria-hidden />
      <span className="map-plan-text">
        <strong>{planPending ? tr('mapTab.plan.waiting') : tr('mapTab.plan.title')}</strong>
        {planSummary(arch, planAll, editedMods)}
      </span>
      {planPending && (
        <button className="btn primary" onClick={() => openPlan()}>
          {tr('mapTab.plan.review')}
        </button>
      )}
      <button className="btn quiet" onClick={() => setShowPlan((v) => !v)} aria-pressed={showPlan}>
        {showPlan ? tr('mapTab.plan.hide') : tr('mapTab.plan.show')}
      </button>
    </div>
  )

  // Files Claude changed this session, relative to the map's root, to flag the connections they touch.
  const edited = useMemo(() => {
    const out = new Set<string>()
    if (!arch) return out
    const root = arch.root.replace(/\\/g, '/').toLowerCase() + '/'
    for (const f of s.files) {
      if (!isEditTouch(f, s)) continue
      const p = f.path.replace(/\\/g, '/').toLowerCase()
      out.add(p.startsWith(root) ? p.slice(root.length) : p)
    }
    return out
  }, [arch, s])
  const selBox = sel && lay ? lay.boxes[sel] : null
  const selMod = sel && view ? view.mods[sel] : null

  return (
    <div className={selBox ? 'map-tab inspecting' : 'map-tab'}>
      {askBox}
      {askError && (
        <div className="note note-error map-ask-error">
          {tr('mapTab.ask.error', { error: askError })} <button className="link" onClick={() => setAskError(null)}>{tr('mapTab.ask.dismiss')}</button>
        </div>
      )}
      {scopeBar}
      {featureBar}
      {mode !== 'ask' && planBar}
      <div className="map-view" ref={scroller} onClick={(e) => e.target === e.currentTarget && setSel(null)}>
        {body}
      </div>

      {arch && selBox && selMod && view && (
        <Inspector
          key={selBox.id}
          arch={arch}
          cwd={tab.cwd}
          edited={edited}
          onHover={setHoverOther}
          box={selBox}
          mod={selMod}
          bound={view.bounds.get(selBox.id) ?? null}
          boundsFocus={boundsFocus}
          plan={view.plan}
          decisions={decisionsFor(arch, selBox, s)}
          onClose={() => setSel(null)}
          onBound={(mark) => markFile(`${arch.root}/${selBox.path}`, mark)}
          onRipple={() => openRipple(selBox.id)}
          onOpen={(path, changed) => (changed ? openDiff({ path, base: null, diffMode: 'merge-base', source: 'session' }) : openFile(path))}
          onAsk={(text) => composerRef.current?.insert(text)}
        />
      )}

      {moments.length > 0 && (
        <ReplayBar
          moments={moments}
          at={at}
          playing={playing}
          onSeek={(t) => (setPlaying(false), setAt(t))}
          onPlay={() => {
            if (playing) return setPlaying(false)
            // From now (or the end), play starts again at the beginning.
            if (at === null || at >= moments[moments.length - 1].at) setAt(moments[0].at)
            setPlaying(true)
          }}
          onNow={() => (setPlaying(false), setAt(null))}
        />
      )}
    </div>
  )
}

type View = {
  mods: Record<string, { edits: number; reads: number; files: { name: string; isNew: boolean; path: string }[]; lastRead: number }>
  crew: Crew[]
  liveMod: string | null
  waitMod: string | null
  bounds: Map<string, Bound>
  steps: { n: number; status: string; label: string; mod?: string }[]
  tally: string
  past: boolean
  /** Claude's plan over the map (not while replaying the past). */
  plan: PlanShape | null
}

/** "changes 3 modules, adds 1, and 2 new connections": what's still to do, or that it's all done. */
function planSummary(arch: Architecture, plan: PlanShape, edited: Set<string>): string {
  const todo = [...plan.modules].filter(([id]) => !edited.has(id)).map(([, m]) => m)
  const changes = todo.filter((m) => m.change === 'change').length
  const adds = todo.filter((m) => m.change === 'new').length
  const open = plan.edges.filter((e) => !planEdgeDone(arch, e))
  const added = open.filter((e) => e.change === 'new').length
  const removed = open.filter((e) => e.change === 'removed').length
  const parts = [
    changes && tr('mapTab.planSummary.changesModules', { count: changes }),
    adds && tr('mapTab.planSummary.addsModules', { count: adds }),
    added && tr('mapTab.planSummary.newConnections', { count: added }),
    removed && tr('mapTab.planSummary.removesConnections', { count: removed })
  ].filter(Boolean) as string[]
  if (!parts.length) return tr('mapTab.planSummary.done')
  return tr(todo.length < plan.modules.size ? 'mapTab.planSummary.stillToDo' : 'mapTab.planSummary.toDo', { parts: parts.join(', ') })
}

type ModuleDecision = { title: string; detail?: string; kind: string; at: number; earlier: boolean }

/** This session's decisions about files in this module (earlier sessions' aren't carried over). */
function decisionsFor(arch: Architecture, box: Box, s: SessionState): ModuleDecision[] {
  const inside = (files?: string[]) => !!files?.some((p) => moduleOf(arch, p.includes(':') || p.startsWith('/') ? p : `${arch.root}/${p}`)?.id === box.id)
  const now = s.decisions.filter((d) => d.kind !== 'question' && inside(d.files)).map((d) => ({ title: d.title, detail: d.detail, kind: d.kind, at: d.at, earlier: false }))
  return now.reverse().slice(0, 6)
}

function MapSvg({
  arch,
  lay,
  view,
  sel,
  setSel,
  W,
  hoverOther,
  context,
  pointed,
  onBoundsMenu,
  whole,
  found,
  onToggleFold,
  notes,
  order
}: {
  arch: Architecture
  lay: Layout
  view: View
  sel: string | null
  setSel: (id: string | null) => void
  W: number
  hoverOther: string | null
  context: Set<string> | null
  pointed: Set<string>
  /** Right-click on a module: open it on the limits you can set for Claude there. */
  onBoundsMenu: (id: string) => void
  whole: boolean
  /** Search matches (whole project), drawn outlined while the rest steps back. */
  found: Set<string> | null
  onToggleFold: (layer: string) => void
  /** A feature you asked about: what each module's key files do for it, shown in the box. */
  notes?: Map<string, string[]> | null
  /** …and each module's place in its flow (1, 2, 3…), drawn as numbered stops on a route. */
  order?: Map<string, number> | null
}) {
  const box = (id: string) => lay.boxes[id]
  // Whole project: connections show for the module you point at or pick, not all at once (a big
  // project's full set is a tangle). This conversation's few modules show theirs all the time.
  const [hover, setHover] = useState<string | null>(null)
  const focus = sel ?? hover
  // A feature's map shows its numbered route; the code's own connections appear for the module you point at.
  const showEdge = (from: string, to: string) => (!whole && !order) || (!!focus && (from === focus || to === focus))
  const linksBy = useMemo(() => {
    const m = new Map<string, ArchLink[]>()
    for (const l of arch.links ?? []) {
      const k = `${l.fromModule}>${l.toModule}`
      m.set(k, [...(m.get(k) ?? []), l])
    }
    return m
  }, [arch])
  const routePts = view.steps.filter((x) => x.mod && box(x.mod)).map((x) => center(box(x.mod!)))
  const crewAt: Record<string, Crew[]> = {}
  for (const c of view.crew) (crewAt[c.mod] ??= []).push(c)
  const stepsAt: Record<string, View['steps']> = {}
  for (const st of view.steps) if (st.mod) (stepsAt[st.mod] ??= []).push(st)

  return (
    <svg className="map-svg" width={W} height={lay.height} viewBox={`0 0 ${W} ${lay.height}`} role="img" aria-label={tr('mapTab.svgLabel')}>
      <defs>
        <pattern id="map-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="8" className="map-hatch-line" />
        </pattern>
      </defs>
      <defs>
        <marker id="map-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L8,4 L0,8 z" className="map-arrow" />
        </marker>
        <marker id="map-flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0,0 L8,4 L0,8 z" className="map-flow-arrowhead" />
        </marker>
      </defs>
      {lay.bands.map((b) => (
        <g
          key={b.layer}
          className={whole ? 'map-band-g foldable' : 'map-band-g'}
          onClick={whole ? (e) => (e.stopPropagation(), onToggleFold(b.layer)) : undefined}
          role={whole ? 'button' : undefined}
          aria-expanded={whole ? !b.folded : undefined}
          aria-label={whole ? tr('mapTab.band.label', { layer: b.layer, count: b.count, state: tr(b.folded ? 'mapTab.band.folded' : 'mapTab.band.open') }) : undefined}
        >
          <rect className={b.folded ? 'map-band folded' : 'map-band'} x={4} y={b.y} width={W - 8} height={b.h} rx={10} />
          {/* The fold chevron: pointing right when folded, down when open. */}
          {whole && <path className="map-band-chevron" d={b.folded ? `M18,${b.y + b.h / 2 - 4} l4,4 l-4,4` : `M16,${b.y + 16} l4,4 l4,-4`} />}
          {b.folded ? (
            <text className="map-band-label" x={30} y={b.y + b.h / 2 + 4}>
              {b.layer}
              <tspan className="map-band-count" dx={10}>{tr('mapTab.band.foldedCount', { count: b.count })}</tspan>
            </text>
          ) : (
            /* Long category names wrap onto a second line rather than being cut off. */
            <text className="map-band-label" x={whole ? 30 : 18} y={b.y + 22}>
              {bandLines(b.layer).map((line, i) => (
                <tspan key={i} x={whole ? 30 : 18} dy={i ? 14 : 0}>{line}</tspan>
              ))}
              {whole && <tspan className="map-band-count" x={30} dy={16}>{tr('mapTab.band.count', { count: b.count })}</tspan>}
            </text>
          )}
        </g>
      ))}
      {arch.edges.map((e) => {
        const a = box(e.from), b = box(e.to)
        if (!a || !b || !showEdge(e.from, e.to)) return null
        const d = wire(a, b)
        const hot = view.liveMod && (e.from === view.liveMod || e.to === view.liveMod)
        // With a module open, its connections stand out and the rest step back; the one you're
        // pointing at in the panel is drawn strongest.
        const mine = focus && (e.from === focus || e.to === focus)
        const pointed = sel && hoverOther && ((e.from === sel && e.to === hoverOther) || (e.to === sel && e.from === hoverOther))
        const cls = pointed ? 'map-edge pointed' : mine ? 'map-edge focus' : focus ? 'map-edge dim' : hot ? 'map-edge hot' : 'map-edge'
        const names = [...new Set((linksBy.get(`${e.from}>${e.to}`) ?? []).flatMap((l) => l.names))]
        // A loose HTTP match (only the shape of the URL lines up) is drawn fainter and said as "probably".
        const link = tr(e.http ? (e.weak ? 'mapTab.edgeTip.probablyCalls' : 'mapTab.edgeTip.calls') : 'mapTab.edgeTip.uses', { from: a.name, to: b.name })
        const listed = names.length > 6 ? tr('mapTab.edgeTip.andMore', { names: names.slice(0, 6).join(', '), count: names.length - 6 }) : names.join(', ')
        const tip = `${names.length ? tr('mapTab.edgeTip.withNames', { link, names: listed }) : link}${e.weak ? `\n${tr('mapTab.edgeTip.weak')}` : ''}`
        return (
          <g key={`${e.from}>${e.to}`}>
            <path className={e.http ? `${cls} http${e.weak ? ' weak' : ''}` : cls} d={d} markerEnd="url(#map-arrow)" />
            <path className="map-edge-hit" d={d} data-tip={tip} />
          </g>
        )
      })}
      {/* The plan's connections: ones it adds in the accent, ones it removes struck through, until the code catches up. */}
      {view.plan?.edges.map((e) => {
        const a = box(e.from), b = box(e.to)
        if (!a || !b || planEdgeDone(arch, e)) return null
        const d = wire(a, b)
        const tip = `${tr(e.change === 'new' ? (e.http ? 'mapTab.planEdge.startCalling' : 'mapTab.planEdge.startUsing') : e.http ? 'mapTab.planEdge.stopCalling' : 'mapTab.planEdge.stopUsing', { from: a.name, to: b.name })}${e.why ? `\n${e.why}` : ''}`
        return (
          <g key={`plan:${e.from}>${e.to}`}>
            <path className={`map-edge-plan ${e.change}`} d={d} markerEnd="url(#map-arrow)" />
            <path className="map-edge-hit" d={d} data-tip={tip} />
          </g>
        )
      })}
      {routePts.length > 1 && <polyline className="map-route" points={routePts.map((p) => `${p.x},${p.y}`).join(' ')} />}
      {order &&
        (() => {
          const stops = [...order].sort((a, b) => a[1] - b[1]).map(([id]) => box(id)).filter((b): b is Box => !!b)
          return stops.slice(1).map((b, i) => (
            <path key={`flow:${b.id}`} className="map-flow-route" d={wire(stops[i], b)} markerEnd="url(#map-flow-arrow)" />
          ))
        })()}
      {Object.values(lay.boxes).map((b) => {
        const m = view.mods[b.id]
        const edge = view.waitMod === b.id ? 'wait' : view.liveMod === b.id ? 'live' : null
        const crew = crewAt[b.id] ?? []
        const steps = stepsAt[b.id] ?? []
        const bound = view.bounds.get(b.id)
        const ghost = isGhost(b.id)
        const planned = view.plan?.modules.get(b.id)
        // A planned module keeps its plan outline until Claude starts on it.
        const planOpen = planned && m.edits === 0
        const tag = bound ? tr(BOUND_TAG[bound]) : planOpen ? (planned.change === 'new' ? tr('mapTab.tag.new') : tr('mapTab.tag.planned')) : m.reads + m.edits > 0 ? (m.edits ? tr('mapTab.tag.edits', { count: m.edits }) : tr('mapTab.tag.reads', { count: m.reads })) : ''
        return (
          <g
            key={b.id}
            className={`map-mod${sel === b.id ? ' sel' : ''}${b.external ? ' ext' : ''}${context?.has(b.id) ? ' ctx' : ''}${pointed.has(b.id) || found?.has(b.id) ? ' pt' : ''}${found && !found.has(b.id) ? ' faded' : ''}${ghost ? ' ghost' : ''}${planOpen ? ' planned' : ''}${bound ? ` bound-${bound}` : ''}`}
            tabIndex={0}
            role="button"
            aria-label={tr('mapTab.box.label', {
              name: b.name,
              path: b.path || tr('mapTab.box.projectRoot'),
              state: ghost ? tr('mapTab.box.newInPlan') : tr('mapTab.box.edits', { n: m.edits }),
              inPlan: planOpen && !ghost ? tr('mapTab.box.inPlan') : '',
              bound: bound ? tr('mapTab.box.bound', { tag: tr(BOUND_TAG[bound]) }) : ''
            })}
            onClick={() => setSel(sel === b.id ? null : b.id)}
            onMouseEnter={() => setHover(b.id)}
            onMouseLeave={() => setHover((h) => (h === b.id ? null : h))}
            onFocus={() => setHover(b.id)}
            onBlur={() => setHover((h) => (h === b.id ? null : h))}
            onContextMenu={(e) => {
              if (ghost || b.external) return
              e.preventDefault()
              e.stopPropagation()
              onBoundsMenu(b.id)
            }}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setSel(sel === b.id ? null : b.id))}
          >
            <rect className="map-mod-bg" x={b.x} y={b.y} width={b.w} height={b.h} rx={8} />
            <rect className="map-mod-heat" x={b.x} y={b.y} width={b.w} height={b.h} rx={8} opacity={Math.min(0.14, m.edits * 0.035)} />
            {!view.past && m.lastRead > 0 && Date.now() - m.lastRead < 4000 && <rect key={m.lastRead} className="map-mod-read" x={b.x - 3} y={b.y - 3} width={b.w + 6} height={b.h + 6} rx={10} />}
            {edge && <rect className={`map-mod-edge ${edge}`} x={b.x} y={b.y} width={b.w} height={b.h} rx={8} />}
            {planOpen && <rect className="map-mod-plan" x={b.x} y={b.y} width={b.w} height={b.h} rx={8} />}
            {bound === 'avoid' && <rect className="map-mod-fence" x={b.x} y={b.y} width={b.w} height={b.h} rx={8} />}
            {bound === 'api' && <rect className="map-mod-api" x={b.x + 3} y={b.y + 3} width={b.w - 6} height={b.h - 6} rx={6} />}
            {order?.has(b.id) && (
              <g className="map-stop" aria-hidden>
                <circle cx={b.x + 2} cy={b.y + 2} r={11} />
                <text x={b.x + 2} y={b.y + 6} textAnchor="middle">{order.get(b.id)}</text>
              </g>
            )}
            <text className="map-mod-name" x={b.x + 12} y={b.y + 22}>{clip(b.name, b.w - 56, 7.2)}</text>
            <text className="map-mod-path" x={b.x + 12} y={b.y + 37}>{clip(b.path || tr('mapTab.root'), b.w, 6.4)}</text>
            {ghost && planned?.why && b.h > CONTEXT_H && (
              <text className="map-mod-file" x={b.x + 12} y={b.y + 58}>{clip(planned.why, b.w, 6.4)}</text>
            )}
            {notes?.get(b.id)?.slice(0, 3).map((line, i) => (
              <text key={i} className="map-mod-file note" x={b.x + 12} y={b.y + 58 + i * 14}>
                {clip(line, b.w, 6.4)}
              </text>
            ))}
            {!notes && m.files.slice(-3).map((f, i) => (
              <text key={f.path} className={f.isNew ? 'map-mod-file new' : 'map-mod-file'} x={b.x + 12} y={b.y + 58 + i * 14}>
                {clip(`${f.isNew ? '+' : '~'} ${f.name}`, b.w, 6.4)}
              </text>
            ))}
            {tag ? (
              <text className={planOpen && !bound ? 'map-mod-tag plan' : 'map-mod-tag'} x={b.x + b.w - 10} y={b.y + 22} textAnchor="end">
                {tag}
              </text>
            ) : (
              !ghost && b.files > 0 && (
                <text className="map-mod-size" x={b.x + b.w - 10} y={b.y + 22} textAnchor="end">
                  {tr('mapTab.files', { count: b.files })}
                </text>
              )
            )}
            {(crew.length > 0 || steps.length > 0) && <Footer b={b} crew={crew} steps={steps} tally={view.tally} past={view.past} />}
          </g>
        )
      })}
    </svg>
  )
}

/** The module's footer strip: who is here (Claude, an agent, another session) and which plan steps land here. */
function Footer({ b, crew, steps, tally, past }: { b: Box; crew: Crew[]; steps: View['steps']; tally: string; past: boolean }) {
  const y = b.y + b.h - FOOT_H
  const base = b.y + b.h - 10
  const ordered = [...crew].sort((a, c) => ['main', 'agent', 'peer'].indexOf(a.kind) - ['main', 'agent', 'peer'].indexOf(c.kind))
  const lead = ordered[0]
  const more = ordered.length - 1
  const stepText = steps.length === 1 ? tr('mapTab.footer.step', { n: steps[0].n }) : steps.length ? tr('mapTab.footer.steps', { list: steps.map((x) => x.n).join(', ') }) : ''
  const stepState = steps.some((x) => x.status === 'active') ? 'now' : steps.length && steps.every((x) => x.status === 'done') ? 'done' : 'todo'
  const stepW = stepText ? stepText.length * 6.6 + 12 : 0
  const moreW = more > 0 ? 26 : 0
  // Room for the crew line after the lamp, the step label and any "+N".
  const room = b.w - 12 - 14 - 10 - stepW - moreW
  const whoMax = Math.floor(room / 7)
  const who = lead ? clip(lead.who, whoMax * 7 + 24, 7) : ''
  const sayRoom = room - who.length * 7 - 5
  const say = lead?.say && sayRoom > 40 ? clip(lead.say, sayRoom + 24, 6.4) : ''
  const lampClass = lead?.kind === 'main' && !past ? ` tally-${tally}` : ''
  const tip = ordered.map((c) => (c.kind === 'peer' ? tr('mapTab.footer.peer', { who: c.who }) : tr('mapTab.footer.crew', { who: c.who, say: c.say }))).join('\n')
  return (
    <g className="map-foot">
      <line className="map-foot-rule" x1={b.x + 1} x2={b.x + b.w - 1} y1={y} y2={y} />
      {lead && (
        <g className={`map-crew ${lead.kind}${lampClass}`} data-tip={tip}>
          <circle className="map-crew-lamp" cx={b.x + 16} cy={base - 4} r={4} />
          <text x={b.x + 26} y={base}>
            <tspan className="map-crew-who">{who}</tspan>
            {say && <tspan className="map-crew-say" dx={5}>{say}</tspan>}
          </text>
          {more > 0 && (
            <text className="map-crew-more" x={b.x + b.w - 10 - stepW} y={base} textAnchor="end">+{more}</text>
          )}
        </g>
      )}
      {stepText && (
        <text className={`map-step ${stepState}`} x={b.x + b.w - 10} y={base} textAnchor="end" data-tip={steps.map((x) => tr('mapTab.footer.stepTip', { n: x.n, label: x.label })).join('\n')}>
          {stepText}
        </text>
      )}
    </g>
  )
}

type Connection = { id: string; other: string; out: boolean; links: ArchLink[] }

/** A module's connections, both ways, busiest first (matching how the explainer groups them). */
function connectionsOf(arch: Architecture, id: string): Connection[] {
  const by = new Map<string, Connection>()
  for (const l of arch.links ?? []) {
    const out = l.fromModule === id
    if (!out && l.toModule !== id) continue
    const other = out ? l.toModule : l.fromModule
    const key = `${out ? 'out' : 'in'}:${other}`
    let c = by.get(key)
    if (!c) by.set(key, (c = { id: key, other, out, links: [] }))
    c.links.push(l)
  }
  return [...by.values()].sort((a, b) => b.links.length - a.links.length)
}

function Inspector({
  arch,
  cwd,
  box,
  mod,
  bound,
  boundsFocus,
  plan,
  decisions,
  edited,
  onHover,
  onClose,
  onBound,
  onRipple,
  onOpen,
  onAsk
}: {
  arch: Architecture
  cwd: string
  box: Box
  mod: View['mods'][string]
  bound: Bound | null
  boundsFocus: number
  plan: PlanShape | null
  decisions: ModuleDecision[]
  edited: Set<string>
  onHover: (other: string | null) => void
  onClose: () => void
  onBound: (mark: Bound | null) => void
  onRipple: () => void
  onOpen: (path: string, changed: boolean) => void
  onAsk: (text: string) => void
}) {
  const where = box.path ? `${box.path}/` : 'the project root'
  const ghost = isGhost(box.id)
  const conns = useMemo(() => (ghost ? [] : connectionsOf(arch, box.id)), [arch, box.id, ghost])
  const uses = conns.filter((c) => c.out)
  const usedBy = conns.filter((c) => !c.out)
  const nameOf = (id: string) => arch.modules.find((m) => m.id === id)?.name ?? plan?.ghosts.find((g) => g.id === id)?.name ?? id
  const inPlan = plan?.modules.get(box.id)
  const planEdges = (plan?.edges ?? []).filter((e) => (e.from === box.id || e.to === box.id) && !planEdgeDone(arch, e))
  // Right-clicking the module on the map lands here, on the limits.
  const boundsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!boundsFocus) return
    boundsRef.current?.scrollIntoView({ block: 'nearest' })
    boundsRef.current?.querySelector<HTMLInputElement>('input:checked')?.focus()
  }, [boundsFocus])

  // Why each connection exists: written in the background by Claude, then kept until the code changes.
  const [why, setWhy] = useState<Record<string, string> | null>(null)
  const [whyError, setWhyError] = useState<string | null>(null)
  useEffect(() => {
    setWhy(null)
    setWhyError(null)
    if (!conns.length || ghost) return
    let stale = false
    window.glassbox.architecture
      .explain(cwd, box.id)
      .then((r) => {
        if (stale) return
        setWhy(r.why)
        if (r.error) setWhyError(r.error)
      })
      .catch((e) => !stale && setWhyError(String(e)))
    return () => {
      stale = true
    }
  }, [cwd, box.id, conns.length])

  const abs = (rel: string) => `${arch.root}/${rel}`
  const row = (c: Connection) => {
    const changed = [...new Set(c.links.flatMap((l) => [l.from, l.to]).filter((f) => f && edited.has(f.toLowerCase())))]
    // One line per thing imported, listing the files that import it (a dozen C# files all using
    // NaqApp.Shared read as one line, not twelve).
    const byTarget = new Map<string, { to: string; from: string[]; names: Set<string>; http: boolean; weak: boolean }>()
    for (const l of c.links) {
      const k = l.to || l.toModule
      let g = byTarget.get(k)
      if (!g) byTarget.set(k, (g = { to: l.to, from: [], names: new Set(), http: !!l.http, weak: !!l.weak }))
      // One certain call makes the group certain.
      if (!l.weak) g.weak = false
      if (!g.from.includes(l.from)) g.from.push(l.from)
      for (const n of l.names) g.names.add(n)
    }
    const targets = [...byTarget.values()].sort((a, b) => b.from.length - a.from.length)
    const shownTargets = targets.slice(0, 3)
    const sentence = why?.[c.id]
    return (
      <div key={c.id} className="map-conn" onMouseEnter={() => onHover(c.other)} onMouseLeave={() => onHover(null)}>
        <div className="map-conn-name">{nameOf(c.other)}</div>
        {why === null && !whyError ? <div className="map-conn-why skeleton-bar" /> : sentence ? <div className="map-conn-why">{sentence}</div> : null}
        <div className="map-conn-links">
          {shownTargets.map((g, i) => {
            const names = [...g.names]
            const file = (f: string) => (
              <button key={f} className="map-conn-file" onClick={() => onOpen(abs(f), edited.has(f.toLowerCase()))} title={f}>
                {baseName(f)}
              </button>
            )
            return (
              <div key={i} className="map-conn-link">
                {g.from.slice(0, 2).map((f, j) => (
                  <span key={f}>
                    {j > 0 && <span className="map-conn-names">, </span>}
                    {file(f)}
                  </span>
                ))}
                {g.from.length > 2 && <span className="map-conn-names">{` ${tr('mapTab.conn.andMore', { n: g.from.length - 2 })}`}</span>}
                <span className="map-conn-names">
                  {names.length
                    ? ` ${tr(g.weak ? (g.http ? 'mapTab.conn.probablyCalls' : 'mapTab.conn.probablyUses') : g.http ? 'mapTab.conn.calls' : 'mapTab.conn.uses', { count: g.from.length, names: `${names.slice(0, 4).join(', ')}${names.length > 4 ? ` ${tr('mapTab.conn.extra', { n: names.length - 4 })}` : ''}` })}`
                    : ` ${tr('mapTab.conn.imports', { count: g.from.length })}`}
                </span>
                {g.to && (
                  <>
                    <span className="map-conn-names">{g.http ? ` ${tr('mapTab.conn.in')} ` : names.length ? ` ${tr('mapTab.conn.from')} ` : ' '}</span>
                    {g.to.endsWith('/') ? <span className="map-conn-file">{baseName(g.to.replace(/\/$/, ''))}</span> : file(g.to)}
                  </>
                )}
              </div>
            )
          })}
          {targets.length > shownTargets.length && <div className="map-conn-more">{tr('mapTab.conn.moreFiles', { count: targets.length - shownTargets.length })}</div>}
        </div>
        {changed.length > 0 && <div className="map-conn-changed">{tr('mapTab.conn.changed', { files: changed.map((f) => baseName(f)).join(', ') })}</div>}
      </div>
    )
  }

  return (
    <div className="map-inspect" role="dialog" aria-label={box.name}>
      <div className="map-inspect-head">
        <div className="map-inspect-title">
          <strong>{box.name}</strong>
          <span className="mono muted">{box.path || tr('mapTab.root')}</span>
        </div>
        <IconButton icon="close" title={tr('mapTab.inspect.close')} onClick={onClose} />
      </div>
      <div className="map-inspect-meta">
        {ghost
          ? tr('mapTab.inspect.ghost')
          : box.external
          ? tr('mapTab.inspect.external')
          : tr('mapTab.inspect.size', { files: tr('mapTab.inspect.sourceFiles', { count: box.files }), tests: tr('mapTab.inspect.tests', { count: box.tests }) })}
        {mod.files.length > 0 && (
          <>
            {` ${tr('mapTab.inspect.claudeChanged')} `}
            {mod.files.map((f, i) => (
              <span key={f.path}>
                {i > 0 && ', '}
                <button className="link" onClick={() => onOpen(f.path, true)} title={`${f.path}\n${tr('mapTab.inspect.openDiff')}`}>
                  {f.name}
                </button>
              </span>
            ))}
            {` ${tr('mapTab.inspect.thisSession')}`}
          </>
        )}
      </div>

      {(inPlan || planEdges.length > 0) && (
        <div className="map-inspect-section map-inspect-plan">
          <div className="map-inspect-label">{tr('mapTab.inspect.inPlan')}</div>
          {inPlan?.why && <div className="map-conn-why">{inPlan.why}</div>}
          {planEdges.map((e) => {
            const out = e.from === box.id
            const other = nameOf(out ? e.to : e.from)
            const verb = e.http ? (e.change === 'new' ? 'Call' : 'StopCalling') : e.change === 'new' ? 'Use' : 'StopUsing'
            return (
              <div key={`${e.from}>${e.to}`} className={`map-plan-conn ${e.change}`}>
                <span>{tr(out ? `mapTab.inspect.will${verb}` : `mapTab.inspect.otherWill${verb}`, { other })}</span>
                {e.why && <span className="map-conn-names">{e.why}</span>}
              </div>
            )
          })}
        </div>
      )}

      {ghost ? null : conns.length === 0 ? (
        <div className="map-inspect-note">{tr('mapTab.inspect.noConnections')}</div>
      ) : (
        <>
          {uses.length > 0 && (
            <div className="map-inspect-section">
              <div className="map-inspect-label">{tr('mapTab.inspect.uses')}</div>
              {uses.map(row)}
            </div>
          )}
          {usedBy.length > 0 && (
            <div className="map-inspect-section">
              <div className="map-inspect-label">{tr('mapTab.inspect.usedBy')}</div>
              {usedBy.map(row)}
            </div>
          )}
          {whyError && <div className="map-inspect-note">{tr('mapTab.inspect.whyError', { error: whyError })}</div>}
        </>
      )}

      {decisions.length > 0 && (
        <div className="map-inspect-section">
          <div className="map-inspect-label">{tr('mapTab.inspect.decidedHere')}</div>
          {decisions.map((d, i) => (
            <div key={i} className="map-decision">
              <span className="map-decision-title">
                {d.kind === 'assumption' ? `${tr('mapTab.inspect.assumed')} ` : ''}
                {d.title}
              </span>
              {d.detail && <span className="map-conn-names">{d.detail}</span>}
              {d.earlier && <span className="map-decision-when">{tr('mapTab.inspect.earlierSession', { date: new Date(d.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) })}</span>}
            </div>
          ))}
        </div>
      )}

      <div className="map-inspect-actions">
        <button className="btn primary" onClick={() => onAsk(`About ${where}: `)} title={tr('mapTab.inspect.askTitle', { where: box.path ? `${box.path}/` : tr('mapTab.inspect.projectRoot') })}>
          {tr('mapTab.inspect.askClaude')}
        </button>
        {usedBy.length > 0 && (
          <button className="btn" onClick={onRipple} title={tr('mapTab.inspect.rippleTitle')}>
            {tr('mapTab.inspect.ripple')}
          </button>
        )}
        {!box.external && box.files > 0 && box.tests === 0 && (
          <button className="btn" onClick={() => onAsk(`Add tests for ${where} covering `)} title={tr('mapTab.inspect.askTestsTitle')}>
            {tr('mapTab.inspect.askTests')}
          </button>
        )}
      </div>

      {!box.external && !ghost && (
        <div className="map-inspect-bounds" ref={boundsRef} role="radiogroup" aria-label={tr('mapTab.inspect.bounds')}>
          <div className="map-inspect-label">{tr('mapTab.inspect.bounds')}</div>
          {BOUNDS.map((o) => (
            <label key={o.value ?? 'free'} className={bound === o.value ? 'map-bound on' : 'map-bound'}>
              <input type="radio" name={`bound-${box.id}`} checked={bound === o.value} onChange={() => onBound(o.value)} />
              <span className="map-bound-text">
                <span className="map-bound-label">{tr(o.label)}</span>
                <span className="map-bound-note">{tr(o.note)}</span>
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Winds the map back through the session, one key moment at a time. Moments are evenly spaced
 * whatever the gaps between them, so a session that ran for hours is as easy to scrub as a short
 * one; the last position is now.
 */
const STEPS = 10000

function ReplayBar({
  moments,
  at,
  playing,
  onSeek,
  onPlay,
  onNow
}: {
  moments: Moment[]
  at: number | null
  playing: boolean
  onSeek: (t: number) => void
  onPlay: () => void
  onNow: () => void
}) {
  const n = moments.length
  // Position n is now; 0..n-1 are the moments.
  let idx = n
  if (at !== null) {
    idx = 0
    for (let i = 0; i < n; i++) if (moments[i].at <= at) idx = i
  }
  const [hover, setHover] = useState<number | null>(null)
  const pct = (i: number) => (i / n) * 100
  const go = (v: number) => (v >= n ? onNow() : onSeek(moments[Math.max(0, v)].at))
  const shown = hover ?? idx
  const m = shown < n ? moments[shown] : null
  const start = moments[0].at
  const posAt = (e: React.MouseEvent<HTMLInputElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * n)
  }
  return (
    <div className={at === null ? 'map-replay' : 'map-replay past'}>
      <IconButton icon={playing ? 'debug-pause' : 'play'} title={playing ? tr('mapTab.replay.pause') : at === null ? tr('mapTab.replay.fromStart') : tr('mapTab.replay.fromHere')} onClick={onPlay} />
      <div className="map-replay-track">
        <div className="map-replay-marks" aria-hidden>
          {moments.map((mo, i) => (
            <span key={i} className={`${mo.kind}${i <= idx ? ' seen' : ''}${i === hover ? ' hover' : ''}`} style={{ left: `${pct(i)}%` }} />
          ))}
        </div>
        <span className="map-replay-head" style={{ left: `${pct(idx)}%` }} aria-hidden />
        <input
          type="range"
          className="map-replay-input"
          // A fixed 0..STEPS range (moments mapped onto it), so the browser never clamps the value
          // as moments arrive; and only a real drag or key press (the slider has focus) seeks.
          min={0}
          max={STEPS}
          step={STEPS / n}
          value={Math.round((idx / n) * STEPS)}
          onChange={(e) => e.currentTarget === document.activeElement && go(Math.round((Number(e.target.value) / STEPS) * n))}
          onMouseMove={(e) => setHover(posAt(e))}
          onMouseLeave={() => setHover(null)}
          aria-label={tr('mapTab.replay.label')}
          aria-valuetext={m ? tr('mapTab.replay.valueText', { time: elapsed(m.at - start), label: m.label }) : tr('mapTab.replay.now')}
        />
      </div>
      <div className="map-replay-status">
        {m ? (
          <>
            <span className="num">{elapsed(m.at - start)}</span>
            <span className="map-replay-what" title={m.label}>{m.label}</span>
          </>
        ) : (
          <span className="map-replay-what">{tr('mapTab.replay.now')}</span>
        )}
      </div>
      {at !== null && (
        <button className="btn quiet" onClick={onNow}>
          {tr('mapTab.replay.backToNow')}
        </button>
      )}
    </div>
  )
}

/** A band label in at most two lines that fit the label column; only the second line is clipped. */
function bandLines(label: string): string[] {
  const max = Math.floor((LABEL_W + 12 - 24) / 6.2)
  if (label.length <= max) return [label]
  const words = label.split(' ')
  let first = ''
  while (words.length && (first ? first + ' ' + words[0] : words[0]).length <= max) first = first ? first + ' ' + words.shift() : words.shift()!
  if (!first) return [clip(label, LABEL_W + 12, 6.6)]
  return [first, clip(words.join(' '), LABEL_W + 12, 6.6)]
}

/** Truncate SVG text to roughly fit a box (SVG text doesn't ellipsize by itself). */
function clip(s: string, w: number, charW: number): string {
  const max = Math.floor((w - 24) / charW)
  return s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s
}
