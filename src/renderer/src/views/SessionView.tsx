import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useActions, type AppActions } from '../App'
import { claudeInBrowser, type SessionState } from '../session'
import { defaultView, tabTitle, type Tab } from '../tabs'
import type { DiffMode, FileMark, Requirements, SideTaskSpec } from '../../../shared/events'
import { sessionBrief } from '../side'
import { baseName, mediaKind } from '../lib'
import { fileKind, filesToPaths, sessionAttachments } from '../attachments'
import { moduleOf } from '../../../shared/architecture'
import { ticketKeyFromBranch } from '../../../shared/ticket'
import { hasTicketOverride } from '../panels/TicketPanel'
import { AttachmentsTab } from '../work/AttachmentsTab'
import { ErdTab } from '../work/ErdTab'
import { TerminalTab } from '../work/TerminalTab'
import { Icon, IconButton, PanelActionsContext } from '../components/ui'
import { SessionHeader } from '../session-ui/SessionHeader'
import { AwayDigest } from '../session-ui/AwayDigest'
import { useAppearance } from '../appearance'
import { Timeline } from '../session-ui/Timeline'
import { Composer } from '../session-ui/Composer'
import { PermissionDialog } from '../session-ui/PermissionDialog'
import { PlanTab, type PlanShown } from '../work/PlanTab'
import { ActivityPanel } from '../panels/ActivityPanel'
import { ExplorerPanel } from '../panels/ExplorerPanel'
import { ContextPanel } from '../panels/ContextPanel'
import { ChangesPanel } from '../panels/ChangesPanel'
import { AgentsPanel } from '../panels/AgentsPanel'
import { DiagramsPanel } from '../panels/DiagramsPanel'
import { ConnectorsPanel } from '../panels/ConnectorsPanel'
import { SkillsPanel } from '../panels/SkillsPanel'
import { ShowcasePanel } from '../panels/ShowcasePanel'
import { RawPanel } from '../panels/RawPanel'
import { ServicesPanel } from '../panels/ServicesPanel'
import { ReviewPanel } from '../panels/ReviewPanel'
import { ReplayPanel } from '../panels/ReplayPanel'
import { DecisionsPanel } from '../panels/DecisionsPanel'
import { GuardrailsPanel } from '../panels/GuardrailsPanel'
import { FileTab } from '../work/FileTab'
import { DiffTab } from '../work/DiffTab'
import { CommitTab } from '../work/CommitTab'
import { useServices } from '../services'
import { BrowserTab } from '../work/BrowserTab'
import { activeBrowserTab, browserTabs, openInBrowser, waitForPage } from '../browser'
import { GitPanel } from '../panels/GitPanel'
import { loadAutoCommit } from '../panels/GitPanel'
import { LiveTab } from '../work/LiveTab'
import { useGuardrails } from '../review'
import { TicketPanel } from '../panels/TicketPanel'
import { MapTab } from '../work/MapTab'
import { RippleTab } from '../work/RippleTab'
import { FlowTab } from '../work/FlowTab'
import { tr } from '../../../shared/i18n'

/** Places a component can ask to show. Each maps to a side tab, or to a work-area tab. */
export type PanelId = 'map' | 'attachments' | 'activity' | 'replay' | 'review' | 'decisions' | 'guardrails' | 'services' | 'explorer' | 'context' | 'changes' | 'agents' | 'diagrams' | 'connectors' | 'skills' | 'showcase' | 'raw' | 'git' | 'preview' | 'ticket' | 'live' | 'ripple' | 'flows'

/** The side panel: five tabs you use all the time, and the rest one click away in More. */
type SideTab = 'route' | 'decisions' | 'changes' | 'ticket' | 'git' | 'context' | 'heatmap' | 'safety' | 'connectors' | 'skills' | 'raw'
// Changes holds git too (the branch's commits, what's uncommitted); Context holds the heatmap.
const SIDE_TABS: { id: SideTab; label: string }[] = [
  { id: 'route', label: tr('sessionView.sideTabs.route') },
  { id: 'decisions', label: tr('sessionView.sideTabs.decisions') },
  { id: 'changes', label: tr('sessionView.sideTabs.changes') },
  { id: 'context', label: tr('sessionView.sideTabs.context') },
  { id: 'ticket', label: tr('sessionView.sideTabs.ticket') }
]
/** Older names for tabs that were merged into another. */
const MERGED: Partial<Record<SideTab, SideTab>> = { git: 'changes', heatmap: 'context' }
// The side tab you picked, per project, so it's still there when you come back or reopen the session.
const SIDE_KEY = 'glassbox.sideTab'
function savedSide(cwd: string): SideTab {
  try {
    const v = (JSON.parse(localStorage.getItem(SIDE_KEY) ?? '{}') as Record<string, SideTab>)[projectKey(cwd)]
    return v ? (MERGED[v] ?? v) : 'route'
  } catch {
    return 'route'
  }
}
function saveSide(cwd: string, tab: SideTab) {
  try {
    const all = JSON.parse(localStorage.getItem(SIDE_KEY) ?? '{}') as Record<string, SideTab>
    all[projectKey(cwd)] = tab
    localStorage.setItem(SIDE_KEY, JSON.stringify(all))
  } catch {
    /* this run only */
  }
}
type MoreItem = { side: SideTab; label: string } | { work: 'ripple' | 'flows' | 'diagrams' | 'showcase' | 'replay' | 'preview' | 'live' | 'attachments'; label: string }
const MORE: { group: string; items: MoreItem[] }[] = [
  { group: tr('sessionView.more.lookCloser'), items: [{ side: 'safety', label: tr('sessionView.more.safety') }, { side: 'raw', label: tr('sessionView.more.raw') }] },
  { group: tr('sessionView.more.setUp'), items: [{ side: 'connectors', label: tr('sessionView.more.connectors') }, { side: 'skills', label: tr('sessionView.more.skills') }] }
]
/** What the More tab says while one of its panels is showing: short, so the tab row still fits. */
const MORE_LABEL: Partial<Record<SideTab, string>> = {
  changes: tr('sessionView.moreLabel.changes'),
  ticket: tr('sessionView.moreLabel.ticket'),
  git: tr('sessionView.moreLabel.git'),
  context: tr('sessionView.moreLabel.context'),
  heatmap: tr('sessionView.moreLabel.heatmap'),
  safety: tr('sessionView.moreLabel.safety'),
  raw: tr('sessionView.moreLabel.raw'),
  connectors: tr('sessionView.moreLabel.connectors'),
  skills: tr('sessionView.moreLabel.skills')
}

