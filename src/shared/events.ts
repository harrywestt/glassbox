import type {
  AccountInfo,
  HookInput,
  McpServerStatus,
  ModelInfo,
  SDKControlGetContextUsageResponse,
  SDKMessage,
  SDKSessionInfo,
  SessionMessage,
  SlashCommand
} from '@anthropic-ai/claude-agent-sdk'

export type { McpServerStatus, SlashCommand, SDKSessionInfo }
export type ContextUsage = SDKControlGetContextUsageResponse

export type TaskStep = { label: string; status: 'pending' | 'active' | 'done'; files?: string[] }

/** One call or response in a show_flow sequence; from/to are lane names. */
export type FlowHop = { from: string; to: string; label: string; kind?: 'new' | 'changed' | 'removed' }

/** Pushed by Claude through the in-process Glassbox MCP server. */
export type GlassboxSignal =
  | { type: 'diagram'; id: string; title: string; mermaid: string }
  | { type: 'flow'; id: string; title: string; lanes: string[]; before?: FlowHop[]; after: FlowHop[] }
  | { type: 'task'; summary: string; steps?: TaskStep[] }
  | { type: 'pin'; path: string; reason?: string }
  | { type: 'showcase'; path: string; title: string; artifactUrl?: string }
  /** Claude putting something in front of the user: a file, a diff, part of the map, a view. */
  | { type: 'open'; target: OpenTarget; why?: string }
  /** A loader above the message box (show_progress), or an update to one. */
  | { type: 'loader'; loader: LoaderState }

/** One loader: what it's for, how far along (percent, or unknown), and a line of detail. */
export type LoaderState = { id: string; label: string; status: 'running' | 'done' | 'failed'; percent?: number; /** Step under way, of `steps`, for work with distinct parts. */ step?: number; steps?: number; detail?: string; started: number; updated: number }

export type OpenTarget =
  | { view: 'file'; path: string; line?: number; endLine?: number }
  | { view: 'diff'; path: string }
  | { view: 'map'; paths: string[] }
  | { view: 'ripple'; path: string }
  | { view: 'preview'; url: string }
  | { view: 'erd'; entities?: string[]; query?: string }
  | { view: 'tab'; tab: 'conversation' | 'plan' | 'map' | 'database' | 'diagrams' | 'flows' | 'live' | 'ripple' | 'terminal' | 'browser' | 'attachments' | 'showcase' | 'replay' }

export type HostStatus = 'starting' | 'ready' | 'running' | 'stopped'

export type GitInfo = {
  isRepo: boolean
  root?: string
  branch?: string
  head?: string
  /** Files git shows as uncommitted (including untracked ones). */
  dirty?: number
  /** Files changed on this branch, as the Changes panel counts them by default: the working tree
   *  against the default branch where this branch left it, untracked files left out. */
  changed?: number
  /** The branch that's compared against (e.g. origin/main). */
  base?: string
  upstream?: string
  ahead?: number
  behind?: number
}

/**
 * read / edit: must-read and must-edit files. The rest are boundaries you set (usually on a module
 * from the map): avoid blocks edits, ask asks you before each edit, api lets other modules use
 * only its public entry point.
 */
export type FileMark = 'read' | 'edit' | 'avoid' | 'ask' | 'api'

/** What the user has told Glassbox this session must use; injected into every prompt by a hook. */
export type Requirements = {
  connectors: string[]
  skills: string[]
  files: { path: string; mark: FileMark }[]
}

export const emptyRequirements: Requirements = { connectors: [], skills: [], files: [] }

/** Everything a session host streams to the renderer. */
/** One of Claude's AskUserQuestion questions. */
export type UserQuestion = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }

