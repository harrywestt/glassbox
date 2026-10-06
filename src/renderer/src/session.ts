import { useMemo } from 'react'
import type { SDKMessage, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk'
import { type UserQuestion,
  emptyRequirements,
  type AcceptanceCriterion,
  type CheckIn,
  type Finding,
  type ContextUsage,
  type Decision,
  type GitInfo,
  type GuardHit,
  type HostStatus,
  type McpServerStatus,
  type Requirements,
  type SessionEvent,
  type SideTask,
  type SlashCommand,
  type TaskStep,
  type GlassboxCommit,
  type FlowHop,
  type OpenTarget,
  type PlanMap,
  type LoaderState
} from '../../shared/events'
import { tr } from '../../shared/i18n'

export type SessionStatus = HostStatus | 'new'

export type ToolCall = {
  id: string
  name: string
  input: Record<string, unknown>
  agentId: string | null
  status: 'running' | 'done' | 'error'
  result?: string
  at: number
  endedAt?: number
  turn: number
}

export type AgentNode = {
  id: string
  type: string
  description: string
  prompt: string
  parentId: string | null
  status: 'running' | 'done' | 'error'
  toolCalls: number
  result?: string
  at: number
  /** Running in the background: its tool call returned at once, and it reports progress and its end separately. */
  background?: boolean
  /** When it finished (done or failed). */
  endedAt?: number
  /** The SDK's id for it as a task, and its latest one-line progress. */
  taskId?: string
  progress?: string
  /** You stopped it (rather than it failing). */
  stopped?: boolean
}

/** What a review comment points at. */
export type CommentTarget =
  | { kind: 'code'; path: string; startLine: number; endLine: number; snippet: string }
  | { kind: 'tool'; toolId: string; label: string }
  | { kind: 'decision'; id: string; title: string }
  /** One message answering several open questions at once. */
  | { kind: 'questions'; ids: string[]; titles: string[] }
  | { kind: 'step'; label: string }
  | { kind: 'message'; excerpt: string }
  | { kind: 'plan' }

/**
 * Work that runs on its own under a tool call that isn't an Agent call (a skill that forks, such as a
 * review): its steps arrive tagged with that call. Give the call an agent node, so it shows like an
 * agent, with its steps and progress live in the conversation, instead of one silent line.
 */
function asAgent(agents: Record<string, AgentNode>, toolCalls: Record<string, ToolCall>, id: string | null | undefined): Record<string, AgentNode> {
  // Always a copy: callers write into the result, and the previous state must stay as it was.
  if (!id || agents[id]) return { ...agents }
  const call = toolCalls[id]
  // Only a skill runs like an agent; other tasks (a background shell command) stay steps.
  if (!call || call.name !== 'Skill') return { ...agents }
  const skill = call.name === 'Skill' ? String(call.input.skill ?? call.input.command ?? '') : ''
  return {
    ...agents,
    [id]: {
      id,
      type: skill ? 'skill' : call.name,
      description: skill ? `/${skill.replace(/^\//, '')}` : String(call.input.description ?? ''),
      prompt: String(call.input.args ?? call.input.prompt ?? ''),
      parentId: call.agentId,
      status: call.status === 'running' ? 'running' : call.status,
      toolCalls: 0,
      at: call.at
    }
  }
}

/** Claude Code wraps an agent's report in a note for Claude ("[Subagent hand-back] … The report follows:"); keep just the report. */
export const withoutHandback = (text: string) => text.replace(/^\s*\[Subagent hand-back\][\s\S]*?The report follows:\s*/i, '')

/**
 * Claude driving the Glassbox Browser: a browser tool running now, or one that finished in the last
 * few seconds while Claude is still at work (so the marker holds steady between its clicks and reads).
 * `tab` is the Browser page it's working in, when the tool named one.
 */
export function claudeInBrowser(s: SessionState): { active: boolean; tab?: string } {
  const BROWSING = /^mcp__glassbox__(browser_|open_preview$|start_app$)/
  let latest: ToolCall | undefined
  for (const c of Object.values(s.toolCalls)) if (BROWSING.test(c.name) && (!latest || c.at > latest.at)) latest = c
  if (!latest) return { active: false }
  const recent = latest.status === 'running' || (s.status === 'running' && Date.now() - (latest.endedAt ?? latest.at) < 8000)
  return recent ? { active: true, tab: typeof latest.input.tab === 'string' ? latest.input.tab : undefined } : { active: false }
}

/** One item on Claude's own to-do list. `toolId` ties a TaskCreate to its result, which carries the task's id. */
export type Todo = { id?: string; toolId?: string; label: string; status: 'pending' | 'active' | 'done'; activeForm?: string }

const todoStatus = (s: unknown): Todo['status'] => (s === 'completed' ? 'done' : s === 'in_progress' ? 'active' : 'pending')

/**
 * The work in hand, for the Tasks section, the map and the dashboard: Claude's own to-do list when it
 * keeps one (it updates that as it goes), with the files and summary from set_current_task where they
 * match; otherwise what set_current_task said.
 */
export function taskOf(s: SessionState, agentId?: string): { summary: string; steps?: TaskStep[] } | undefined {
  // A subagent's list is its own; set_current_task only ever describes Claude's main work.
  if (agentId) {
    const list = s.agentTodos?.[agentId] ?? []
    if (!list.length) return undefined
    const active = list.find((t) => t.status === 'active')
    const done = list.filter((t) => t.status === 'done').length
    return { summary: active?.activeForm || active?.label || (done === list.length ? tr('session.allDone') : tr('session.doneOf', { done, total: list.length })), steps: list.map((t) => ({ label: t.label, status: t.status })) }
  }
  const todos = s.todos ?? []
  if (!todos.length) return s.task
  // Claude keeps two lists: its own to-do list and the steps it gives set_current_task. Show the one
  // it updated last (it often updates one and lets the other go stale), with the files from either.
  if (s.task?.steps?.length && (s.task.at ?? 0) > (s.todosAt ?? 0)) return s.task
  const active = todos.find((t) => t.status === 'active')
  const done = todos.filter((t) => t.status === 'done').length
  return {
    summary: s.task?.summary || active?.activeForm || active?.label || (done === todos.length ? tr('session.allDone') : tr('session.doneOf', { done, total: todos.length })),
    steps: todos.map((t) => ({ label: t.label, status: t.status, files: s.task?.steps?.find((x) => x.label.toLowerCase() === t.label.toLowerCase())?.files }))
  }
}

/** A command you ran yourself with "! command". */
export type Bang = { id: string; command: string; output: string; status: 'running' | 'done' | 'failed'; code?: number | null; at: number; sent?: boolean }
const BANG_KEEP = 200_000

/**
 * What Claude gets from the commands you ran since your last message, in the tags the CLI uses for
 * its own "!" commands. Each output is cut to its last 10,000 characters.
 */
export function bangContext(bangs: Bang[]): string {
  return bangs
    .map((b) => `<bash-input>${b.command}</bash-input>\n<bash-stdout>${b.output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').slice(-10_000).trimEnd()}</bash-stdout>${b.status === 'failed' ? `\n<bash-stderr>Exited with code ${b.code ?? 'unknown'}</bash-stderr>` : ''}`)
    .join('\n\n')
}
/** Your message as you wrote it, without the command output that went along with it. */
export const withoutBangs = (text: string) => text.replace(/<bash-input>[\s\S]*?<\/bash-stdout>(\s*<bash-stderr>[\s\S]*?<\/bash-stderr>)?\s*/g, '').trim()

export type TimelineItem =
  | { kind: 'user'; text: string; at: number; uuid?: string; turn: number }
  | { kind: 'comment'; text: string; target: CommentTarget; at: number; uuid: string }
  | { kind: 'text'; text: string; agentId: string | null; at: number }
  | { kind: 'thinking'; text: string; agentId: string | null; at: number }
  | { kind: 'tool'; toolId: string; agentId: string | null; at: number }
  | { kind: 'decision'; id: string; agentId: string | null; at: number }
  /** A file Claude put in front of you (present_file): shown as a card you open with a click. */
  | { kind: 'present'; id: string; agentId: string | null; at: number }
  | { kind: 'guard'; hit: GuardHit; at: number }
  | { kind: 'finding'; id: string; at: number }
  | { kind: 'checkin'; id: string; at: number }
  | { kind: 'note'; text: string; tone: 'info' | 'warn' | 'error'; at: number }
  /** `stopped`: you stopped it (Stop or Esc), rather than it failing. */
  | { kind: 'result'; costUsd: number; durationMs: number; turns: number; isError: boolean; stopped?: boolean; at: number }
  | { kind: 'commits'; commits: GlassboxCommit[]; skipped?: string; error?: string; at: number }
  /** A running service logged an error; `after` is Claude's most recent edit before it. */
  /** `count`: how many times it logged since your last message (one card, not one each); `lastAt`: the latest. */
  | { kind: 'service-error'; service: string; text: string; at: number; after?: { path: string; at: number }; count?: number; lastAt?: number }
  /** A command you ran yourself ("! command"); its output is in `bangs`. */
  | { kind: 'bang'; id: string; at: number }

/** `dismissed`: a question you closed without answering (Claude wasn't told). */
export type DecisionEntry = Decision & { id: string; agentId: string | null; at: number; challenged?: boolean; reply?: string; dismissed?: boolean }

// Questions you dismissed, by their tool call id (stable across a resume), so they stay closed.
const DISMISSED_KEY = 'glassbox.dismissedQuestions'
function dismissedIds(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}
function rememberDismissed(ids: string[]) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...new Set([...dismissedIds(), ...ids])].slice(-500)))
  } catch {
    /* dismissed for this run only */
  }
}
export type FileTouch = { path: string; tool: string; toolId: string; agentId: string | null; at: number; turn: number }
export type Diagram = { id: string; title: string; mermaid: string; at: number }
export type { FlowHop }
export type Flow = { id: string; title: string; lanes: string[]; before?: FlowHop[]; after: FlowHop[]; at: number }
export type PermissionRequest = Extract<SessionEvent, { kind: 'permission' }>
/** Text or thinking currently streaming in, keyed by thread (main or a subagent's tool_use id). */
export type Draft = { kind: 'text' | 'thinking'; text: string; agentId: string | null }
export type Alert = { level: 'info' | 'warn' | 'error'; text: string; at: number; id?: string }