const ROUTES: Partial<Record<PanelId, SideTab>> = {
  activity: 'route',
  agents: 'route',
  services: 'route',
  review: 'changes',
  changes: 'changes',
  decisions: 'decisions',
  ticket: 'ticket',
  guardrails: 'safety',
  explorer: 'context',
  context: 'context',
  git: 'changes',
  connectors: 'connectors',
  skills: 'skills',
  raw: 'raw'
}

/**
 * The Everyday view keeps the conversation and what anyone would want from it (diagrams, decisions,
 * files, previews); the engineering views below only show when Claude brings one up.
 */
const ENGINEERING_WORK = new Set(['map', 'ripple', 'flows', 'live', 'replay'])
const EVERYDAY_SIDE = new Set<SideTab>(['route', 'decisions', 'context', 'connectors', 'skills'])
const EVERYDAY_WORK = new Set(['diagrams', 'showcase', 'attachments', 'preview'])

// A file dropped outside the drop area mustn't make the window navigate to it.
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

/** Something big enough to deserve the main area: opened next to the conversation as a tab. */
export type WorkTab =
  | { id: 'map'; kind: 'map' }
  | { id: 'conversation'; kind: 'conversation' }
  | { id: 'ripple'; kind: 'ripple'; module?: string; path?: string }
  | { id: 'flows'; kind: 'flows' }
  | { id: 'live'; kind: 'live' }
  | { id: 'diagrams'; kind: 'diagrams' }
  | { id: 'replay'; kind: 'replay' }
  | { id: 'showcase'; kind: 'showcase' }
  | { id: 'attachments'; kind: 'attachments' }
  | { id: 'erd'; kind: 'erd'; entities?: string[]; query?: string }
  | { id: 'terminal'; kind: 'terminal' }
  | { id: string; kind: 'file'; path: string; line?: number; endLine?: number }
  | { id: string; kind: 'diff'; path: string; base: string | null; diffMode: DiffMode; source: 'session' | 'branch' }
  | { id: string; kind: 'commit'; sha: string; title: string }
  | { id: 'preview'; kind: 'preview'; url?: string }
  | { id: 'plan'; kind: 'plan' }

/** Timeline filter: 'all', 'main' (top-level thread only) or a subagent's tool_use id. */
export type AgentFilter = 'all' | 'main' | string

type SessionUi = {
  tab: Tab
  s: SessionState
  actions: AppActions
  send: (text: string, display?: string) => Promise<void>
  showPanel: (id: PanelId) => void
  openFile: (path: string) => void
  openDiff: (d: { path: string; base: string | null; diffMode: DiffMode; source: 'session' | 'branch' }) => void
  /** Opens a commit (its files and their diffs) as a work tab. */
  openCommit: (sha: string, title: string) => void
  /** Open the Ripple tab on a module (or the latest change). */
  openRipple: (module?: string, path?: string) => void
  /** Other open sessions, so the map can show their crews faintly. */
  peers: { tab: Tab; s: SessionState }[]
  /** Path of the file or diff shown in the work area, if any (for highlighting lists). */
  workPath: string | null
  filter: AgentFilter
  setFilter: (f: AgentFilter) => void
  markFile: (path: string, mark: FileMark | null) => void
  updateRequirements: (fn: (r: Requirements) => Requirements) => void
  checkpoint: string | null
  setCheckpoint: (uuid: string | null) => void
  planFirst: boolean
  setPlanFirst: (on: boolean) => void
  /** Run a sidebar request in the background, with a brief of this session attached. */
  runSide: (spec: SideTaskSpec) => void
  composerRef: React.RefObject<{ insert: (text: string) => void; attach: (paths: string[]) => void } | null>
  /** Everyday view: the conversation without the engineering panels (map, changes, git, services, tests). */
  everyday: boolean
  /** Open a file you attached or Claude made: inside Glassbox when it can show it, otherwise in its own app. */
  openAttachment: (path: string) => void
  /** Attach files (paths on disk) to the message you're writing. */
  attachFiles: (paths: string[]) => void
  /** Open the Plan view: the plan waiting for you, or one to read again (the latest unless given). */
  openPlan: (plan?: PlanShown) => void
  showMap: () => void
}

const SessionContext = createContext<SessionUi | null>(null)
export const useSession = () => useContext(SessionContext)!

const WIDTH_KEY = 'glassbox.sideWidth2'
const CONVERSATION: WorkTab = { id: 'conversation', kind: 'conversation' }
const MAP: WorkTab = { id: 'map', kind: 'map' }
const PLAN: WorkTab = { id: 'plan', kind: 'plan' }
/** Only the conversation is always there; every other view is a tab you open (or Claude does) and can close. */
const FIXED: WorkTab[] = [CONVERSATION]
const isFixed = (t: WorkTab) => t.kind === 'conversation'

/** The views the + in the tab strip opens, with what each is for. */
type ViewKind = 'plan' | 'terminal' | 'map' | 'erd' | 'ripple' | 'flows' | 'live' | 'diagrams' | 'replay' | 'attachments' | 'preview' | 'showcase'
const VIEWS: { kind: ViewKind; label: string; note: string; everyday?: boolean }[] = [
  { kind: 'plan', label: tr('sessionView.views.plan.label'), note: tr('sessionView.views.plan.note'), everyday: true },
  { kind: 'map', label: tr('sessionView.views.map.label'), note: tr('sessionView.views.map.note') },
  { kind: 'terminal', label: tr('sessionView.views.terminal.label'), note: tr('sessionView.views.terminal.note') },
  { kind: 'erd', label: tr('sessionView.views.erd.label'), note: tr('sessionView.views.erd.note') },
  { kind: 'live', label: tr('sessionView.views.live.label'), note: tr('sessionView.views.live.note') },
  { kind: 'ripple', label: tr('sessionView.views.ripple.label'), note: tr('sessionView.views.ripple.note') },
  { kind: 'flows', label: tr('sessionView.views.flows.label'), note: tr('sessionView.views.flows.note') },
  { kind: 'diagrams', label: tr('sessionView.views.diagrams.label'), note: tr('sessionView.views.diagrams.note'), everyday: true },
  { kind: 'attachments', label: tr('sessionView.views.attachments.label'), note: tr('sessionView.views.attachments.note'), everyday: true },
  { kind: 'preview', label: tr('sessionView.views.preview.label'), note: tr('sessionView.views.preview.note'), everyday: true },
  { kind: 'showcase', label: tr('sessionView.views.showcase.label'), note: tr('sessionView.views.showcase.note'), everyday: true },
  { kind: 'replay', label: tr('sessionView.views.replay.label'), note: tr('sessionView.views.replay.note') }
]
const viewTab = (kind: ViewKind): WorkTab => ({ id: kind, kind }) as WorkTab

