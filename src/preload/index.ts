import type { HeatModule, MapGroups } from '../main/mapGroups'
import { contextBridge, ipcRenderer, webFrame, webUtils, type IpcRendererEvent } from 'electron'
import type { AccountsResult, ArchDiff, ModuleExplain, ProjectDecision, Standup,
  DiffMode,
  AccessMode,
  DiffResult,
  SideTaskSpec,
  GuardRule,
  RewindResult,
  SendOptions,
  PermissionDecision,
  Requirements,
  SDKSessionInfo,
  ServicesEvent,
  ServicesSnapshot,
  TabEvent,
  UsageSnapshot,
  ReviewModel,
  TicketActionResult,
  TicketResult,
  TicketTransitionsResult,
  UpdateState
} from '../shared/events'
import type { GitHubSummary } from '../shared/github'
import type { BranchPr, LaunchPr } from '../main/launcher'
import type { BlastRadiusResult } from '../main/deps'
import type { Architecture } from '../shared/architecture'
import type { Erd, ErdFocus } from '../shared/erd'
import type { FxRates } from '../main/fx'
import type { BranchList, CommitEntry } from '../main/git'

type ShowcaseRequest = { name: string; base: string | null; notes: string; previousArtifactUrl?: string; linkIt?: boolean }

const invoke = ipcRenderer.invoke.bind(ipcRenderer)