export interface SessionState {
  status: SessionStatus
  sessionId?: string
  model?: string
  /** The models this account can use, for the model picker. */
  models?: { value: string; resolvedModel?: string; displayName: string; description: string }[]
  mode: string
  /** Access mode you chose (plan mode returns to it). */
  access?: string
  tools: string[]
  permissionMode?: string
  commands: SlashCommand[]
  mcp: McpServerStatus[]
  context?: ContextUsage
  git?: GitInfo
  requirements: Requirements
  timeline: TimelineItem[]
  toolCalls: Record<string, ToolCall>
  agents: Record<string, AgentNode>
  files: FileTouch[]
  pins: { path: string; reason?: string }[]
  diagrams: Record<string, Diagram>
  flows: Record<string, Flow>
  decisions: DecisionEntry[]
  guardHits: GuardHit[]
  criteria?: { source?: string; list: AcceptanceCriterion[]; at: number }
  findings: (Finding & { status: 'open' | 'sent' | 'dismissed' })[]
  checkins: (CheckIn & { answer?: string })[]
  sideTasks: Record<string, SideTask>
  reviewer: { busy: boolean; pending: number; error?: string; reviewedEdits: number }
  /** Commits Glassbox made of Claude's changes this session, and whether it's doing so. */
  commits: GlassboxCommit[]
  autoCommit: boolean
  alerts: Alert[]
  /** `at`: when set_current_task last said this, to weigh it against Claude's to-do list. */
  task?: { summary: string; steps?: TaskStep[]; at?: number }
  /** When Claude's own to-do list last changed. */
  todosAt?: number
  plan?: { text: string; status: 'proposed' | 'approved' | 'changes-requested'; at: number }
  /** The plan's shape on the map (show_plan_on_map): modules it changes or adds, connections it adds or removes. */
  planMap?: PlanMap
  /** How many background agents the SDK says are still working (its level signal). */
  backgroundAgents?: number
  /** Background work still going (agents, commands), from the same signal; `since` is when it was first seen. */
  backgroundTasks?: { id: string; type: string; description: string; since: number }[]
  /** Loaders Claude shows above the message box (show_progress), by id. */
  loaders?: Record<string, LoaderState>
  /** Commands you ran yourself ("! command"), by id. `sent`: already passed to Claude with a message. */
  bangs?: Record<string, Bang>
  /** Files Claude presented to you (present_file), oldest first. */
  presented?: { id: string; path: string; title?: string; why?: string; at: number }[]
  drafts: Record<string, Draft>
  showcase?: { path: string; title: string; artifactUrl?: string; at: number }
  /** The latest thing Claude asked to show the user (n counts up so each request acts once). */
  open?: { n: number; target: OpenTarget; why?: string; at: number }
  /** costBase: the cost before this run of the session (a resume starts the query's own count at 0). */
  usage: { contextTokens: number; outputTokens: number; costUsd: number; turns: number; costBase?: number }
  rateLimits: Record<string, SDKRateLimitInfo>
  /** A usage limit refused Claude: when it resets, and when Glassbox will carry on (if you asked it to). */
  limitHit?: { resetsAt?: number; type?: string; continueAt?: number }
  permissions: PermissionRequest[]
  /** Questions Claude asked (AskUserQuestion) that wait for your answers. */
  userQuestions?: { id: string; questions: UserQuestion[] }[]
  /** Whether Claude has read each message you sent, by its uuid. */
  readReceipts?: Record<string, 'queued' | 'read' | 'dropped' | 'withdrawn'>
  /** Claude's own to-do list (Claude Code's TodoWrite, or TaskCreate/TaskUpdate), as it keeps it. */
  todos?: Todo[]
  /** Each subagent's own to-do list, by the agent's id. */
  agentTodos?: Record<string, Todo[]>
  /** Quick replies to messages you sent while Claude was tied up, by the message's uuid. */
  quickAnswers?: Record<string, { status: 'running' | 'done' | 'failed'; text?: string }>
  raw: { at: number; event: SessionEvent }[]
  stderr: string[]
  busySince?: number
  /** Claude's guess at your next message, offered in the message box until you type or send. */
  suggestion?: string
  /** Index of the current user turn; tool calls and edits are tagged with it for checkpoints. */
  turn: number
  /** Edits as Claude writes them, before they run (the tool input streaming in), newest last. */
  writing?: Writing[]
  /** Which tool call each thread (main, or an agent's id) is writing right now. */
  writingNow?: Record<string, string>
  /** Spells of thinking, per thread, for Live's lanes (end missing while it goes on). */
  thinking?: { agentId: string | null; at: number; end?: number }[]
  /** Edits you held (Live's Hold it) that now wait for you, by tool call id. */
  held?: Record<string, number>
  /** Instruction files Claude Code loaded (CLAUDE.md, rules), in the order they loaded. */
  instructions?: { path: string; type: string; at: number }[]
  /** When Claude started waiting on you (a question, a permission, a check-in or a held edit). */
  waitSince?: number
}