// Views you asked to keep open, per project: they open with every session there.
const KEEP_KEY = 'glassbox.keepOpen'
const projectKey = (cwd: string) => cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
function keptViews(cwd: string): ViewKind[] {
  try {
    return (JSON.parse(localStorage.getItem(KEEP_KEY) ?? '{}') as Record<string, ViewKind[]>)[projectKey(cwd)] ?? []
  } catch {
    return []
  }
}
function setKept(cwd: string, kind: ViewKind, on: boolean) {
  try {
    const all = JSON.parse(localStorage.getItem(KEEP_KEY) ?? '{}') as Record<string, ViewKind[]>
    const list = new Set(all[projectKey(cwd)] ?? [])
    if (on) list.add(kind)
    else list.delete(kind)
    all[projectKey(cwd)] = [...list]
    localStorage.setItem(KEEP_KEY, JSON.stringify(all))
  } catch {
    /* kept for now only */
  }
}

type SessionViewProps = { tab: Tab; session: SessionState; active: boolean; peers?: { tab: Tab; s: SessionState }[] }

/**
 * Each open tab keeps its view, but only redraws for its own session. The other sessions (peers,
 * for overlap warnings and the map) matter only to the tab you're looking at; a fresh list of them
 * on every update used to redraw every tab whenever any session streamed a word.
 */
export const SessionView = memo(SessionViewInner, (a: SessionViewProps, b: SessionViewProps) => {
  if (a.tab !== b.tab || a.session !== b.session || a.active !== b.active) return false
  if (!b.active) return true
  const pa = a.peers ?? [], pb = b.peers ?? []
  return pa.length === pb.length && pa.every((p, i) => p.tab === pb[i].tab && p.s === pb[i].s)
})