export type SessionEvent =
  | { kind: 'sdk'; msg: SDKMessage }
  /** `timestamp` (ms) comes from the transcript on disk, so resumed activity keeps its real times. */
  | { kind: 'history'; messages: (SessionMessage & { timestamp?: number })[] }
  | { kind: 'hook'; input: HookInput }
  | { kind: 'permission'; id: string; toolName: string; input: Record<string, unknown>; canAlwaysAllow: boolean; guard?: string }
  /** Claude asked you questions (AskUserQuestion); answered from the box under the conversation. */
  | { kind: 'user-questions'; id: string; questions: UserQuestion[] }
  | { kind: 'user-questions-done'; id: string }
  /** A quick reply to a message you sent while Claude was tied up (waiting on an agent or a long step), from a copy of the conversation. */
  | { kind: 'quick-answer'; uuid: string; status: 'running' | 'done' | 'failed'; text?: string }
  | { kind: 'permission-cancelled'; id: string } // answered, aborted or session closed
  | { kind: 'glassbox'; signal: GlassboxSignal }
  | { kind: 'capabilities'; commands: SlashCommand[]; models: ModelInfo[]; account?: AccountInfo }
  /** The model the session now uses (you picked another). */
  | { kind: 'model'; model: string }
  | { kind: 'mcp'; servers: McpServerStatus[] }
  | { kind: 'context'; usage: ContextUsage }
  | { kind: 'git'; info: GitInfo }
  | { kind: 'status'; status: HostStatus }
  | { kind: 'guard'; hit: GuardHit }
  | { kind: 'side'; task: SideTask }
  | { kind: 'checkin'; checkin: CheckIn }
  | { kind: 'checkin-resolved'; id: string; answer: string }
  | { kind: 'reviewer'; findings: Finding[]; reviewed: string[] }
  | { kind: 'commits'; commits: GlassboxCommit[]; skipped?: string; error?: string }
  | { kind: 'service-error'; service: string; text: string; at: number }
  /** Files a shell command changed (Claude editing through a script rather than the Edit tool). */
  | { kind: 'shell-edits'; toolId: string; files: string[]; agentId: string | null; at?: number }
  /** On resume: what the transcript doesn't hold (files shell commands changed, the running cost). */
  | { kind: 'restore'; costUsd: number; shellEdits: { toolId: string; files: string[]; agentId: string | null; at: number }[] }
  | { kind: 'autocommit'; enabled: boolean }
  | { kind: 'reviewer-state'; busy: boolean; pending: number; error?: string }
  /** `id`: an alert about one ongoing thing ("stuck"): a newer one replaces it, and alert-clear takes it away. */
  | { kind: 'alert'; level: 'info' | 'warn' | 'error'; text: string; id?: string }
  | { kind: 'alert-clear'; id: string }
  | { kind: 'mode'; mode: string; base: string }
  | { kind: 'error'; message: string }
  | { kind: 'stderr'; text: string }
  /** A command you ran yourself with "! command": output as it arrives, then how it exited. */
  | { kind: 'bang'; id: string; data?: string; exit?: number | null; error?: string }

export type TabEvent = { tabId: string; event: SessionEvent }

/** `shell`: allow this and every later shell command in the session (guardrails still apply). */
export type PermissionDecision = 'allow' | 'always' | 'deny' | 'shell'

/** How much Claude may do without asking. Guardrails apply in every mode. */
export type AccessMode = 'default' | 'acceptEdits' | 'bypassPermissions'

export type DiffMode = 'merge-base' | 'direct'
export type DiffFile = { path: string; status: string; oldPath?: string; additions?: number; deletions?: number }
export type DiffResult = { base: string; files: DiffFile[] }

export type RateLimitWindow = { key: string; label: string; utilization: number; resetsAt: string | null }

export type LocalUsageDay = { date: string; input: number; output: number; cacheRead: number; cacheWrite: number; requests: number }

export type UsageSnapshot = {
  fetchedAt: number
  account?: AccountInfo
  subscriptionType: string | null
  rateLimits: RateLimitWindow[]
  extraUsage?: { monthlyLimit: number | null; usedCredits: number | null; utilization: number | null; currency?: string | null }
  todayRequests?: number
  todaySessions?: number
  error?: string
  days: LocalUsageDay[]
  models: { model: string; tokens: number; requests: number }[]
  projects: { cwd: string; tokens: number; sessions: number }[]
}

export type FileEntry = { path: string; isDir: boolean }

export type ServiceConfig = {
  name: string
  command: string
  /** The port it normally uses. Each session gets its own: this one if free, else the next free one. Use ${port} (and ${port:other}) in command, env and url. */
  port?: number
  cwd?: string
  env?: Record<string, string>
  url?: string
  readyPattern?: string
  dependsOn?: string[]
  autostart?: boolean
}

export type ServiceStatus = 'stopped' | 'waiting' | 'starting' | 'running' | 'stopping' | 'crashed'

/** `port` is the port this session's copy was given (it can differ from config.port when that one was taken). */
export type ServiceState = { name: string; status: ServiceStatus; config: ServiceConfig; pid?: number; startedAt?: number; exitCode?: number; port?: number; waitingFor?: string[] }

export type ServicesSnapshot = { scope: string; cwd: string; configPath: string; exists: boolean; error?: string; services: ServiceState[] }

export type ServicesEvent =
  | { kind: 'state'; snapshot: ServicesSnapshot }
  | { kind: 'log'; scope: string; cwd: string; name: string; lines: string[] }
  /** A service logged an error: the error line and the few lines after it (usually the stack). */
  | { kind: 'error'; scope: string; name: string; text: string; at: number }

export type DecisionKind = 'decision' | 'assumption' | 'question'
export type Decision = { kind: DecisionKind; title: string; detail?: string; alternatives?: string[]; files?: string[] }

export type GuardAction = 'block' | 'ask' | 'off'
export type GuardScope = 'shell' | 'edit' | 'mcp'
export type GuardRule = { id: string; label: string; scope: GuardScope; pattern: string; action: GuardAction; builtin?: boolean; /** Told to Claude when the rule blocks: what to do instead. */ hint?: string }

/** A guardrail that fired on a tool call before it ran. */
export type GuardHit = { toolUseId: string; toolName: string; ruleId: string; label: string; action: 'block' | 'ask'; detail: string; at: number }

export type SendOptions = { uuid: string; priority?: 'now' | 'next'; plan?: boolean }

export type RewindResult = { canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number }

export type CriterionStatus = 'todo' | 'in-progress' | 'done' | 'tested'
export type AcceptanceCriterion = { id: string; text: string; status: CriterionStatus; evidence?: string }