/** An edit Claude is writing: the tool call's input, as much as has arrived. */
export type Writing = { id: string; name: string; agentId: string | null; json: string; at: number }

export type SessionAction =
  | { type: 'event'; event: SessionEvent }
  | { type: 'user-prompt'; text: string; uuid?: string }
  | { type: 'comment'; text: string; target: CommentTarget; uuid: string }
  | { type: 'plan-status'; status: 'approved' | 'changes-requested' }
  /** Glassbox itself bringing something up (as Claude's open_* tools do), e.g. a connection on the map. */
  | { type: 'show'; target: OpenTarget; why?: string }
  /** Close questions without answering them. */
  | { type: 'dismiss-questions'; ids: string[] }
  /** Clear a loader from above the message box. */
  | { type: 'dismiss-loader'; id: string }
  /** You ran a command yourself ("! command"). */
  | { type: 'bang-start'; id: string; command: string }
  /** Those commands' output went to Claude with your message. */
  | { type: 'bang-sent'; ids: string[] }
  | { type: 'requirements'; requirements: Requirements }
  | { type: 'dismiss-alert'; at: number }
  | { type: 'finding-status'; id: string; status: 'sent' | 'dismissed' }

export const newSession = (): SessionState => ({
  status: 'new',
  mode: 'default',
  tools: [],
  commands: [],
  mcp: [],
  requirements: emptyRequirements,
  timeline: [],
  toolCalls: {},
  agents: {},
  files: [],
  pins: [],
  diagrams: {},
  flows: {},
  decisions: [],
  guardHits: [],
  findings: [],
  checkins: [],
  sideTasks: {},
  reviewer: { busy: false, pending: 0, reviewedEdits: 0 },
  commits: [],
  autoCommit: true,
  alerts: [],
  drafts: {},
  usage: { contextTokens: 0, outputTokens: 0, costUsd: 0, turns: 0 },
  rateLimits: {},
  permissions: [],
  raw: [],
  stderr: [],
  turn: 0
})

const RAW_LIMIT = 1500
const AGENT_TOOLS = new Set(['Agent', 'Task'])
export const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
/** Everything that changes files: the edit tools, plus files a shell command changed (tool 'ShellEdit'). */
export const CHANGE_TOOLS = new Set([...EDIT_TOOLS, 'ShellEdit'])
const FILE_TOOLS = new Set(['Read', ...EDIT_TOOLS])
/** Glassbox's own tools are shown through their panels, not as tool rows. */
/** Bookkeeping steps that show elsewhere (Tasks, decisions…) or say nothing to you: kept out of the conversation and activity. */
export const HIDDEN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ToolSearch', 'mcp__glassbox__show_progress', 'mcp__glassbox__present_file', 'mcp__glassbox__set_current_task', 'mcp__glassbox__log_decision', 'mcp__glassbox__set_acceptance_criteria', 'mcp__glassbox__report_finding', 'mcp__glassbox__check_in', 'mcp__glassbox__pin_file'])

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  const next = reduce(state, action)
  // How long Claude has been stopped on you, from the moment it first was.
  const waiting = blockedOnYou(next)
  if (waiting && next.waitSince === undefined) return { ...next, waitSince: Date.now() }
  if (!waiting && next.waitSince !== undefined) return { ...next, waitSince: undefined }
  return next
}

/**
 * The session as views that draw its work (the map, Ripple) see it: the same object until a part
 * they use changes, so text streaming in doesn't make them redraw.
 */
export function useSettledSession(s: SessionState): SessionState {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => s, [s.files, s.toolCalls, s.agents, s.status, s.permissions, s.userQuestions, s.checkins, s.decisions, s.requirements, s.task, s.todos, s.agentTodos, s.todosAt, s.backgroundTasks, s.planMap, s.plan, s.held, s.git, s.open])
}

/** Claude can't carry on until you answer: a question, a permission, a check-in or an edit you held. */
export function blockedOnYou(s: SessionState): boolean {
  return !!(s.permissions.length || s.userQuestions?.length || s.checkins.some((c) => c.answer === undefined) || Object.keys(s.held ?? {}).length)
}

function reduce(state: SessionState, action: SessionAction): SessionState {
  const at = Date.now()
  switch (action.type) {
    case 'user-prompt': {
      const turn = state.turn + 1
      return { ...state, turn, status: 'running', busySince: at, suggestion: undefined, limitHit: state.limitHit?.continueAt ? state.limitHit : undefined, timeline: [...state.timeline, { kind: 'user', text: action.text, uuid: action.uuid, at, turn }] }
    }
    case 'comment': {
      const decisions =
        action.target.kind === 'decision'
          ? state.decisions.map((d) => (d.id === (action.target as { id: string }).id ? { ...d, challenged: true, reply: action.text } : d))
          : action.target.kind === 'questions'
            ? state.decisions.map((d) => ((action.target as { ids: string[] }).ids.includes(d.id) ? { ...d, challenged: true, reply: action.text } : d))
            : state.decisions
      return { ...state, decisions, status: 'running', busySince: state.busySince ?? at, timeline: [...state.timeline, { kind: 'comment', text: action.text, target: action.target, uuid: action.uuid, at }] }
    }
    case 'bang-start':
      return {
        ...state,
        bangs: { ...state.bangs, [action.id]: { id: action.id, command: action.command, output: '', status: 'running', at } },
        timeline: [...state.timeline, { kind: 'bang', id: action.id, at }]
      }
    case 'bang-sent': {
      const bangs = { ...state.bangs }
      for (const id of action.ids) if (bangs[id]) bangs[id] = { ...bangs[id], sent: true }
      return { ...state, bangs }
    }
    case 'dismiss-loader': {
      const loaders = { ...state.loaders }
      delete loaders[action.id]
      return { ...state, loaders }
    }
    case 'dismiss-questions':
      rememberDismissed(action.ids)
      return { ...state, decisions: state.decisions.map((d) => (action.ids.includes(d.id) ? { ...d, challenged: true, dismissed: true } : d)) }
    case 'show':
      return { ...state, open: { n: (state.open?.n ?? 0) + 1, target: action.target, why: action.why, at: Date.now() } }
    case 'plan-status':
      return state.plan ? { ...state, plan: { ...state.plan, status: action.status } } : state
    case 'requirements':
      return { ...state, requirements: action.requirements }
    case 'dismiss-alert':
      return { ...state, alerts: state.alerts.filter((a) => a.at !== action.at) }
    case 'finding-status':
      return { ...state, findings: state.findings.map((f) => (f.id === action.id ? { ...f, status: action.status } : f)) }
    case 'event': {
      // Stream deltas are far too chatty for the raw log.
      const raw = action.event.kind === 'sdk' && action.event.msg.type === 'stream_event' ? state.raw : [...state.raw.slice(-(RAW_LIMIT - 1)), { at, event: action.event }]
      return applyEvent({ ...state, raw }, action.event)
    }
  }
}