function SessionViewInner({ tab, session, active, peers = [] }: SessionViewProps) {
  const appearance = useAppearance()
  const actions = useActions()
  const [side, setSideState] = useState<SideTab>(() => savedSide(tab.cwd))
  const setSide = useCallback((next: SideTab) => {
    const t = MERGED[next] ?? next
    setSideState(t)
    saveSide(tab.cwd, t)
  }, [tab.cwd])
  const [sideOpen, setSideOpen] = useState(true)
  const [moreOpen, setMoreOpen] = useState(false)
  // The conversation, plus any views you keep open for this project.
  const [kept, setKeptState] = useState<ViewKind[]>(() => keptViews(tab.cwd))
  const [work, setWork] = useState<WorkTab[]>(() => [...FIXED, ...keptViews(tab.cwd).map(viewTab)])
  const [activeWork, setActiveWork] = useState('conversation')
  const [unseen, setUnseen] = useState<Set<string>>(new Set())
  // The main conversation by default; an agent's own work is one pick away (the switcher above it).
  const [filter, setFilter] = useState<AgentFilter>('main')
  const [checkpoint, setCheckpoint] = useState<string | null>(null)
  const [planFirst, setPlanFirst] = useState(false)
  // An earlier plan picked from the conversation to read again (otherwise the Plan view shows the latest).
  const [planShown, setPlanShown] = useState<PlanShown | null>(null)
  const planRequest = session.permissions.find((p) => p.toolName === 'ExitPlanMode')?.id
  const asks = session.permissions.filter((p) => p.toolName !== 'ExitPlanMode')
  const guardrails = useGuardrails()
  const [width, setWidth] = useState(() => Number(localStorage.getItem(WIDTH_KEY)) || 420)
  const composerRef = useRef<{ insert: (text: string) => void; attach: (paths: string[]) => void } | null>(null)
  // Everyday or Engineering: chosen per session; unset, the one you last picked (Engineering to begin with).
  const everyday = (tab.view ?? defaultView()) === 'everyday'
  // Everyday doesn't offer every side tab: one it hides (picked in Engineering) shows Route instead,
  // without changing what Engineering remembers.
  useEffect(() => {
    if (everyday && !EVERYDAY_SIDE.has(side)) setSideState('route')
  }, [everyday, side])
  const [dragging, setDragging] = useState(false)
  // The view's area, for full screen.
  const workContent = useRef<HTMLDivElement>(null)
  const reqRef = useRef(session.requirements)
  reqRef.current = session.requirements

  const openWork = useCallback((t: WorkTab, focus = true) => {
    setWork((w) => (w.some((x) => x.id === t.id) ? w.map((x) => (x.id === t.id ? t : x)) : [...w, t]))
    if (focus) {
      setActiveWork(t.id)
      setUnseen((u) => {
        const n = new Set(u)
        n.delete(t.id)
        return n
      })
    } else setUnseen((u) => new Set([...u, t.id]))
  }, [])

  // Claude presented a plan: its view comes to the front, and stays a tab while you look at anything else.
  useEffect(() => {
    if (!planRequest) return
    setPlanShown(null)
    openWork(PLAN)
  }, [planRequest, openWork])

  // A view that opens by itself stays closed once you close it, until it has something new to show.
  const autoSeen = useRef<Record<string, { tabId: string; count: number }>>({})
  const closedAt = useRef<Record<string, number>>({})
  const autoOpen = useCallback(
    (key: string, t: WorkTab, count: number) => {
      autoSeen.current[key] = { tabId: t.id, count }
      if (!count || (closedAt.current[key] !== undefined && count <= closedAt.current[key])) return
      openWork(t, false)
    },
    [openWork]
  )

  const closeWork = (id: string) => {
    if (FIXED.some((t) => t.id === id)) return
    for (const [key, v] of Object.entries(autoSeen.current)) if (v.tabId === id) closedAt.current[key] = v.count
    setWork((w) => {
      const i = w.findIndex((x) => x.id === id)
      const next = w.filter((x) => x.id !== id)
      if (activeWork === id) setActiveWork(next[Math.max(0, i - 1)]?.id ?? 'conversation')
      return next
    })
  }

  const showPanel = useCallback(
    (id: PanelId) => {
      if (id === 'diagrams') return openWork({ id: 'diagrams', kind: 'diagrams' })
      if (id === 'live') return openWork({ id: 'live', kind: 'live' })
      if (id === 'ripple') return openWork({ id: 'ripple', kind: 'ripple' })
      if (id === 'flows') return openWork({ id: 'flows', kind: 'flows' })
      if (id === 'replay') return openWork({ id: 'replay', kind: 'replay' })
      if (id === 'showcase') return openWork({ id: 'showcase', kind: 'showcase' })
      if (id === 'preview') return openWork({ id: 'preview', kind: 'preview' })
      if (id === 'attachments') return openWork({ id: 'attachments', kind: 'attachments' })
      if (id === 'map') return openWork(MAP)
      const route = ROUTES[id]
      if (!route) return
      setSide(route)
      setSideOpen(true)
    },
    [openWork]
  )

  const editCount = session.files.filter((f) => ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'ShellEdit'].includes(f.tool)).length
  // Ripple no longer opens by itself: it's the "What would this affect?" button on edits and in Changes.

  // The map earns its tab: when Claude draws a plan on it, or the work spans several modules.
  const [spread, setSpread] = useState(0)
  const touchKey = [...new Set(session.files.map((f) => f.path))].join('|')
  useEffect(() => {
    if (everyday || !session.files.length) return
    let live = true
    const t = setTimeout(() => {
      void window.glassbox.architecture
        .get(tab.cwd)
        .then((arch) => {
          if (!live) return
          const edited = new Set<string>()
          const touched = new Set<string>()
          for (const f of session.files) {
            const m = moduleOf(arch, f.path)
            if (!m) continue
            touched.add(m.id)
            if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'ShellEdit'].includes(f.tool)) edited.add(m.id)
          }
          setSpread(edited.size >= 2 || touched.size >= 4 ? touched.size : 0)
        })
        .catch(() => {})
    }, 1500)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [touchKey, everyday, tab.cwd])
  useEffect(() => {
    if (!everyday) autoOpen('map:plan', MAP, session.planMap?.at ?? 0)
  }, [session.planMap?.at, everyday, autoOpen])
  useEffect(() => {
    if (!everyday) autoOpen('map:spread', MAP, spread)
  }, [spread, everyday, autoOpen])

  // Files you attach and Claude makes collect in the Attachments tab, which opens (without taking
  // focus) when the first one arrives.
  const attachmentCount = useMemo(() => sessionAttachments(session, tab.cwd).length, [session.timeline, session.presented, session.files, tab.cwd])
  useEffect(() => autoOpen('attachments', { id: 'attachments', kind: 'attachments' }, attachmentCount), [attachmentCount, autoOpen])

  // When a service with a web address comes up, its preview opens as a tab (without taking focus).
  const services = useServices(tab.id, tab.cwd).snapshot
  const webUp = !!services?.services.some((x) => x.status === 'running' && /^https?:\/\//.test(x.config.url ?? ''))
  // Each time the app comes up counts as new.
  const upCount = useRef(0)
  const wasUp = useRef(false)
  if (webUp && !wasUp.current) upCount.current++
  wasUp.current = webUp
  useEffect(() => {
    if (webUp) autoOpen('preview', { id: 'preview', kind: 'preview' }, upCount.current)
  }, [webUp, autoOpen])

  // New diagrams and showcases open as tabs without pulling you away from what you're reading.
  const flowCount = Object.keys(session.flows ?? {}).length
  // What Claude made for you opens by itself (without taking focus): diagrams, flows, a showcase.
  const flowAt = Math.max(0, ...Object.values(session.flows ?? {}).map((f) => f.at))
  useEffect(() => {
    if (!everyday) autoOpen('flows', { id: 'flows', kind: 'flows' }, flowAt)
  }, [flowAt, everyday, autoOpen])
  const diagramCount = Object.keys(session.diagrams).length
  const diagramAt = Math.max(0, ...Object.values(session.diagrams).map((d) => d.at))
  useEffect(() => autoOpen('diagrams', { id: 'diagrams', kind: 'diagrams' }, diagramAt), [diagramAt, autoOpen])
  useEffect(() => autoOpen('showcase', { id: 'showcase', kind: 'showcase' }, session.showcase?.at ?? 0), [session.showcase?.at, autoOpen])

  // Claude's browser tools: open a page in a Browser tab (and wait for it), or list the tabs.
  useEffect(
    () =>
      window.glassbox.browser.onRequest(({ reqId, tabId, cmd }) => {
        if (tabId !== tab.id) return
        if (cmd.cmd === 'tabs') {
          return window.glassbox.browser.reply(reqId, browserTabs(tab.id).map((b, i, all) => ({ tab: b.id, url: b.url, title: b.title, wcId: b.wcId, active: b.id === (activeBrowserTab(tab.id) ?? all[0]?.id) })))
        }
        if (cmd.cmd === 'open' && cmd.url) {
          openWork({ id: 'preview', kind: 'preview' }, false)
          const id = openInBrowser(tab.id, cmd.url, cmd.newTab !== false)
          void waitForPage(tab.id, id).then(
            (wcId) => window.glassbox.browser.reply(reqId, { tab: id, wcId }),
            (e) => window.glassbox.browser.reply(reqId, null, String(e instanceof Error ? e.message : e))
          )
          return
        }
        window.glassbox.browser.reply(reqId, null, `Unknown browser request ${cmd.cmd}`)
      }),
    [tab.id, openWork]
  )

  // Claude asked to show the user something (open_file, show_on_map, …): bring it to the front,
  // with Claude's one-line reason above it.
  const [claudeNote, setClaudeNote] = useState<{ work: string; text: string } | null>(null)
  const lastOpen = useRef(session.open?.n ?? 0)
  useEffect(() => {
    const o = session.open
    if (!o || o.n <= lastOpen.current) return
    lastOpen.current = o.n
    const abs = (p: string) => (/^([a-z]:|\/|\\)/i.test(p) ? p : `${tab.cwd.replace(/[\\/]+$/, '')}/${p.replace(/^\.\//, '')}`)
    const t = o.target
    let w: WorkTab
    // An image Claude shows you appears inline in the conversation (under that step), not as a tab.
    if (t.view === 'file' && mediaKind(t.path)) w = CONVERSATION
    else if (t.view === 'file') w = { id: `file:${abs(t.path)}`, kind: 'file', path: abs(t.path), line: t.line, endLine: t.endLine }
    else if (t.view === 'diff') w = { id: `diff:session:${abs(t.path)}`, kind: 'diff', path: abs(t.path), base: null, diffMode: 'merge-base', source: 'session' }
    else if (t.view === 'map') w = MAP
    else if (t.view === 'ripple') w = { id: 'ripple', kind: 'ripple', path: abs(t.path) }
    else if (t.view === 'preview') {
      // Claude showing a page: in a new Browser tab, unless one already shows it.
      if (!browserTabs(tab.id).some((b) => b.url === t.url)) openInBrowser(tab.id, t.url)
      w = { id: 'preview', kind: 'preview' }
    }
    else if (t.view === 'erd') w = { id: 'erd', kind: 'erd', entities: t.entities, query: t.query }
    else {
      // Tool names for views, mapped to the views' own kinds.
      const kind = t.tab === 'database' ? 'erd' : t.tab === 'browser' ? 'preview' : t.tab
      w = kind === 'map' ? MAP : kind === 'conversation' ? CONVERSATION : ({ id: kind, kind } as WorkTab)
    }
    openWork(w)
    setClaudeNote(o.why ? { work: w.id, text: o.why } : null)
  }, [session.open, tab.cwd, openWork])

  // Each (re)started host gets the current requirements and guardrails.
  const ready = session.status === 'ready' || session.status === 'running'
  useEffect(() => {
    if (!ready) return
    void window.glassbox.session.setRequirements(tab.id, reqRef.current)
    void window.glassbox.session.setGuardrails(tab.id, guardrails)
    void window.glassbox.session.setAutoCommit(tab.id, loadAutoCommit())
  }, [ready, tab.id, guardrails])

  // Questions block progress until you answer, so they pull focus.
  const openQuestions = session.decisions.filter((d) => d.kind === 'question' && !d.challenged).length
  useEffect(() => {
    if (openQuestions) showPanel('decisions')
  }, [openQuestions, showPanel])

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setSideOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  const updateRequirements = useCallback((fn: (r: Requirements) => Requirements) => actions.setRequirements(tab.id, fn(reqRef.current)), [actions, tab.id])

  const current = work.find((w) => w.id === activeWork) ?? CONVERSATION
  const workPath = current.kind === 'file' || current.kind === 'diff' ? current.path : null

  const ui = useMemo<SessionUi>(
    () => ({
      tab,
      s: session,
      actions,
      send: (text, display) => actions.send(tab.id, text, display),
      showPanel,
      openFile: (path) => openWork({ id: `file:${path}`, kind: 'file', path }),
      openDiff: (d) => openWork({ id: `diff:${d.source}:${d.path}`, kind: 'diff', ...d }),
      openCommit: (sha, title) => openWork({ id: `commit:${sha}`, kind: 'commit', sha, title }),
      openRipple: (module, path) => openWork({ id: 'ripple', kind: 'ripple', module, path }),
      peers,
      workPath,
      filter,
      setFilter,
      markFile: (path, mark) =>
        updateRequirements((r) => ({ ...r, files: mark ? [...r.files.filter((f) => f.path !== path), { path, mark }] : r.files.filter((f) => f.path !== path) })),
      updateRequirements,
      composerRef,
      checkpoint,
      setCheckpoint,
      planFirst,
      setPlanFirst,
      openPlan: (plan) => {
        setPlanShown(plan ?? null)
        openWork(PLAN)
      },
      showMap: () => openWork(MAP),
      everyday,
      attachFiles: (paths) => composerRef.current?.attach(paths),
      openAttachment: (path) => {
        const full = /^([a-z]:|\/|\\)/i.test(path) ? path : `${tab.cwd.replace(/[\\/]+$/, '')}/${path}`
        const kind = fileKind(full)
        const inProject = full.replace(/\\/g, '/').toLowerCase().startsWith(tab.cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() + '/')
        if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf' || (kind === 'text' && inProject)) return openWork({ id: `file:${full}`, kind: 'file', path: full })
        if (kind === 'web') return openWork({ id: 'preview', kind: 'preview', url: `file:///${full.replace(/\\/g, '/').replace(/^\/+/, '')}` })
        void window.glassbox.openPath(full)
      },
      runSide: (spec) => {
        void window.glassbox.session.side(tab.id, { ...spec, prompt: `${spec.prompt}\n\n## Context from the main session\n${sessionBrief(session, tab.cwd)}` })
        showPanel('activity')
      }
    }),
    [tab, session, actions, showPanel, openWork, workPath, filter, updateRequirements, checkpoint, planFirst, peers, everyday]
  )

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    document.body.classList.add('resizing')
    const startX = e.clientX
    const startW = width
    const move = (ev: MouseEvent) => setWidth(Math.min(window.innerWidth - 520, Math.max(320, startW + startX - ev.clientX)))
    const up = () => {
      document.body.classList.remove('resizing')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setWidth((w) => {
        localStorage.setItem(WIDTH_KEY, String(w))
        return w
      })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // Counts only on tabs where something waits for you.
  const count: Partial<Record<SideTab, { n: number; urgent?: boolean }>> = {}
  const unreviewed = session.decisions.filter((d) => d.kind === 'assumption' && !d.challenged).length
  if (openQuestions) count.decisions = { n: openQuestions, urgent: true }
  const openFindings = session.findings.filter((f) => f.status === 'open').length
  if (openFindings) count.changes = { n: openFindings }
  const waiting = session.checkins.filter((c) => c.answer === undefined).length
  if (waiting) count.route = { n: waiting, urgent: true }
  // Ticket shows once the branch names one (or you set a key); until the git info arrives it stays put rather than vanishing.
  const sideApplies = (id: SideTab) => (id === 'ticket' ? !!ticketKeyFromBranch(session.git?.branch) || hasTicketOverride(tab.cwd, session.git?.branch) || (side === 'ticket' && !session.git) : true)
  const inMore = !SIDE_TABS.some((x) => x.id === side && (!everyday || EVERYDAY_SIDE.has(x.id)) && sideApplies(x.id))
  // Whether each view has anything to show yet (the + list greys out the empty ones).
  const viewHas = (kind: ViewKind): boolean => {
    switch (kind) {
      case 'terminal':
        return true
      case 'map':
      case 'erd':
        return session.git?.isRepo !== false
      case 'live':
      case 'ripple':
        return editCount > 0
      case 'flows':
        return flowCount > 0
      case 'diagrams':
        return diagramCount > 0
      case 'attachments':
        return attachmentCount > 0
      case 'showcase':
        return !!session.showcase
      case 'replay':
        return session.timeline.length > 0
      case 'plan':
        return !!session.plan || !!planRequest
      case 'preview':
        return true
    }
  }

  return (
    <SessionContext.Provider value={ui}>
      <div
        className="session"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          if (!dragging) setDragging(true)
        }}
        onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return
          e.preventDefault()
          setDragging(false)
          void filesToPaths([...e.dataTransfer.files]).then((paths) => paths.length && composerRef.current?.attach(paths))
        }}
      >
        {dragging && (
          <div className="drop-overlay" onDragLeave={() => setDragging(false)}>
            <div className="drop-card">
              <Icon name="attach" />
              <strong>{tr('sessionView.dropToAttach')}</strong>
              <span className="muted">{tr('sessionView.dropNote')}</span>
            </div>
          </div>
        )}
        <SessionHeader />
        <SharedFolderBanner />
        <div className="session-body">
          <section className="work">
            <WorkTabs
              tabs={everyday ? work.filter((t) => !ENGINEERING_WORK.has(t.kind) || t.id === activeWork) : work}
              active={activeWork}
              unseen={unseen}
              onActivate={(id) => openWork(work.find((w) => w.id === id)!)}
              onClose={closeWork}
              diagramCount={diagramCount}
              claudeBrowsing={claudeInBrowser(session).active}
              kept={kept}
              onKeep={(kind, on) => {
                setKept(tab.cwd, kind, on)
                setKeptState(keptViews(tab.cwd))
              }}
              views={VIEWS.filter((v) => !everyday || v.everyday).map((v) => ({ ...v, has: viewHas(v.kind) }))}
              onOpenView={(kind) => openWork(kind === 'map' ? MAP : viewTab(kind))}
              onFullScreen={() => void workContent.current?.requestFullscreen().catch(() => {})}
            />
            {claudeNote && claudeNote.work === current.id && (
              <div className="claude-note" role="status">
                <span className="claude-note-who">{tr('sessionView.claude')}</span>
                <span className="grow">{claudeNote.text}</span>
                <IconButton icon="close" title={tr('sessionView.dismiss')} onClick={() => setClaudeNote(null)} />
              </div>
            )}
            <div className="work-content" ref={workContent}>
              {/* Only shown while the view is full screen. */}
              <button className="fs-exit" onClick={() => void document.exitFullscreen().catch(() => {})} title={tr('sessionView.exitFullScreenTitle')}>
                <Icon name="screen-normal" /> {tr('sessionView.exitFullScreen')}
              </button>
              {current.kind === 'map' && <MapTab />}
              {current.kind === 'ripple' && <RippleTab key={current.module ?? current.path ?? 'latest'} module={current.module} path={current.path} onPick={(m) => openWork({ id: 'ripple', kind: 'ripple', module: m })} />}
              {current.kind === 'flows' && <FlowTab />}
              <div className="chat" hidden={current.kind !== 'conversation'}>
                {appearance.awayDigest && <AwayDigest active={active && current.kind === 'conversation'} />}
                <Timeline />
              </div>
              {current.kind === 'live' && <LiveTab />}
              {current.kind === 'diagrams' && <DiagramsPanel />}
              {current.kind === 'replay' && <ReplayPanel />}
              {current.kind === 'showcase' && <ShowcasePanel />}
              {current.kind === 'attachments' && <AttachmentsTab />}
              {current.kind === 'plan' && <PlanTab shown={planShown} />}
              {current.kind === 'terminal' && <TerminalTab />}
              {current.kind === 'erd' && <ErdTab key={`${current.query ?? ''}|${(current.entities ?? []).join(',')}`} entities={current.entities} query={current.query} />}
              {current.kind === 'file' && <FileTab key={`${current.id}:${current.line ?? ''}:${current.endLine ?? ''}`} path={current.path} line={current.line} endLine={current.endLine} />}
              {/* The Browser stays loaded while hidden, so its pages (and Claude's use of them) carry on. */}
              {work.some((w) => w.kind === 'preview') && (
                <div className={current.kind === 'preview' ? 'browser-host' : 'browser-host inactive'} inert={current.kind !== 'preview'}>
                  <BrowserTab />
                </div>
              )}
              {current.kind === 'commit' && <CommitTab key={current.id} sha={current.sha} />}
              {current.kind === 'diff' && <DiffTab key={current.id} path={current.path} base={current.base} diffMode={current.diffMode} source={current.source} />}
            </div>
            <Composer compact={current.kind !== 'conversation'} />
          </section>
          {sideOpen && (
            <>
              <div className="splitter" onMouseDown={startResize} />
              <aside className="side" style={{ width }}>
                <nav className="side-tabs" role="tablist" aria-label={tr('sessionView.sidePanel')}>
                  {SIDE_TABS.filter((x) => (!everyday || EVERYDAY_SIDE.has(x.id)) && sideApplies(x.id)).map((x) => (
                    <button key={x.id} role="tab" aria-selected={side === x.id} className={side === x.id ? 'side-tab active' : 'side-tab'} onClick={() => setSide(x.id)}>
                      {x.label}
                      {count[x.id] && <span className={count[x.id]!.urgent ? 'side-count urgent' : 'side-count'}>{count[x.id]!.n}</span>}
                    </button>
                  ))}
                  <div className="side-more">
                    <button className={inMore ? 'side-tab active' : 'side-tab'} aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>
                      <span className="ellipsis">{inMore ? MORE_LABEL[side] : tr('sessionView.more.more')}</span>
                      <Icon name="chevron-down" />
                    </button>
                    {moreOpen && (
                      <>
                        <div className="menu-scrim" onMouseDown={() => setMoreOpen(false)} />
                        <div className="menu" role="menu">
                          {/* Views already open as tabs aren't offered again. */}
                          {MORE.map((g) => ({ ...g, items: g.items.filter((i) => (!('work' in i) || !work.some((w) => w.id === i.work)) && (!everyday || ('side' in i ? EVERYDAY_SIDE.has(i.side) : EVERYDAY_WORK.has(i.work)))) })).filter((g) => g.items.length).map((g) => (
                            <div key={g.group} className="menu-group">
                              <div className="menu-heading">{g.group}</div>
                              {g.items.map((i) => (
                                <button
                                  key={i.label}
                                  role="menuitem"
                                  className={'side' in i && i.side === side ? 'menu-item current' : 'menu-item'}
                                  onClick={() => {
                                    setMoreOpen(false)
                                    if ('side' in i) setSide(i.side)
                                    else showPanel(i.work)
                                  }}
                                >
                                  {i.label}
                                </button>
                              ))}
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  <span className="spacer" />
                  <button className="icon-btn" title={tr('sessionView.hideSideTitle')} aria-label={tr('sessionView.hideSide')} onClick={() => setSideOpen(false)}>
                    <Icon name="layout-sidebar-right-off" />
                  </button>
                </nav>
                <SideBody key={side} tab={side} />
              </aside>
            </>
          )}
          {!sideOpen && (
            <button className="side-reveal" title={tr('sessionView.showSideTitle')} aria-label={tr('sessionView.showSide')} onClick={() => setSideOpen(true)}>
              <Icon name="layout-sidebar-right" />
              {Object.values(count).some((c) => c?.urgent) && <span className="side-reveal-dot" />}
            </button>
          )}
        </div>
        {/* A plan waits in its own view (so the other views stay usable); everything else asks here. */}
        {asks[0] && <PermissionDialog request={asks[0]} queued={asks.length - 1} />}
      </div>
    </SessionContext.Provider>
  )
}

function SideBody({ tab }: { tab: SideTab }): ReactNode {
  const { s, everyday } = useSession()
  switch (tab) {
    case 'decisions':
      return <DecisionsPanel />
    case 'changes':
    case 'git':
      // The files, then what the review found in them, then the branch's commits.
      return (
        <PanelActionsContext.Provider value="stacked">
          <div className="panel stack">
            <ChangesPanel />
            <ReviewPanel compact />
            {s.git?.isRepo !== false && <GitPanel />}
          </div>
        </PanelActionsContext.Provider>
      )
    case 'ticket':
      return <TicketPanel />
    case 'route':
      // Everything live right now: the task, agents, services and tests.
      return (
        <PanelActionsContext.Provider value="stacked">
          <div className="panel stack">
            <ActivityPanel />
            {Object.keys(s.agents).length > 0 && <AgentsPanel />}
            {!everyday && <ServicesPanel />}
          </div>
        </PanelActionsContext.Provider>
      )
    case 'context':
    case 'heatmap':
      // What Claude has in its context, then the files it gave attention to.
      return (
        <PanelActionsContext.Provider value="stacked">
          <div className="panel stack">
            <ContextPanel />
            <ExplorerPanel />
          </div>
        </PanelActionsContext.Provider>
      )
    case 'safety':
      return <GuardrailsPanel />
    case 'connectors':
      return <ConnectorsPanel />
    case 'skills':
      return <SkillsPanel />
    case 'raw':
      return <RawPanel />
  }
}

const WORK_ICON: Record<WorkTab['kind'], string> = { plan: 'checklist', terminal: 'terminal', erd: 'database', attachments: 'attach', map: 'type-hierarchy', ripple: 'radio-tower', flows: 'arrow-swap', conversation: 'comment-discussion', live: 'pulse', diagrams: 'type-hierarchy-sub', replay: 'history', showcase: 'preview', file: 'file', diff: 'git-compare', commit: 'git-commit', preview: 'globe' }

function workTitle(t: WorkTab): string {
  switch (t.kind) {
    case 'attachments':
      return tr('sessionView.work.attachments')
    case 'erd':
      return tr('sessionView.work.database')
    case 'terminal':
      return tr('sessionView.work.terminal')
    case 'map':
      return tr('sessionView.work.map')
    case 'ripple':
      return tr('sessionView.work.ripple')
    case 'flows':
      return tr('sessionView.work.flow')
    case 'conversation':
      return tr('sessionView.work.conversation')
    case 'live':
      return tr('sessionView.work.live')
    case 'diagrams':
      return tr('sessionView.work.diagrams')
    case 'replay':
      return tr('sessionView.work.replay')
    case 'showcase':
      return tr('sessionView.work.showcase')
    case 'file':
      return baseName(t.path)
    case 'diff':
      return tr('sessionView.work.diffChanges', { name: baseName(t.path) })
    case 'commit':
      return t.title
    case 'preview':
      return tr('sessionView.work.browser')
    case 'plan':
      return tr('sessionView.work.plan')
  }
}

function WorkTabs({
  tabs,
  active,
  unseen,
  onActivate,
  onClose,
  diagramCount,
  claudeBrowsing,
  kept,
  onKeep,
  views,
  onOpenView,
  onFullScreen
}: {
  tabs: WorkTab[]
  active: string
  unseen: Set<string>
  onActivate: (id: string) => void
  onClose: (id: string) => void
  diagramCount: number
  /** Claude is using the Browser right now: its tab says so. */
  claudeBrowsing: boolean
  kept: ViewKind[]
  onKeep: (kind: ViewKind, on: boolean) => void
  views: { kind: ViewKind; label: string; note: string; has: boolean }[]
  onOpenView: (kind: ViewKind) => void
  onFullScreen: () => void
}) {
  const [picking, setPicking] = useState(false)
  const isView = (t: WorkTab): t is WorkTab & { kind: ViewKind } => VIEWS.some((v) => v.kind === t.kind)
  return (
    <div className="work-tabs" role="tablist">
      <div className="work-tab-list">
        {tabs.map((t, i) => (
          <div
            key={t.id}
            data-first-opened={i === FIXED.length ? '' : undefined}
            role="tab"
            aria-selected={t.id === active}
            className={t.id === active ? 'work-tab active' : 'work-tab'}
            onClick={() => onActivate(t.id)}
            onAuxClick={(e) => e.button === 1 && !isFixed(t) && onClose(t.id)}
            title={t.kind === 'file' || t.kind === 'diff' ? t.path : t.kind === 'map' ? tr('sessionView.mapLegend') : undefined}
          >
            <Icon name={WORK_ICON[t.kind]} />
            <span className="ellipsis">{workTitle(t)}</span>
            {t.kind === 'diagrams' && diagramCount > 0 && <span className="count">{diagramCount}</span>}
            {t.kind === 'preview' && claudeBrowsing && (
              <span className="claude-browsing" title={tr('sessionView.claudeBrowsing')} aria-label={tr('sessionView.claudeBrowsing')}>
                <Icon name="sparkle" />
              </span>
            )}
            {unseen.has(t.id) && t.id !== active && <span className="unseen-dot" title={tr('sessionView.unseen')} />}
            {isView(t) && (
              <button
                className={kept.includes(t.kind) ? 'work-tab-keep on' : 'work-tab-keep'}
                title={kept.includes(t.kind) ? tr('sessionView.keptTitle') : tr('sessionView.keepTitle')}
                aria-pressed={kept.includes(t.kind)}
                onClick={(e) => (e.stopPropagation(), onKeep(t.kind, !kept.includes(t.kind)))}
              >
                <Icon name={kept.includes(t.kind) ? 'pinned' : 'pin'} />
              </button>
            )}
            {!isFixed(t) && !(isView(t) && kept.includes(t.kind)) && (
              <button className="work-tab-close" title={tr('sessionView.close')} onClick={(e) => (e.stopPropagation(), onClose(t.id))}>
                <Icon name="close" />
              </button>
            )}
          </div>
        ))}
      </div>
      <span className="spacer" />
      <IconButton icon="screen-full" title={tr('sessionView.fullScreenTitle')} onClick={onFullScreen} />
      {/* Outside the scrolling list, so its menu isn't clipped. */}
      <div className="work-tab-add">
          <IconButton icon="add" title={tr('sessionView.openView')} onClick={() => setPicking((p) => !p)} active={picking} />
          {picking && (
            <>
              <div className="menu-scrim" onMouseDown={() => setPicking(false)} />
              <div className="menu view-picker" role="menu">
                {views.map((v) => {
                  const open = tabs.some((t) => t.kind === v.kind)
                  return (
                    <button
                      key={v.kind}
                      role="menuitem"
                      // Every view opens, even with nothing in it yet: its empty state is where you start it
                      // (ask for a diagram, trace a flow, build the showcase).
                      className={open ? 'menu-item current' : v.has ? 'menu-item' : 'menu-item quiet'}
                      onClick={() => (setPicking(false), onOpenView(v.kind))}
                    >
                      <Icon name={WORK_ICON[v.kind]} />
                      <span className="view-picker-text">
                        <span className="view-picker-label">
                          {v.label}
                          {open && <span className="view-picker-state">{tr('sessionView.viewOpen')}</span>}
                          {!v.has && <span className="view-picker-state">{tr('sessionView.viewNothingYet')}</span>}
                        </span>
                        <span className="view-picker-note">{v.note}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </>
          )}
      </div>
    </div>
  )
}


/**
 * Another live session works in this same folder: say so (their changes mix, a branch switch moves
 * both) and, before the first message, offer this one its own copy of the repo.
 */
function SharedFolderBanner() {
  const { tab, s, peers, actions } = useSession()
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const root = s.git?.root?.replace(/\\/g, '/').toLowerCase()
  const others = root ? peers.filter((p) => p.tab.id !== tab.id && p.s.status !== 'stopped' && p.s.git?.root?.replace(/\\/g, '/').toLowerCase() === root) : []
  const [name, setName] = useState('')
  useEffect(() => setName(`${s.git?.branch && !/^(main|master|develop)$/.test(s.git.branch) ? `${s.git.branch}-2` : `session-${Date.now().toString(36).slice(-5)}`}`), [s.git?.branch])
  if (!others.length || hidden) return null
  const fresh = !s.timeline.some((i) => i.kind === 'user')
  return (
    <div className="shared-banner" role="status">
      <Icon name="warning" className="warn" />
      <div className="grow">
        <strong>{tr('sessionView.sharesFolder', { names: others.map((o) => tr('sessionView.quotedName', { name: tabTitle(o.tab, o.s) })).join(', ') })}</strong>{' '}
        <span className="muted">
          {tr('sessionView.sharedNote')}
        </span>
        {error && <div className="err small">{error}</div>}
      </div>
      {fresh && (
        <span className="shared-move">
          <input className="mono" value={name} onChange={(e) => setName(e.target.value)} aria-label={tr('sessionView.branchForCopy')} />
          <button
            className="btn primary"
            disabled={busy || !name.trim()}
            onClick={async () => {
              setBusy(true)
              setError(null)
              try {
                await window.glassbox.git.fetchDefault(tab.cwd).catch(() => {})
                const dir = await window.glassbox.git.worktree(tab.cwd, name.trim())
                actions.retarget(tab.id, dir)
              } catch (e) {
                setError(String(e).replace(/^Error:\s*(Error invoking remote method '[^']+':\s*)?(Error:\s*)?/, ''))
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? tr('sessionView.makingCopy') : tr('sessionView.giveOwnCopy')}
          </button>
        </span>
      )}
      <IconButton icon="close" title={tr('sessionView.hide')} onClick={() => setHidden(true)} />
    </div>
  )
}