const api = {
  session: {
    open: (tabId: string, cwd: string, resume?: string, access?: AccessMode): Promise<void> => invoke('session:open', tabId, cwd, resume, access),
    send: (tabId: string, text: string, opts: SendOptions): Promise<void> => invoke('session:send', tabId, text, opts),
    /** Run a shell command yourself ("! command"); output arrives as 'bang' events for that session. */
    runShell: (tabId: string, id: string, cwd: string, command: string): Promise<void> => invoke('bang:run', tabId, id, cwd, command),
    stopShell: (id: string): Promise<void> => invoke('bang:stop', id),
    rewind: (tabId: string, userMessageId: string, dryRun: boolean): Promise<RewindResult> => invoke('session:rewind', tabId, userMessageId, dryRun),
    setGuardrails: (tabId: string, rules: GuardRule[]): Promise<void> => invoke('session:guardrails', tabId, rules),
    respondCheckin: (tabId: string, id: string, answer: string): Promise<void> => invoke('session:checkin', tabId, id, answer),
    review: (tabId: string, model: ReviewModel): Promise<void> => invoke('session:review', tabId, model),
    setAutoCommit: (tabId: string, on: boolean): Promise<void> => invoke('session:autoCommit', tabId, on),
    commitNow: (tabId: string): Promise<void> => invoke('session:commitNow', tabId),
    interrupt: (tabId: string): Promise<void> => invoke('session:interrupt', tabId),
    stopTask: (tabId: string, taskId: string): Promise<void> => invoke('session:stopTask', tabId, taskId),
    setMode: (tabId: string, mode: AccessMode): Promise<void> => invoke('session:setMode', tabId, mode),
    exitPlan: (tabId: string): Promise<void> => invoke('session:exitPlan', tabId),
    side: (tabId: string, spec: SideTaskSpec): Promise<string> => invoke('session:side', tabId, spec),
    stopSide: (tabId: string, id: string): Promise<void> => invoke('session:stopSide', tabId, id),
    sideShowcase: (tabId: string, req: ShowcaseRequest, context: string): Promise<string> => invoke('session:sideShowcase', tabId, req, context),
    close: (tabId: string): Promise<void> => invoke('session:close', tabId),
    respondPermission: (tabId: string, id: string, decision: PermissionDecision, message?: string): Promise<void> =>
      invoke('session:permission', tabId, id, decision, message),
    refresh: (tabId: string): Promise<void> => invoke('session:refresh', tabId),
    /** Answers to Claude's questions (keyed by question text), or null to close them unanswered. */
    answerQuestions: (tabId: string, id: string, answers: Record<string, string> | null): Promise<void> => invoke('session:answerQuestions', tabId, id, answers),
    toggleMcp: (tabId: string, name: string, enabled: boolean): Promise<void> => invoke('session:toggleMcp', tabId, name, enabled),
    setRequirements: (tabId: string, req: Requirements): Promise<void> => invoke('session:requirements', tabId, req),
    showcase: (tabId: string, req: ShowcaseRequest, opts: SendOptions): Promise<void> => invoke('session:showcase', tabId, req, opts)
  },
  history: {
    list: (): Promise<(SDKSessionInfo & { pinned?: boolean })[]> => invoke('history:list'),
    /** Keep a session for good: backed up so Claude Code's clean-up can't remove it. */
    pin: (info: SDKSessionInfo): Promise<{ ok: boolean; error?: string }> => invoke('history:pin', info),
    unpin: (id: string): Promise<void> => invoke('history:unpin', id),
    pinnedIds: (): Promise<string[]> => invoke('history:pinnedIds')
  },
  usage: {
    get: (): Promise<UsageSnapshot> => invoke('usage:get'),
    limits: (): Promise<UsageSnapshot> => invoke('usage:limits'),
    local: (): Promise<Pick<UsageSnapshot, 'days' | 'models' | 'projects'>> => invoke('usage:local')
  },
  fx: {
    rates: (): Promise<FxRates | null> => invoke('fx:rates')
  },
  github: {
    summary: (dirs: string[], force?: boolean): Promise<GitHubSummary> => invoke('github:summary', dirs, force)
  },
  fs: {
    list: (cwd: string): Promise<string[]> => invoke('fs:list', cwd),
    read: (cwd: string, path: string): Promise<{ path: string; content?: string; error?: string }> => invoke('fs:read', cwd, path)
  },
  git: {
    branches: (cwd: string): Promise<{ branches: string[]; defaultBase: string | null }> => invoke('git:branches', cwd),
    /** The pull request for the current branch (via the GitHub CLI). */
    branchPr: (cwd: string): Promise<{ pr?: BranchPr; none?: boolean; error?: string }> => invoke('git:branchPr', cwd),
    branchList: (cwd: string): Promise<BranchList> => invoke('git:branchList', cwd),
    log: (cwd: string, base: string | null): Promise<{ commits: CommitEntry[]; uncommitted: number }> => invoke('git:log', cwd, base),
    commitFiles: (cwd: string, sha: string): Promise<{ status: string; path: string }[]> => invoke('git:commitFiles', cwd, sha),
    showFile: (cwd: string, ref: string, path: string): Promise<string> => invoke('git:showFile', cwd, ref, path),
    glassboxCommits: (): Promise<Record<string, { at: number }>> => invoke('git:glassboxCommits'),
    undoCommit: (cwd: string, sha: string): Promise<void> => invoke('git:undoCommit', cwd, sha),
    switchBranch: (cwd: string, branch: string, create?: boolean): Promise<void> => invoke('git:switch', cwd, branch, create),
    diff: (cwd: string, ref: string, mode: DiffMode): Promise<DiffResult> => invoke('git:diff', cwd, ref, mode),
    fileAt: (cwd: string, ref: string, mode: DiffMode, path: string): Promise<string> => invoke('git:fileAt', cwd, ref, mode, path),
    /** A separate working copy of the repo on `branch` (created if new); returns its folder. */
    worktree: (cwd: string, branch: string): Promise<string> => invoke('git:worktree', cwd, branch),
    /** Update the default branch (only it) before a copy branches from it; never throws. */
    fetchDefault: (cwd: string): Promise<void> => invoke('git:fetchDefault', cwd),
    /** How many other live sessions work in this same repo folder. */
    peers: (cwd: string, except?: string): Promise<number> => invoke('session:peers', cwd, except)
  },
  services: {
    get: (scope: string, cwd: string): Promise<ServicesSnapshot> => invoke('services:get', scope, cwd),
    logs: (scope: string, cwd: string, name: string): Promise<string[]> => invoke('services:logs', scope, cwd, name),
    startAll: (scope: string, cwd: string): Promise<void> => invoke('services:startAll', scope, cwd),
    stopAll: (scope: string, cwd: string): Promise<void> => invoke('services:stopAll', scope, cwd),
    start: (scope: string, cwd: string, name: string): Promise<void> => invoke('services:start', scope, cwd, name),
    stop: (scope: string, cwd: string, name: string): Promise<void> => invoke('services:stop', scope, cwd, name),
    restart: (scope: string, cwd: string, name: string): Promise<void> => invoke('services:restart', scope, cwd, name),
    onEvent(callback: (e: ServicesEvent) => void) {
      const listener = (_e: IpcRendererEvent, e: ServicesEvent) => callback(e)
      ipcRenderer.on('glassbox:services', listener)
      return () => void ipcRenderer.off('glassbox:services', listener)
    }
  },
  admin: {
    get: (): Promise<{ supported: boolean; elevated: boolean; runAsAdmin: boolean; asked: boolean; adminAccount: boolean }> => invoke('admin:get'),
    set: (on: boolean): Promise<boolean> => invoke('admin:set', on),
    dismiss: (): Promise<void> => invoke('admin:dismiss')
  },
  undoEdit: (cwd: string, tool: string, input: Record<string, unknown>, createdFile: boolean): Promise<{ deleted?: boolean }> => invoke('edit:undo', cwd, tool, input, createdFile),
  radar: (deps: { name: string; version: string; ecosystem: string }[]): Promise<{ name: string; version: string; ecosystem: string; license?: string; vulns: { id: string; summary?: string }[]; error?: string }[]> => invoke('radar:deps', deps),
  ticket: {
    get: (cwd: string, key: string, force?: boolean): Promise<TicketResult> => invoke('ticket:get', cwd, key, force),
    transitions: (cwd: string, key: string): Promise<TicketTransitionsResult> => invoke('ticket:transitions', cwd, key),
    transition: (cwd: string, key: string, id: string): Promise<TicketActionResult> => invoke('ticket:transition', cwd, key, id),
    comment: (cwd: string, key: string, body: string): Promise<TicketActionResult> => invoke('ticket:comment', cwd, key, body)
  },
  handoff: (cwd: string, brief: string): Promise<{ text: string; prUrl?: string; prTitle?: string; error?: string }> => invoke('share:handoff', cwd, brief),
  update: {
    state: (): Promise<UpdateState> => invoke('update:state'),
    install: (): Promise<void> => invoke('update:install'),
    onChange(callback: (s: UpdateState) => void) {
      const listener = (_e: IpcRendererEvent, s: UpdateState) => callback(s)
      ipcRenderer.on('glassbox:update', listener)
      return () => void ipcRenderer.off('glassbox:update', listener)
    }
  },
  voice: {
    prepare: (): Promise<void> => invoke('voice:prepare'),
    transcribe: (audio: Float32Array): Promise<string> => invoke('voice:transcribe', audio),
    onProgress(callback: (p: { status: 'downloading' | 'loading' | 'ready'; progress?: number }) => void) {
      const listener = (_e: IpcRendererEvent, p: { status: 'downloading' | 'loading' | 'ready'; progress?: number }) => callback(p)
      ipcRenderer.on('glassbox:voice', listener)
      return () => void ipcRenderer.off('glassbox:voice', listener)
    }
  },
  deps: {
    find: (cwd: string, files: string[]): Promise<BlastRadiusResult> => invoke('deps:find', cwd, files)
  },
  architecture: {
    get: (cwd: string, force?: boolean): Promise<Architecture> => invoke('architecture:get', cwd, force),
    /** Why each of a module's connections exists (Haiku, in the background; cached until the code changes). */
    explain: (cwd: string, id: string): Promise<ModuleExplain> => invoke('architecture:explain', cwd, id),
    /** Group this session's modules (from its heatmap) the way an engineer would want to see the work. */
    group: (root: string, mods: HeatModule[], force?: boolean): Promise<MapGroups> => invoke('architecture:group', root, mods, force),
    /** Connections between modules the working tree adds or removes against a base; apiOnly flags imports past an api-only module's entry. */
    diff: (cwd: string, ref: string, mode: DiffMode, apiOnly?: string[]): Promise<ArchDiff> => invoke('architecture:diff', cwd, ref, mode, apiOnly),
    /** A project's map was redrawn in the background (new session, or Claude named its categories). */
    onChanged(callback: (root: string) => void) {
      const listener = (_e: IpcRendererEvent, root: string) => callback(root)
      ipcRenderer.on('glassbox:architecture', listener)
      return () => void ipcRenderer.off('glassbox:architecture', listener)
    }
  },
  accounts: {
    get: (force?: boolean): Promise<AccountsResult> => invoke('accounts:get', force),
    signIn: (id: string): Promise<void> => invoke('accounts:signIn', id)
  },
  standup: (force?: boolean): Promise<Standup> => invoke('standup:get', force),
  /** The database schema, read from the code, and Claude's pick of the tables an area uses. */
  erd: {
    get: (cwd: string): Promise<Erd> => invoke('erd:get', cwd),
    focus: (cwd: string, question: string): Promise<ErdFocus> => invoke('erd:focus', cwd, question)
  },
  /** Claude's browser tools asking the window to open a tab or list them; the window answers with reply. */
  browser: {
    onRequest(callback: (req: { reqId: string; tabId: string; cmd: { cmd: string; url?: string; newTab?: boolean } }) => void) {
      const listener = (_e: IpcRendererEvent, req: { reqId: string; tabId: string; cmd: { cmd: string; url?: string; newTab?: boolean } }) => callback(req)
      ipcRenderer.on('glassbox:browser-request', listener)
      return () => void ipcRenderer.off('glassbox:browser-request', listener)
    },
    reply: (reqId: string, result: unknown, error?: string) => ipcRenderer.send('browser:reply', reqId, result, error)
  },
  /** Your own shells, in a session's folder. */
  terminal: {
    open: (scope: string, cwd: string, cols: number, rows: number): Promise<string> => invoke('terminal:open', scope, cwd, cols, rows),
    write: (id: string, data: string) => ipcRenderer.send('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.send('terminal:resize', id, cols, rows),
    close: (id: string): Promise<void> => invoke('terminal:close', id),
    /** Output and exits from every terminal; filter by id. */
    onData(callback: (e: { id: string; data?: string; exit?: number }) => void) {
      const listener = (_e: IpcRendererEvent, payload: { id: string; data?: string; exit?: number }) => callback(payload)
      ipcRenderer.on('glassbox:terminal', listener)
      return () => void ipcRenderer.off('glassbox:terminal', listener)
    }
  },
  /** Decisions kept for a project across sessions. */
  decisions: {
    list: (cwd: string): Promise<ProjectDecision[]> => invoke('decisions:list', cwd),
    forget: (cwd: string, id: string): Promise<ProjectDecision[]> => invoke('decisions:forget', cwd, id)
  },
  watch: {
    share: (tabId: string, title: string, cwd: string): Promise<{ url: string; lanUrl: string | null }> => invoke('watch:share', tabId, title, cwd),
    unshare: (tabId: string): Promise<void> => invoke('watch:unshare', tabId)
  },
  launch: {
    prs: (cwd: string): Promise<{ prs: LaunchPr[]; error?: string }> => invoke('launch:prs', cwd),
    worktree: (cwd: string, pr: number): Promise<string> => invoke('launch:worktree', cwd, pr),
    pr: (cwd: string, ref: string): Promise<{ pr?: LaunchPr & { repo: string; state: string }; sameRepo?: boolean; error?: string }> => invoke('launch:pr', cwd, ref)
  },
  pickFolder: (): Promise<string | null> => invoke('dialog:pickFolder'),
  openPath: (path: string): Promise<string> => invoke('shell:openPath', path),
  showInFolder: (path: string): Promise<void> => invoke('shell:showItem', path),
  stat: (path: string): Promise<{ exists: boolean; size?: number; modified?: number; dir?: boolean }> => invoke('fs:stat', path),
  /** The full output of a command whose result Claude only got a preview of. */
  toolOutput: (path: string): Promise<{ text?: string; size?: number; error?: string }> => invoke('tool:fullOutput', path),
  attachments: {
    pick: (): Promise<string[]> => invoke('attachments:pick'),
    /** Save pasted or dropped data that has no file on disk yet; returns where it was saved. */
    save: (name: string, data: ArrayBuffer): Promise<string> => invoke('attachments:save', name, data),
    /** Where a dropped or picked File lives on disk ('' when it isn't a file on disk). */
    pathFor: (file: File): string => webUtils.getPathForFile(file)
  },
  openExternal: (url: string): Promise<void> => invoke('shell:openExternal', url),
  setTitleBar: (color: string, symbolColor: string): Promise<void> => invoke('window:titleBar', color, symbolColor),
  setZoom: (factor: number): void => webFrame.setZoomFactor(factor),
  setNotifications: (on: boolean): Promise<void> => invoke('settings:notifications', on),
  platform: process.platform,
  defaultCwd: process.cwd(),
  onFocusTab(callback: (tabId: string) => void) {
    const listener = (_e: IpcRendererEvent, tabId: string) => callback(tabId)
    ipcRenderer.on('glassbox:focusTab', listener)
    return () => void ipcRenderer.off('glassbox:focusTab', listener)
  },
  onEvent(callback: (payload: TabEvent) => void) {
    const listener = (_e: IpcRendererEvent, payload: TabEvent) => callback(payload)
    ipcRenderer.on('glassbox:event', listener)
    return () => void ipcRenderer.off('glassbox:event', listener)
  }
}

contextBridge.exposeInMainWorld('glassbox', api)

export type GlassboxApi = typeof api