function applyEvent(state: SessionState, event: SessionEvent): SessionState {
  const at = Date.now()
  switch (event.kind) {
    case 'status':
      if (event.status === 'stopped') state = settleRunning({ ...state, backgroundTasks: [], backgroundAgents: 0 }, at, () => false)
      return { ...state, status: event.status, busySince: event.status === 'running' ? (state.busySince ?? at) : undefined, drafts: event.status === 'running' ? state.drafts : {} }
    case 'error':
      return note(state, event.message, 'error')
    case 'stderr':
      return { ...state, stderr: [...state.stderr.slice(-299), event.text] }
    case 'bang': {
      const b = state.bangs?.[event.id]
      if (!b) return state
      // Kept to the last BANG_KEEP characters, so a chatty command can't swamp the session.
      const output = event.data ? (b.output + event.data).slice(-BANG_KEEP) : b.output
      const done = event.exit !== undefined
      const next: Bang = { ...b, output: event.error ? `${output}${output && !output.endsWith('\n') ? '\n' : ''}${event.error}\n` : output, ...(done ? { status: event.exit === 0 ? 'done' : 'failed', code: event.exit } : {}) }
      return { ...state, bangs: { ...state.bangs, [event.id]: next } }
    }
    case 'permission': {
      const next = { ...state, permissions: [...state.permissions, event] }
      if (event.toolName === 'ExitPlanMode' && typeof event.input.plan === 'string') next.plan = { text: event.input.plan, status: 'proposed', at }
      return next
    }
    case 'user-questions':
      return { ...state, userQuestions: [...(state.userQuestions ?? []).filter((q) => q.id !== event.id), { id: event.id, questions: event.questions }] }
    case 'quick-answer':
      return { ...state, quickAnswers: { ...state.quickAnswers, [event.uuid]: { status: event.status, text: event.text } } }
    case 'user-questions-done':
      return { ...state, userQuestions: (state.userQuestions ?? []).filter((q) => q.id !== event.id) }
    case 'permission-cancelled':
      return { ...state, permissions: state.permissions.filter((p) => p.id !== event.id) }
    case 'capabilities':
      return { ...state, commands: event.commands, models: event.models }
    case 'model':
      return { ...state, model: event.model }
    case 'held':
      return { ...state, held: { ...state.held, [event.toolUseId]: Date.now() } }
    case 'hold-done': {
      const held = { ...state.held }
      delete held[event.toolUseId]
      return { ...state, held }
    }
    case 'withdrawn':
      return { ...state, readReceipts: { ...state.readReceipts, [event.uuid]: 'withdrawn' } }
    case 'limit':
      return { ...state, limitHit: event.hit ? { resetsAt: event.resetsAt, type: event.type, continueAt: event.continueAt } : undefined }
    case 'mcp':
      return { ...state, mcp: event.servers }
    case 'context':
      return { ...state, context: event.usage, usage: { ...state.usage, contextTokens: event.usage.totalTokens } }
    case 'git':
      return { ...state, git: event.info }
    case 'mode':
      return { ...state, mode: event.mode, access: event.base }
    case 'guard':
      return { ...state, guardHits: [...state.guardHits, event.hit], timeline: [...state.timeline, { kind: 'guard', hit: event.hit, at }] }
    case 'checkin':
      return { ...state, checkins: [...state.checkins, event.checkin], timeline: [...state.timeline, { kind: 'checkin', id: event.checkin.id, at }] }
    case 'side':
      return { ...state, sideTasks: { ...state.sideTasks, [event.task.id]: event.task } }
    case 'checkin-resolved':
      return { ...state, checkins: state.checkins.map((c) => (c.id === event.id ? { ...c, answer: event.answer } : c)) }
    case 'reviewer': {
      const fresh = event.findings.map((f) => ({ ...f, status: 'open' as const }))
      return {
        ...state,
        findings: [...state.findings, ...fresh],
        reviewer: { ...state.reviewer, reviewedEdits: state.reviewer.reviewedEdits + event.reviewed.length },
        timeline: [...state.timeline, ...fresh.map((f) => ({ kind: 'finding' as const, id: f.id, at }))]
      }
    }
    case 'commits':
      return { ...state, commits: [...state.commits, ...event.commits], timeline: [...state.timeline, { kind: 'commits', commits: event.commits, skipped: event.skipped, error: event.error, at: Date.now() }] }
    case 'restore': {
      // Shell-made edits back where they happened in time, and the cost carried on from before.
      const restored = event.shellEdits.flatMap((r) => r.files.map((path) => ({ path, tool: 'ShellEdit', toolId: r.toolId, agentId: r.agentId, at: r.at, turn: state.turn })))
      const files = [...state.files, ...restored].sort((a, b) => a.at - b.at)
      return { ...state, files, usage: { ...state.usage, costUsd: event.costUsd, costBase: event.costUsd } }
    }
    case 'shell-edits': {
      const at = event.at ?? Date.now()
      return { ...state, files: [...state.files, ...event.files.map((path) => ({ path, tool: 'ShellEdit', toolId: event.toolId, agentId: event.agentId, at, turn: state.turn }))] }
    }
    case 'service-error': {
      const last = [...state.files].reverse().find((f) => CHANGE_TOOLS.has(f.tool) && f.at <= event.at && event.at - f.at < 10 * 60_000)
      // A service that keeps logging errors gets one card per turn, with a count, not a card each time.
      let since = state.timeline.length - 1
      while (since >= 0 && state.timeline[since].kind !== 'user') since--
      const prev = state.timeline.findIndex((x, i) => i > since && x.kind === 'service-error' && x.service === event.service)
      if (prev >= 0) {
        const old = state.timeline[prev] as Extract<TimelineItem, { kind: 'service-error' }>
        const timeline = state.timeline.slice()
        timeline[prev] = { ...old, text: event.text, count: (old.count ?? 1) + 1, lastAt: event.at, after: old.after ?? (last ? { path: last.path, at: last.at } : undefined) }
        return { ...state, timeline }
      }
      const item: TimelineItem = { kind: 'service-error', service: event.service, text: event.text, at: event.at, after: last ? { path: last.path, at: last.at } : undefined }
      return { ...state, timeline: [...state.timeline, item] }
    }
    case 'autocommit':
      return { ...state, autoCommit: event.enabled }
    case 'reviewer-state':
      return { ...state, reviewer: { ...state.reviewer, busy: event.busy, pending: event.pending, error: event.error } }
    case 'alert': {
      // An alert about one ongoing thing replaces the last one about it, rather than piling up, and
      // is noted in the conversation only the first time.
      const again = !!event.id && state.alerts.some((x) => x.id === event.id)
      const alerts = [...state.alerts.filter((x) => !event.id || x.id !== event.id).slice(-4), { level: event.level, text: event.text, at, id: event.id }]
      return again ? { ...state, alerts } : { ...state, alerts, timeline: [...state.timeline, { kind: 'note', text: event.text, tone: event.level === 'error' ? 'error' : event.level === 'info' ? 'info' : 'warn', at }] }
    }
    case 'alert-clear':
      return { ...state, alerts: state.alerts.filter((x) => x.id !== event.id) }
    case 'history': {
      let next = state
      for (const m of event.messages) {
        if (m.type === 'system') continue
        next = applySdk(next, { ...m, message: m.message } as SDKMessage, true, m.timestamp)
      }
      const settle = <T extends { status: string; at: number; endedAt?: number }>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.status === 'running' ? { ...v, status: 'done', endedAt: v.endedAt ?? v.at } : v]))
      next = { ...next, toolCalls: settle(next.toolCalls), agents: settle(next.agents) }
      return next.timeline.length ? note(next, tr('session.resumed'), 'info') : next
    }
    case 'glassbox': {
      const s = event.signal
      if (s.type === 'diagram') return { ...state, diagrams: { ...state.diagrams, [s.id]: { ...s, at } } }
      if (s.type === 'flow') return { ...state, flows: { ...state.flows, [s.id]: { ...s, at } } }
      if (s.type === 'task') return { ...state, task: { summary: s.summary, steps: s.steps, at } }
      if (s.type === 'showcase') return { ...state, showcase: { ...s, artifactUrl: s.artifactUrl ?? (state.showcase?.path === s.path ? state.showcase.artifactUrl : undefined), at } }
      if (s.type === 'open') return { ...state, open: { n: (state.open?.n ?? 0) + 1, target: s.target, why: s.why, at } }
      if (s.type === 'loader') return { ...state, loaders: { ...state.loaders, [s.loader.id]: s.loader } }
      return { ...state, pins: [...state.pins.filter((p) => p.path !== s.path), { path: s.path, reason: s.reason }] }
    }
    case 'hook': {
      const h = event.input
      switch (h.hook_event_name) {
        case 'InstructionsLoaded':
          if ((state.instructions ?? []).some((i) => i.path === h.file_path)) return state
          return { ...state, instructions: [...(state.instructions ?? []), { path: h.file_path, type: h.memory_type, at: Date.now() }] }
        case 'PreCompact':
          return note(state, tr('session.compacting'), 'warn')
        case 'PostCompact':
          return note(state, tr('session.compacted'), 'warn')
        case 'Notification':
          // "Claude needs your permission to use X" and "waiting for your input" are already the dialog
          // or the question box in front of you; as notes they only linger after you've answered.
          if (/needs your permission|waiting for your input/i.test(h.message)) return state
          return note(state, h.message, 'info')
        default:
          return state
      }
    }
    case 'sdk':
      return applySdk(state, event.msg, false)
  }
  return state
}