export type FindingSeverity = 'blocker' | 'major' | 'minor' | 'nit' | 'question'
/** A commit Glassbox made of Claude's changes. */
export type GlassboxCommit = { sha: string; message: string; files: string[]; at: number }

/** Model used for an on-demand review of Claude's edits. */
export type ReviewModel = 'haiku' | 'sonnet' | 'opus'

/** An issue raised about the code: by Claude in a review session, or by the background reviewer. */
export type Finding = { id: string; source: 'claude' | 'reviewer'; severity: FindingSeverity; title: string; detail?: string; file?: string; line?: number; suggestion?: string; at: number }

export type CheckIn = { id: string; confidence: 'low' | 'medium'; about: string; reason: string; options?: string[]; at: number }

/** A background Claude run started from a side panel, so it doesn't interrupt the main session. */
export type SideTaskSpec = {
  kind: 'diagram' | 'showcase' | 'services' | 'checks' | 'review' | 'status'
  title: string
  prompt: string
  /** Built-in tools it may use. MCP connectors are always available (guardrails still apply). */
  tools: string[]
}

export type SideTask = {
  id: string
  kind: SideTaskSpec['kind']
  title: string
  status: 'running' | 'done' | 'failed' | 'stopped'
  startedAt: number
  endedAt?: number
  toolCalls: number
  activity?: string
  result?: string
  costUsd?: number
  /** What it has done so far, newest last: tool calls and short notes from its replies. */
  steps?: SideStep[]
}

export type SideStep = { at: number; tool?: string; input?: Record<string, unknown>; text?: string }

/** A Jira ticket as shown in the Ticket panel, read through Claude's Atlassian connector. */
export type Ticket = {
  key: string
  url?: string
  summary: string
  status: string
  statusCategory?: 'todo' | 'inprogress' | 'done'
  type?: string
  priority?: string
  assignee?: string
  reporter?: string
  /** ISO timestamp. */
  updated?: string
  /** Markdown. */
  description: string
  comments: TicketComment[]
}
export type TicketComment = { id?: string; author: string; /** ISO timestamp. */ created: string; /** Markdown. */ body: string }
export type TicketTransition = { id: string; name: string; /** Status the transition moves to. */ to?: string }

/** `stale`: a saved copy, shown at once while a fresh one loads (ask again shortly for it). */
export type TicketResult = { ticket: Ticket; error?: undefined; stale?: boolean } | { ticket?: undefined; error: string }
export type TicketTransitionsResult = { transitions: TicketTransition[]; error?: undefined } | { transitions?: undefined; error: string }
export type TicketActionResult = { ok: true; error?: undefined } | { ok?: false; error: string }

/** Something Glassbox needs you signed in to: Claude, the GitHub CLI, or a claude.ai connector. */
export type AccountItem = { id: string; name: string; kind: 'claude' | 'github' | 'connector'; status: 'ok' | 'signin' | 'missing' | 'error'; detail?: string }
export type AccountsResult = { items: AccountItem[]; at: number }

/** The morning stand-up: the last working day, grouped by Jira epic. */
export type StandupItem = { text: string; ticket?: { key: string; summary?: string; status?: string; url?: string }; repo: string }
export type StandupGroup = { epic: string; epicKey?: string; url?: string; items: StandupItem[] }
export type Standup = { from: string; to: string; label: string; groups: StandupGroup[]; sessions: number; commits: number; jiraError?: string; /** 'repo' when Jira couldn't be reached, so there were no epics to group by. */ groupedBy?: 'epic' | 'repo'; error?: string; generatedAt: number }

/** The shape of a plan, drawn on the map before any code is written (show_plan_on_map). */
export type PlannedModule = { path: string; change: 'change' | 'new'; why?: string }
export type PlannedConnection = { from: string; to: string; change: 'new' | 'removed'; why?: string; http?: boolean }
export type PlanMap = { modules: PlannedModule[]; connections: PlannedConnection[]; at: number }

/** One connection between modules that the working tree adds or removes compared with the base. */
export type ArchDiffEdge = { from: string; to: string; http?: boolean; files: string[]; names: string[] }
/** A new import that reaches past a module's public entry point, when that module is marked api-only. */
export type ArchBreach = { module: string; from: string; to: string }
export type ArchDiff = { added: ArchDiffEdge[]; removed: ArchDiffEdge[]; breaches: ArchBreach[]; error?: string }

/** A decision or assumption from an earlier session, kept for the project so later sessions build on it. */
export type ProjectDecision = { id: string; kind: 'decision' | 'assumption'; title: string; detail?: string; files?: string[]; at: number; sid?: string; session?: string }

/** Why each of a map module's connections exists, keyed "out:<module>" / "in:<module>". */
export type ModuleExplain = { why: Record<string, string>; error?: string }

/** A newer Glassbox: downloading (Windows), ready to restart into (Windows), or out to download (Mac). */
export type UpdateState = { status: 'idle' } | { status: 'downloading'; version: string; percent: number } | { status: 'ready'; version: string } | { status: 'available'; version: string }