function applyStream(state: SessionState, msg: Extract<SDKMessage, { type: 'stream_event' }>): SessionState {
  const key = msg.parent_tool_use_id ?? 'main'
  const e = msg.event
  const now = Date.now()
  // Thinking ends when the next block starts (or this one stops).
  const endThinking = (s: SessionState): SessionState =>
    s.thinking?.some((t) => t.agentId === msg.parent_tool_use_id && t.end === undefined)
      ? { ...s, thinking: s.thinking.map((t) => (t.agentId === msg.parent_tool_use_id && t.end === undefined ? { ...t, end: now } : t)) }
      : s
  if (e.type === 'content_block_stop') {
    const writingNow = state.writingNow?.[key] ? { ...state.writingNow } : state.writingNow
    if (writingNow) delete writingNow[key]
    return endThinking({ ...state, writingNow })
  }
  if (e.type === 'content_block_start' && e.content_block.type === 'thinking')
    state = { ...endThinking(state), thinking: [...(state.thinking ?? []).slice(-299), { agentId: msg.parent_tool_use_id, at: now }] }
  // An edit starting to stream in: Live shows it as it's written, and you can hold it.
  if (e.type === 'content_block_start' && e.content_block.type === 'tool_use' && CHANGE_TOOLS.has(e.content_block.name)) {
    const w: Writing = { id: e.content_block.id, name: e.content_block.name, agentId: msg.parent_tool_use_id, json: '', at: now }
    return { ...endThinking(state), writing: [...(state.writing ?? []).slice(-7), w], writingNow: { ...state.writingNow, [key]: w.id } }
  }
  if (e.type === 'content_block_delta' && e.delta.type === 'input_json_delta') {
    const id = state.writingNow?.[key]
    if (!id) return state
    const part = e.delta.partial_json
    return { ...state, writing: (state.writing ?? []).map((w) => (w.id === id ? { ...w, json: w.json + part } : w)) }
  }
  if (e.type === 'content_block_start') {
    const kind = e.content_block.type === 'text' ? 'text' : e.content_block.type === 'thinking' ? 'thinking' : null
    if (!kind) return state
    return { ...state, drafts: { ...state.drafts, [key]: { kind, text: '', agentId: msg.parent_tool_use_id } } }
  }
  if (e.type === 'content_block_delta') {
    const d = state.drafts[key]
    if (!d) return state
    const delta = e.delta.type === 'text_delta' ? e.delta.text : e.delta.type === 'thinking_delta' ? e.delta.thinking : ''
    return delta ? { ...state, drafts: { ...state.drafts, [key]: { ...d, text: d.text + delta } } } : state
  }
  return state
}

function applySdk(state: SessionState, msg: SDKMessage, fromHistory: boolean, when?: number): SessionState {
  const at = when ?? Date.now()
  // Where a message you sent has got to: queued (Claude is mid-step), started (Claude has read it),
  // completed, or cancelled (a Stop swept it away before Claude read it).
  const life = msg as unknown as { type: string; command_uuid?: string; state?: string }
  if (life.type === 'command_lifecycle' && life.command_uuid && life.state) {
    const seen = (state.readReceipts ?? {})[life.command_uuid]
    if (seen === 'withdrawn') return state
    // Read is final: a turn that's stopped later reports its message "cancelled", but Claude did read it.
    const next = seen === 'read' ? 'read' : life.state === 'started' || life.state === 'completed' ? 'read' : life.state === 'queued' ? 'queued' : life.state === 'cancelled' || life.state === 'discarded' || life.state === 'refused' ? 'dropped' : seen
    return next === seen ? state : { ...state, readReceipts: { ...state.readReceipts, [life.command_uuid]: next! } }
  }
  switch (msg.type) {
    case 'stream_event':
      return applyStream(state, msg)

    case 'system':
      if (msg.subtype === 'init') {
        return { ...state, sessionId: msg.session_id, model: msg.model, tools: msg.tools, permissionMode: msg.permissionMode }
      }
      if (msg.subtype === 'compact_boundary') return note(state, tr('session.compactionBoundary'), 'warn')
      if (msg.subtype === 'background_tasks_changed' && !fromHistory) {
        const tasks = ((msg as { tasks?: { task_id: string; task_type?: string; description?: string; ambient?: boolean }[] }).tasks ?? []).filter((t) => !t.ambient)
        const before = new Map((state.backgroundTasks ?? []).map((t) => [t.id, t.since]))
        const listed = new Set(tasks.map((t) => t.task_id))
        // A background agent Claude no longer lists has ended, whether or not its own notice arrived.
        if (state.status !== 'running') state = settleRunning(state, at, (a) => !a.background || !a.taskId || listed.has(a.taskId), 'done')
        else {
          const gone = new Set(Object.values(state.agents).filter((a) => a.status === 'running' && a.background && a.taskId && !listed.has(a.taskId)).map((a) => a.id))
          if (gone.size) state = settleAgents(state, at, gone)
        }
        return {
          ...state,
          backgroundAgents: tasks.filter((t) => t.task_type === 'local_agent').length,
          backgroundTasks: tasks.map((t) => ({ id: t.task_id, type: t.task_type ?? '', description: t.description ?? '', since: before.get(t.task_id) ?? at }))
        }
      }
      // Agents (and other tasks) reporting on themselves: the only signal for one running in the
      // background, whose tool call returned straight away.
      if (msg.subtype === 'task_started' || msg.subtype === 'task_progress' || msg.subtype === 'task_updated' || msg.subtype === 'task_notification') {
        const m = msg as { subtype: string; task_id: string; tool_use_id?: string; is_backgrounded?: boolean; summary?: string; last_tool_name?: string; usage?: { tool_uses: number }; status?: string; patch?: { status?: string; is_backgrounded?: boolean } }
        // A task reporting on a call that isn't an Agent call (a forked skill): it shows as an agent from now on.
        if (m.tool_use_id && !state.agents[m.tool_use_id] && state.toolCalls[m.tool_use_id]) state = { ...state, agents: asAgent(state.agents, state.toolCalls, m.tool_use_id) }
        const a = (m.tool_use_id && state.agents[m.tool_use_id]) || Object.values(state.agents).find((x) => x.taskId === m.task_id)
        if (!a) return state
        const next: AgentNode = { ...a, taskId: m.task_id }
        if (m.subtype === 'task_started') {
          next.background = next.background || !!m.is_backgrounded
          if (!fromHistory) next.status = 'running'
        }
        if (m.subtype === 'task_progress') {
          if (m.usage) next.toolCalls = Math.max(next.toolCalls, m.usage.tool_uses)
          const doing = m.summary || (m.last_tool_name ? tr('session.usingTool', { tool: m.last_tool_name }) : undefined)
          if (doing) next.progress = doing
        }
        if (m.subtype === 'task_updated') {
          if (m.patch?.is_backgrounded) next.background = true
          const st = m.patch?.status
          if (st === 'completed') (next.status = 'done'), (next.endedAt = at), (next.stopped = false)
          else if (st === 'failed' || st === 'killed') (next.status = 'error'), (next.endedAt = at), (next.stopped = st === 'killed')
          else if (st === 'running' && !fromHistory) next.status = 'running'
        }
        if (m.subtype === 'task_notification') {
          next.status = m.status === 'completed' ? 'done' : 'error'
          next.stopped = m.status === 'stopped'
          next.endedAt = at
          if (m.summary) next.result = m.summary
          next.progress = undefined
          if (m.usage) next.toolCalls = Math.max(next.toolCalls, m.usage.tool_uses)
        }
        return { ...state, agents: { ...state.agents, [a.id]: next } }
      }
      return state

    case 'rate_limit_event': {
      const info = msg.rate_limit_info
      return { ...state, rateLimits: { ...state.rateLimits, [info.rateLimitType ?? 'unknown']: info } }
    }

    case 'assistant': {
      const agentId = msg.parent_tool_use_id
      const drafts = { ...state.drafts }
      delete drafts[agentId ?? 'main']
      const next: SessionState = {
        ...state,
        drafts,
        sessionId: state.sessionId ?? msg.session_id,
        timeline: [...state.timeline],
        toolCalls: { ...state.toolCalls },
        agents: asAgent(state.agents, state.toolCalls, agentId),
        files: [...state.files],
        decisions: state.decisions
      }
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text.trim()) {
          next.timeline.push({ kind: 'text', text: block.text, agentId, at })
        } else if (block.type === 'thinking' && block.thinking.trim()) {
          next.timeline.push({ kind: 'thinking', text: block.thinking, agentId, at })
        } else if (block.type === 'tool_use') {
          const input = (block.input ?? {}) as Record<string, unknown>
          next.toolCalls[block.id] = { id: block.id, name: block.name, input, agentId, status: 'running', at, turn: state.turn }
          if (block.name === 'mcp__glassbox__set_current_task') {
            next.task = { summary: String(input.summary ?? ''), steps: input.steps as TaskStep[] | undefined, at }
          }
          // To-do lists: Claude's own, and each agent's, kept apart.
          if (block.name === 'TodoWrite' || block.name === 'TaskCreate' || block.name === 'TaskUpdate') {
            const list = agentId ? (next.agentTodos?.[agentId] ?? []) : (next.todos ?? [])
            let updated = list
            if (block.name === 'TodoWrite' && Array.isArray(input.todos))
              updated = (input.todos as { content?: string; status?: string; activeForm?: string }[]).map((t) => ({ label: String(t.content ?? ''), status: todoStatus(t.status), activeForm: t.activeForm }))
            if (block.name === 'TaskCreate') updated = [...list, { toolId: block.id, label: String(input.subject ?? ''), status: 'pending', activeForm: input.activeForm as string | undefined }]
            // Claude Code's task list is shared: an agent may update a task the main thread made.
            if (block.name === 'TaskUpdate' && input.taskId != null && agentId && !list.some((t) => t.id === String(input.taskId)) && (next.todos ?? []).some((t) => t.id === String(input.taskId))) {
              const id = String(input.taskId)
              next.todosAt = at
              next.todos = (next.todos ?? []).flatMap((t) =>
                t.id !== id ? [t] : input.status === 'deleted' ? [] : [{ ...t, ...(input.status ? { status: todoStatus(input.status) } : {}), ...(input.subject ? { label: String(input.subject) } : {}), ...(input.activeForm ? { activeForm: String(input.activeForm) } : {}) }]
              )
            } else if (block.name === 'TaskUpdate' && input.taskId != null) {
              const id = String(input.taskId)
              updated = list.flatMap((t) =>
                t.id !== id ? [t] : input.status === 'deleted' ? [] : [{ ...t, ...(input.status ? { status: todoStatus(input.status) } : {}), ...(input.subject ? { label: String(input.subject) } : {}), ...(input.activeForm ? { activeForm: String(input.activeForm) } : {}) }]
              )
            }
            if (updated !== list) {
              if (agentId) next.agentTodos = { ...next.agentTodos, [agentId]: updated }
              else (next.todos = updated), (next.todosAt = at)
            }
          }
          if (block.name === 'mcp__glassbox__show_diagram' && typeof input.id === 'string') {
            next.diagrams = { ...next.diagrams, [input.id]: { id: input.id, title: String(input.title ?? input.id), mermaid: String(input.mermaid ?? ''), at } }
          }
          if (block.name === 'mcp__glassbox__show_flow') {
            const flow = parseFlow(input, at)
            if (flow) next.flows = { ...next.flows, [flow.id]: flow }
          }
          if (block.name === 'mcp__glassbox__set_acceptance_criteria' && Array.isArray(input.criteria)) {
            next.criteria = { source: typeof input.source === 'string' ? input.source : next.criteria?.source, list: input.criteria as AcceptanceCriterion[], at }
          }
          if (block.name === 'mcp__glassbox__report_finding') {
            const severity = ['blocker', 'major', 'minor', 'nit', 'question'].includes(String(input.severity)) ? (input.severity as Finding['severity']) : 'minor'
            next.findings = [
              ...(next.findings ?? state.findings),
              {
                id: block.id,
                source: 'claude',
                severity,
                title: String(input.title ?? ''),
                detail: typeof input.detail === 'string' ? input.detail : undefined,
                file: typeof input.file === 'string' ? input.file : undefined,
                line: typeof input.line === 'number' ? input.line : undefined,
                suggestion: typeof input.suggestion === 'string' ? input.suggestion : undefined,
                at,
                status: 'open'
              }
            ]
            next.timeline.push({ kind: 'finding', id: block.id, at })
          }
          if (block.name === 'mcp__glassbox__show_plan_on_map' && Array.isArray(input.modules)) {
            const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined)
            next.planMap = {
              modules: (input.modules as Record<string, unknown>[]).filter((m) => str(m?.path)).map((m) => ({ path: String(m.path), change: m.change === 'new' ? 'new' : 'change', why: str(m.why) })),
              connections: (Array.isArray(input.connections) ? (input.connections as Record<string, unknown>[]) : [])
                .filter((c) => str(c?.from) && str(c?.to))
                .map((c) => ({ from: String(c.from), to: String(c.to), change: c.change === 'removed' ? 'removed' : 'new', why: str(c.why), http: c.http === true || undefined })),
              at
            }
          }
          if (block.name === 'mcp__glassbox__present_file' && typeof input.path === 'string' && input.path.trim()) {
            const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined)
            next.presented = [...(next.presented ?? []), { id: block.id, path: input.path, title: str(input.title), why: str(input.why), at }]
            next.timeline.push({ kind: 'present', id: block.id, agentId, at })
          }
          if (block.name === 'mcp__glassbox__log_decision') {
            const kind = input.kind === 'assumption' || input.kind === 'question' ? input.kind : 'decision'
            next.decisions = [
              ...next.decisions,
              {
                id: block.id,
                kind,
                title: String(input.title ?? ''),
                detail: typeof input.detail === 'string' ? input.detail : undefined,
                alternatives: Array.isArray(input.alternatives) ? (input.alternatives as string[]) : undefined,
                files: Array.isArray(input.files) ? (input.files as string[]) : undefined,
                agentId,
                at,
                ...(kind === 'question' && dismissedIds().has(block.id) ? { challenged: true, dismissed: true } : {})
              }
            ]
            next.timeline.push({ kind: 'decision', id: block.id, agentId, at })
          }
          if (HIDDEN_TOOLS.has(block.name)) continue
          next.timeline.push({ kind: 'tool', toolId: block.id, agentId, at })
          const parent = agentId ? next.agents[agentId] : undefined
          if (parent) next.agents[parent.id] = { ...parent, toolCalls: parent.toolCalls + 1 }
          if (AGENT_TOOLS.has(block.name)) {
            next.agents[block.id] = {
              id: block.id,
              type: String(input.subagent_type ?? 'general-purpose'),
              description: String(input.description ?? ''),
              prompt: String(input.prompt ?? ''),
              parentId: agentId,
              status: 'running',
              toolCalls: 0,
              at,
              ...(input.run_in_background === true ? { background: true } : {})
            }
          }
          const path = input.file_path ?? input.notebook_path
          if (FILE_TOOLS.has(block.name) && typeof path === 'string') {
            next.files.push({ path, tool: block.name, toolId: block.id, agentId, at, turn: state.turn })
          }
        }
      }
      const u = msg.message.usage
      if (!agentId && u && !fromHistory) {
        next.usage = {
          ...next.usage,
          contextTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          outputTokens: next.usage.outputTokens + (u.output_tokens ?? 0)
        }
      }
      return next
    }

    case 'user': {
      const content = msg.message.content
      if (typeof content === 'string') return fromHistory ? historyPrompt(state, content, msg.uuid, at) : state
      const toolCalls = { ...state.toolCalls }
      const agents = { ...state.agents }
      let next = state
      for (const block of content) {
        if (block.type === 'text' && fromHistory && !msg.parent_tool_use_id) next = historyPrompt(next, block.text, msg.uuid, at)
        if (block.type !== 'tool_result') continue
        const call = toolCalls[block.tool_use_id]
        if (!call) continue
        const status = block.is_error ? 'error' : 'done'
        const result = contentToText(block.content)
        toolCalls[call.id] = { ...call, status, result, endedAt: fromHistory && !when ? undefined : at }
        // A task Claude created: its result names the id later updates use.
        if (call.name === 'TaskCreate') {
          const structured = (msg as { tool_use_result?: { task?: { id?: string } } }).tool_use_result?.task?.id
          const id = structured ?? result.match(/#\s*(\w+)/)?.[1] ?? result.match(/\bid\W+(\w+)/i)?.[1]
          const tag = (l: Todo[]) => l.map((t) => (t.toolId === call.id ? { ...t, id: String(id) } : t))
          if (id && call.agentId) next = { ...next, agentTodos: { ...next.agentTodos, [call.agentId]: tag(next.agentTodos?.[call.agentId] ?? []) } }
          else if (id) next = { ...next, todos: tag(next.todos ?? []) }
        }
        // A background agent's tool result only says it has started; it ends with its own notification.
        const bg = agents[call.id]?.background || /running in the background|launched (successfully )?in the background|async agent/i.test(result.slice(0, 300))
        if (agents[call.id]) agents[call.id] = bg && status === 'done' ? { ...agents[call.id], background: true } : { ...agents[call.id], status, result: withoutHandback(result), endedAt: at }
      }
      return { ...next, toolCalls, agents }
    }

    case 'prompt_suggestion':
      return fromHistory ? state : { ...state, suggestion: msg.suggestion.trim() || undefined }
    case 'result': {
      // The turn is over: only background agents Claude still lists as running carry on.
      const still = new Set((state.backgroundTasks ?? []).map((t) => t.id))
      state = fromHistory ? state : settleRunning(state, at, (a) => inBackground(state, a) && (!a.taskId || still.has(a.taskId) || !a.background))
      return {
        ...state,
        status: 'ready',
        busySince: undefined,
        drafts: {},
        usage: { ...state.usage, costUsd: (state.usage.costBase ?? 0) + msg.total_cost_usd, turns: state.usage.turns + msg.num_turns },
        timeline: [
          ...state.timeline,
          { kind: 'result', costUsd: msg.total_cost_usd, durationMs: msg.duration_ms, turns: msg.num_turns, isError: msg.is_error, stopped: /^aborted/.test(String((msg as { terminal_reason?: string }).terminal_reason ?? '')), at }
        ]
      }
    }

    default:
      return state
  }
}

/**
 * Agents and steps that are over but never said so (an interrupt, a crash, an agent that was killed
 * without a final notice) would otherwise spin for ever. `keep` says which running agents really
 * are still going; every other running agent, and every running step outside those, is closed.
 */
function settleRunning(state: SessionState, at: number, keep: (a: AgentNode) => boolean, ended: 'stopped' | 'done' = 'stopped'): SessionState {
  const live = new Set(Object.values(state.agents).filter((a) => a.status === 'running' && keep(a)).map((a) => a.id))
  let changed = false
  const agents = { ...state.agents }
  for (const a of Object.values(agents))
    if (a.status === 'running' && !live.has(a.id)) {
      agents[a.id] = ended === 'done' ? { ...a, status: 'done', endedAt: at, progress: undefined } : { ...a, status: 'error', stopped: true, endedAt: at, progress: undefined }
      changed = true
    }
  const toolCalls = { ...state.toolCalls }
  for (const c of Object.values(toolCalls))
    // A step belongs to an agent still going (or is the call that started one): leave it.
    if (c.status === 'running' && !(c.agentId && live.has(c.agentId)) && !live.has(c.id)) {
      toolCalls[c.id] = { ...c, status: 'done', endedAt: at }
      changed = true
    }
  return changed ? { ...state, agents, toolCalls } : state
}

/** Whether an agent runs in the background: itself, or because it was started by one that does. */
function inBackground(state: SessionState, a: AgentNode): boolean {
  for (let n: AgentNode | undefined = a, depth = 0; n && depth < 20; n = n.parentId ? state.agents[n.parentId] : undefined, depth++) if (n.background) return true
  return false
}

/** Close just these agents (and the steps they took), leaving everything else as it is. */
function settleAgents(state: SessionState, at: number, ids: Set<string>): SessionState {
  const agents = { ...state.agents }
  for (const id of ids) if (agents[id]) agents[id] = { ...agents[id], status: 'done', endedAt: at, progress: undefined }
  const toolCalls = { ...state.toolCalls }
  for (const c of Object.values(toolCalls)) if (c.status === 'running' && c.agentId && ids.has(c.agentId)) toolCalls[c.id] = { ...c, status: 'done', endedAt: at }
  return { ...state, agents, toolCalls }
}

/** Transcript user text: show real prompts and slash commands, skip harness-injected wrappers. */
function historyPrompt(state: SessionState, text: string, uuid: string | undefined, when = Date.now()): SessionState {
  const command = text.match(/<command-name>([^<]+)<\/command-name>/)
  let shown: string | undefined
  if (command) shown = `${command[1]} ${text.match(/<command-args>([^<]*)<\/command-args>/)?.[1] ?? ''}`.trim()
  else if (text.trim() && !text.startsWith('<') && !text.startsWith('Caveat:') && !text.startsWith('[Request interrupted') && !text.startsWith('[Glassbox')) shown = text
  if (!shown) return state
  // An answer or comment sent from Glassbox: tie it back to what it was about, so a question you
  // answered stays answered when the session is reopened.
  const review = text.match(/^Review comment from the user \(sent from Glassbox while you work\) on what you logged: "([\s\S]+?)"\n\n([\s\S]*?)\n\nTake this into account now/)
  if (review) {
    const [, title, reply] = review
    const d = [...state.decisions].reverse().find((x) => x.title === title && !x.challenged) ?? [...state.decisions].reverse().find((x) => x.title === title)
    if (d) {
      const decisions = state.decisions.map((x) => (x.id === d.id ? { ...x, challenged: true, reply } : x))
      return { ...state, decisions, timeline: [...state.timeline, { kind: 'comment', text: reply, target: { kind: 'decision', id: d.id, title: d.title }, uuid: uuid ?? '', at: when }] }
    }
  }
  // Several questions answered in one message: every one of them stays answered.
  const many = text.match(/^Answers from the user \(sent from Glassbox\) to your open questions:\n([\s\S]+?)\n\nTheir answer, covering all of them:\n([\s\S]*?)\n\nWork out which part/)
  if (many) {
    const titles = [...many[1].matchAll(/^\d+\. "([\s\S]*?)"$/gm)].map((m) => m[1])
    const reply = many[2]
    const ids = titles.map((t) => ([...state.decisions].reverse().find((x) => x.title === t && !x.challenged) ?? [...state.decisions].reverse().find((x) => x.title === t))?.id).filter((x): x is string => !!x)
    if (ids.length) {
      const decisions = state.decisions.map((x) => (ids.includes(x.id) ? { ...x, challenged: true, reply } : x))
      return { ...state, decisions, timeline: [...state.timeline, { kind: 'comment', text: reply, target: { kind: 'questions', ids, titles }, uuid: uuid ?? '', at: when }] }
    }
  }
  const turn = state.turn + 1
  return { ...state, turn, timeline: [...state.timeline, { kind: 'user', text: shown, uuid, at: when, turn }] }
}

function note(state: SessionState, text: string, tone: 'info' | 'warn' | 'error'): SessionState {
  return { ...state, timeline: [...state.timeline, { kind: 'note', text, tone, at: Date.now() }] }
}

export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : `[${(c as { type?: string })?.type ?? 'block'}]`))
      .join('\n')
  }
  return content == null ? '' : JSON.stringify(content, null, 2)
}

/** One-line description of a tool call's input, for list rows. */
export function toolSummary(call: ToolCall): string {
  const i = call.input
  const pick = i.description ?? i.file_path ?? i.notebook_path ?? i.command ?? i.pattern ?? i.url ?? i.query ?? i.skill ?? i.summary ?? i.title
  if (typeof pick === 'string') return pick
  const json = JSON.stringify(i)
  return json.length > 140 ? json.slice(0, 137) + '…' : json
}

export const approxTokens = (text: string | undefined) => Math.ceil((text?.length ?? 0) / 4)

/** Claude Code's own plan and memory files (~/.claude/plans, ~/.claude/projects) aren't project changes. */
export function isClaudeOwnFile(path: string): boolean {
  return /\/\.claude\/(plans|projects|pr-showcase)\//.test(path.replace(/\\/g, '/').toLowerCase())
}

const SHELL_SEARCH = /(^|[\s;&|(])(rg|grep|git\s+grep|findstr|fd|find|Select-String|Get-ChildItem|gci|ls|dir)\b/i
const MAX_HITS = 300

/** A file path at the start of a search-output line ("path", "path:12:text", "path-12-text", "path:3"). */
function pathFromLine(line: string): string | null {
  const s = line.trim()
  if (!s || s.length > 400 || /^(Found \d+|No (files|matches) found|\(Results are truncated)/i.test(s)) return null
  const drive = /^[A-Za-z]:[\\/]/.test(s) ? s.slice(0, 2) : ''
  const rest = s.slice(drive.length)
  const m = rest.match(/^(.+?)(?::\d+(?::|-|$)|-\d+-|$)/)
  if (!m) return null
  const path = (drive + m[1]).trim()
  // Must look like a file: a separator or an extension, and no spaces in its last segment.
  const last = path.split(/[\\/]/).pop() ?? ''
  if (!last || /\s/.test(last) || !(/[\\/]/.test(path) || /\.[A-Za-z0-9]{1,10}$/.test(last))) return null
  return path.replace(/\\/g, '/')
}

/**
 * Files a search turned up: Grep and Glob results, and shell searches (rg, grep, find, …).
 * These are files Claude saw in results, even if it never opened them.
 */
export function searchHits(call: ToolCall): string[] {
  // A call is replaced (never changed in place) when it updates, so its hits are worked out once.
  const cached = hitsCache.get(call)
  if (cached) return cached
  const hits = findHits(call)
  hitsCache.set(call, hits)
  return hits
}
const hitsCache = new WeakMap<ToolCall, string[]>()

function findHits(call: ToolCall): string[] {
  if (call.status !== 'done' || !call.result) return []
  const shell = call.name === 'Bash' || call.name === 'PowerShell'
  if (!(call.name === 'Grep' || call.name === 'Glob' || (shell && SHELL_SEARCH.test(String(call.input.command ?? ''))))) return []
  const hits = new Set<string>()
  for (const line of call.result.split('\n')) {
    const p = pathFromLine(line)
    if (p) hits.add(p)
    if (hits.size >= MAX_HITS) break
  }
  return [...hits]
}

/** A show_flow tool input as a Flow, or null if it's malformed (the tool rejects hops whose ends aren't lanes). */
function parseFlow(input: Record<string, unknown>, at: number): Flow | null {
  if (typeof input.id !== 'string' || !Array.isArray(input.lanes) || !Array.isArray(input.after)) return null
  const lanes = input.lanes.map(String)
  const known = new Set(lanes)
  const hops = (v: unknown): FlowHop[] | null => {
    if (!Array.isArray(v)) return null
    const out: FlowHop[] = []
    for (const h of v as Record<string, unknown>[]) {
      const from = String(h?.from ?? '')
      const to = String(h?.to ?? '')
      if (!known.has(from) || !known.has(to)) return null
      const kind = h.kind === 'new' || h.kind === 'changed' || h.kind === 'removed' ? h.kind : undefined
      out.push({ from, to, label: String(h.label ?? ''), kind })
    }
    return out
  }
  const after = hops(input.after)
  const before = input.before === undefined ? undefined : hops(input.before)
  if (!after || before === null) return null
  return { id: input.id, title: String(input.title ?? input.id), lanes, before, after, at }
}
