import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { getSessionMessages, getSubagentMessages, type SessionMessage, type CanUseTool, type HookCallback, type HookCallbackMatcher, type HookEvent, type PermissionMode, type PermissionResult, type PermissionUpdate, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { query } from './claude'
import { GLASSBOX_INSTRUCTIONS, GLASSBOX_TOOLS, createGlassboxServer } from './glassboxMcp'
import { gitInfo } from './git'
import { SERVICES_INSTRUCTIONS, type ProjectServices } from './services'
import { Reviewer } from './reviewer'
import { autoCommit } from './autocommit'
import { runElevated } from './elevate'
import { DEFAULT_GUARDRAILS } from '../shared/guardrails'
import { type UserQuestion,
  emptyRequirements,
  type GuardHit,
  type GuardRule,
  type PermissionDecision,
  type Requirements,
  type RewindResult,
  type SendOptions,
  type SessionEvent,
  type AccessMode,
  type SideTask,
  type SideTaskSpec,
  type SideStep,
  type ReviewModel
} from '../shared/events'
import { showcaseDir, skillDeckDir } from './showcase'
import { loadExtras, saveExtras, type SessionExtras } from './sessionExtras'
import { cachedScan, importTargets, warmScan } from './architecture'
import { isPublicEntry } from '../shared/architecture'
import { isReadOnlyShell } from '../shared/readonlyShell'
import type { BrowserBridge } from './browserTools'
import { tr } from '../shared/i18n'

const OBSERVED_HOOKS: HookEvent[] = ['SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'Notification']
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
/** Nothing at all from Claude (no words, no steps) for this long while it isn't running a tool. */
const IDLE_ALERT_MS = 5 * 60_000
/** A single tool (a build, a test run) running this long. */
const TOOL_ALERT_MS = 15 * 60_000

/** Push-based prompt stream so every message goes into the same live session. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiter?: (r: IteratorResult<SDKUserMessage>) => void
  private closed = false

  push(msg: SDKUserMessage) {
    if (this.waiter) {
      this.waiter({ value: msg, done: false })
      this.waiter = undefined
    } else {
      this.items.push(msg)
    }
  }

  close() {
    this.closed = true
    this.waiter?.({ value: undefined, done: true })
    this.waiter = undefined
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => (this.waiter = resolve))
      }
    }
  }
}

type PendingPermission = {
  resolve: (r: PermissionResult) => void
  input: Record<string, unknown>
  toolName: string
  suggestions?: PermissionUpdate[]
}

function requirementsContext(req: Requirements): string | undefined {
  const lines: string[] = []
  const files = (mark: string) => req.files.filter((f) => f.mark === mark).map((f) => `  - ${f.path}`)
  const must = { read: files('read'), edit: files('edit'), avoid: files('avoid'), ask: files('ask'), api: files('api') }
  if (must.edit.length) lines.push('Files the user wants edited for this task:', ...must.edit)
  if (must.read.length) lines.push('Files you must read before acting:', ...must.read)
  if (must.avoid.length) lines.push('Files and folders you must NOT modify (edits to them are blocked):', ...must.avoid)
  if (must.ask.length) lines.push('Folders where each edit needs the user\'s approval first (they are asked when you edit; keep edits there few and deliberate):', ...must.ask)
  if (must.api.length)
    lines.push(
      'Modules other code may use only through their public entry point (index file, __init__.py, a contracts folder, or the project itself for C#/Go); imports into their internals from outside are blocked. Export what you need from the entry point instead:',
      ...must.api
    )
  if (req.connectors.length) lines.push(`Use these connectors (MCP servers) for this work where relevant: ${req.connectors.join(', ')}`)
  if (req.skills.length) lines.push(`Use these skills where they apply: ${req.skills.map((s) => '/' + s).join(', ')}`)
  return lines.length ? `Glassbox session requirements (set by the user in the UI):\n${lines.join('\n')}` : undefined
}

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()

/** Claude Code's own plan and memory files live outside the project; writing them is expected. */
const CLAUDE_OWN_DIRS = [join(homedir(), '.claude', 'plans'), join(homedir(), '.claude', 'projects'), join(homedir(), '.claude', 'pr-showcase'), showcaseDir()].map(norm)
/**
 * The working tree's changed files (absolute paths) with a signature of each: git status plus size
 * and modified time, so a file a command touches again still shows as changed. Null outside git.
 */
async function treeSnapshot(cwd: string): Promise<Map<string, string> | null> {
  const root = await new Promise<string | null>((done) =>
    execFile('git', ['rev-parse', '--show-toplevel'], { cwd, windowsHide: true }, (err, out) => done(err ? null : out.trim()))
  )
  if (!root) return null
  const out = await new Promise<string>((done) =>
    execFile('git', ['status', '--porcelain', '-uall'], { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, o) => done(err ? '' : o))
  )
  const snap = new Map<string, string>()
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue
    const rel = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop()!
    const full = join(root, rel)
    let sig = line.slice(0, 2)
    try {
      const st = statSync(full)
      sig += `:${st.size}:${st.mtimeMs}`
    } catch {
      sig += ':gone'
    }
    snap.set(full, sig)
  }
  return snap
}

/** When each message in a saved session happened, by uuid, read from its transcript file. */
/**
 * A resumed session's subagents: the main transcript only holds each agent's start and its report,
 * so each agent's own steps are read from its transcript (subagents/agent-<id>.jsonl) and tagged with
 * the tool call that started it (from its .meta.json), the way they arrive live.
 */
async function subagentHistory(sessionId: string, cwd: string): Promise<(SessionMessage & { timestamp?: number })[]> {
  const projects = join(homedir(), '.claude', 'projects')
  let folder: string | undefined
  try {
    for (const dir of readdirSync(projects)) {
      const f = join(projects, dir, sessionId, 'subagents')
      if (existsSync(f)) {
        folder = f
        break
      }
    }
  } catch {
    return []
  }
  if (!folder) return []
  const out: (SessionMessage & { timestamp?: number })[] = []
  for (const file of readdirSync(folder).filter((f) => f.endsWith('.meta.json'))) {
    try {
      const meta = JSON.parse(readFileSync(join(folder, file), 'utf8')) as { toolUseId?: string }
      const agentId = file.replace(/^agent-/, '').replace(/\.meta\.json$/, '')
      if (!meta.toolUseId) continue
      const times = new Map<string, number>()
      const jsonl = join(folder, `agent-${agentId}.jsonl`)
      if (existsSync(jsonl))
        for (const line of readFileSync(jsonl, 'utf8').split('\n')) {
          const uuid = line.match(/"uuid":"([^"]+)"/)?.[1]
          const ts = line.match(/"timestamp":"([^"]+)"/)?.[1]
          if (uuid && ts) times.set(uuid, Date.parse(ts))
        }
      const msgs = await getSubagentMessages(sessionId, agentId, { dir: cwd }).catch(() => [] as SessionMessage[])
      // Its first message is the brief the main thread already shows; the rest are its steps.
      for (const m of msgs.slice(1)) out.push({ ...m, parent_tool_use_id: meta.toolUseId, timestamp: times.get(m.uuid) })
    } catch {
      /* skip an agent we can't read */
    }
  }
  return out.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
}

function transcriptTimes(sessionId: string): Map<string, number> {
  const times = new Map<string, number>()
  const projects = join(homedir(), '.claude', 'projects')
  try {
    for (const dir of readdirSync(projects)) {
      const file = join(projects, dir, `${sessionId}.jsonl`)
      if (!existsSync(file)) continue
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const uuid = line.match(/"uuid":"([^"]+)"/)?.[1]
        const ts = line.match(/"timestamp":"([^"]+)"/)?.[1]
        if (uuid && ts) times.set(uuid, Date.parse(ts))
      }
      break
    }
  } catch {
    /* no transcript: times fall back to when it was loaded */
  }
  return times
}

/** The SDK turns the Artifact tool off by default; Glassbox sessions get it, as the CLI does. */
// BROWSER=none: dev tools that would open a browser tab (Create React App, many CLIs) don't;
// Glassbox shows those pages in its own preview instead.
// CLAUDE_CODE_ENABLE_TODO_TOOLS: Claude keeps a to-do list (TaskCreate/TaskUpdate) that Glassbox shows
// as Tasks; without it, SDK sessions on newer models have no list tools at all.
const SESSION_ENV = { ...process.env, CLAUDE_CODE_ARTIFACT: '1', BROWSER: 'none', CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }

const isClaudeOwnFile = (full: string) => CLAUDE_OWN_DIRS.some((d) => norm(full).startsWith(d + '/'))

/**
 * One Claude Code session. The query starts idle (no prompt) so skills, connectors and context
 * are inspectable before the first message; prompts are pushed through the input queue.
 */
export class AgentHost {
  private q?: Query
  private input?: InputQueue
  private abort?: AbortController
  private pending = new Map<string, PendingPermission>()
  private requirements: Requirements = emptyRequirements
  private guardrails: GuardRule[] = DEFAULT_GUARDRAILS
  private mode: PermissionMode = 'default'
  /** The access mode you chose; plan mode is temporary and returns to this. */
  private baseMode: AccessMode = 'default'
  private lastActivity = Date.now()
  private idleTimer?: NodeJS.Timeout
  private idleAlerted = false
  private busy = false
  private checkins = new Map<string, (answer: string) => void>()
  private currentTask?: string
  private reviewer: Reviewer
  /** Commit Claude's changes at the end of each turn. */
  private autoCommitOn = true
  /** Files Claude edited this turn, and this session (for Commit now). */
  private turnEdits = new Set<string>()
  private sessionEdits = new Set<string>()
  /** What the transcript won't remember (shell edits, cost), saved beside it for a resume. */
  private sid?: string
  private extras: SessionExtras = { costUsd: 0, shellEdits: [] }
  private costBase = 0
  private committing = false
  /** Working-tree state before each running shell command, to see what it changed. */
  private shellSnaps = new Map<string, Promise<Map<string, string> | null>>()
  private shellStarts = new Map<string, number>()
  private sideTasks = new Map<string, { task: SideTask; abort: AbortController }>()
  /**
   * When this session last changed each file (normalised path → time), and when its shell
   * commands ran: so a session sharing the folder never takes credit for (or commits) the other's work.
   */
  private editTimes = new Map<string, number>()
  private shellRuns: { start: number; end?: number }[] = []
  /** The branch the working tree was on when this turn started; auto-commit stops if it changes. */
  private turnBranch?: string
  /** You allowed every shell command for the rest of this session (guardrails still run first). */
  private shellAllowed = false
  /** The repo root (what the map's paths are relative to), once git has said. */
  private repoRoot?: string

  constructor(
    readonly cwd: string,
    private emit: (e: SessionEvent) => void,
    /** This session's services (what Run all starts), so Claude can run the app in the preview. */
    private app?: () => ProjectServices,
    /** The session's Browser tabs, for Claude's browser tools. */
    private browser?: { bridge: BrowserBridge; shotsDir: string },
    /** The other live sessions working in this same folder (the same git working tree). */
    private peers: () => AgentHost[] = () => []
  ) {
    this.reviewer = new Reviewer(
      cwd,
      () => this.currentTask,
      (findings, reviewed) => this.emit({ kind: 'reviewer', findings, reviewed }),
      (busy, pending, error) => this.emit({ kind: 'reviewer-state', busy, pending, error })
    )
  }

  async open(resume?: string, access: AccessMode = 'default') {
    this.baseMode = access
    this.mode = access
    if (resume) {
      const messages = await getSessionMessages(resume, { dir: this.cwd }).catch(() => [])
      const times = transcriptTimes(resume)
      const main = messages.map((m) => ({ ...m, timestamp: times.get(m.uuid) }))
      // Each agent's steps go right after the main-thread message that started it, so they replay in order.
      const agentSteps = await subagentHistory(resume, this.cwd)
      const merged: (SessionMessage & { timestamp?: number })[] = []
      for (const m of main) {
        merged.push(m)
        const started = Array.isArray((m as { message?: { content?: unknown } }).message?.content)
          ? ((m as { message: { content: { type?: string; id?: string }[] } }).message.content.filter((b) => b.type === 'tool_use').map((b) => b.id) as string[])
          : []
        for (const id of started) merged.push(...agentSteps.filter((s) => s.parent_tool_use_id === id))
      }
      this.emit({ kind: 'history', messages: merged })
      this.sid = resume
      const extras = await loadExtras(resume)
      if (extras) {
        this.extras = extras
        this.costBase = extras.costUsd
        for (const r of extras.shellEdits) for (const f of r.files) this.sessionEdits.add(f)
        this.emit({ kind: 'restore', costUsd: extras.costUsd, shellEdits: extras.shellEdits })
      }
    }
    // The api-only boundary check reads imports with the map's resolver; have it ready.
    warmScan(this.cwd)
    this.input = new InputQueue()
    this.abort = new AbortController()
    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
      ...Object.fromEntries(OBSERVED_HOOKS.map((event) => [event, [{ hooks: [this.onHook] }]])),
      UserPromptSubmit: [{ hooks: [this.onPromptSubmit] }],
      PreToolUse: [{ hooks: [this.onPreToolUse] }],
      PostToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell', hooks: [this.onFileChange] }]
    }

    const q = query({
      prompt: this.input,
      options: {
        cwd: this.cwd,
        resume,
        permissionMode: access,
        // Lets you switch to Full access later; guardrails still run as hooks in every mode.
        allowDangerouslySkipPermissions: true,
        abortController: this.abort,
        canUseTool: this.canUseTool,
        hooks,
        mcpServers: {
          glassbox: createGlassboxServer(
            (signal) => {
              if (signal.type === 'task') this.currentTask = signal.summary
              this.emit({ kind: 'glassbox', signal })
            },
            (q) => this.askUser(q),
            async (command) => {
              const r = await runElevated(this.cwd, command)
              if (r.declined) return 'The user declined the administrator prompt, so the command did not run. Ask them before trying again.'
              return `Exit code: ${r.exitCode ?? 'unknown'}\n${r.output || '(no output)'}`
            },
            this.app,
            undefined,
            this.cwd,
            this.browser
          )
        },
        allowedTools: GLASSBOX_TOOLS,
        settingSources: ['user', 'project', 'local'],
        env: SESSION_ENV,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: GLASSBOX_INSTRUCTIONS + SERVICES_INSTRUCTIONS },
        includePartialMessages: true,
        // A predicted next prompt after each turn (as in the CLI), offered in the message box.
        promptSuggestions: true,
        thinking: { type: 'adaptive', display: 'summarized' },
        enableFileCheckpointing: true,
        // Glassbox can stop agents one at a time, so Stop ends only Claude's reply and background agents keep going.
        perTaskStopAffordance: true,
        stderr: (text) => this.emit({ kind: 'stderr', text })
      }
    })
    this.q = q
    this.emit({ kind: 'status', status: 'starting' })
    void this.pump(q)
    void this.refreshGit()
    this.idleTimer = setInterval(() => this.checkIdle(), 15_000)

    try {
      const init = await q.initializationResult()
      this.emit({ kind: 'capabilities', commands: init.commands, models: init.models, account: init.account })
      this.emit({ kind: 'status', status: 'ready' })
      await this.refreshContext()
      // Connectors finish connecting in the background; re-poll so statuses settle.
      for (const delay of [0, 4000, 12000]) setTimeout(() => void this.refreshMcp(), delay)
    } catch (err) {
      if (!this.abort.signal.aborted) this.emit({ kind: 'error', message: tr('mainAgentHost.failedToStart', { error: String(err) }) })
    }
  }

  /**
   * Queue a message. `priority: 'now'` folds it into a running turn (used for live review comments);
   * `plan` switches to plan mode first so Claude proposes a plan before touching anything.
   */
  async send(text: string, opts: SendOptions) {
    if (!this.input || !this.q) throw new Error('Session is not running')
    if (opts.plan && this.mode !== 'plan') await this.setMode('plan')
    const msg = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid: opts.uuid, priority: opts.priority } as SDKUserMessage
    this.input.push(msg)
    const wasBusy = this.busy
    this.busy = true
    this.idleAlerted = false
    this.touch()
    this.emit({ kind: 'status', status: 'running' })
    if (wasBusy && opts.priority !== 'now') this.maybeQuickAnswer(text, opts.uuid)
  }

  /** When the main thread last said or did anything itself (not an agent's steps). */
  private mainActivity = 0
  /** Foreground agents the main thread is waiting on: it can't reply until they finish. */
  private waitingOn = new Set<string>()

  /**
   * You wrote while Claude was tied up: waiting on a foreground agent, or on a step that's already
   * run a while. Claude only reads your message when that finishes, which can be many minutes, so a
   * copy of the conversation answers you now. Claude still gets the message and acts on it after.
   */
  private maybeQuickAnswer(text: string, uuid: string) {
    if (!this.sid || text.trim().startsWith('/')) return
    const sentAt = Date.now()
    const tiedUp = () => this.waitingOn.size > 0 || [...this.openTools.values()].some((t) => Date.now() - t > 20_000)
    // Give Claude a moment to pick it up itself (between steps it reads new messages straight away).
    setTimeout(() => {
      if (!this.busy || this.mainActivity > sentAt || !tiedUp()) return
      void this.quickAnswer(text, uuid)
    }, 6_000)
  }

  private async quickAnswer(text: string, uuid: string) {
    const sid = this.sid
    if (!sid) return
    this.emit({ kind: 'quick-answer', uuid, status: 'running' })
    const busyWith = this.waitingOn.size ? `${this.waitingOn.size === 1 ? 'an agent' : `${this.waitingOn.size} agents`} you started` : 'a long-running step'
    const prompt = `[Glassbox: the user sent the message below while you were waiting on ${busyWith}. You are a quick side copy of the conversation, answering now so they aren't kept waiting; the main session also receives the message and will act on it when its current step finishes.]

${text}

Reply to the user now, briefly and directly, from what you know so far (glance at a file if you must). If it's a question, just answer it: don't mention the main session or this note. Only if it's an instruction or a change of plan for the ongoing work, add one sentence on what happens next: the main session and its running agents have the message and act on it after their current step, and the user can stop an agent from the Stop menu to have it acted on at once. Don't start the work yourself, don't edit files, and don't run commands.`
    let reply = ''
    try {
      for await (const msg of query({
        prompt,
        options: {
          cwd: this.cwd,
          resume: sid,
          forkSession: true,
          persistSession: false,
          model: 'sonnet',
          tools: ['Read', 'Grep', 'Glob'],
          allowedTools: ['Read', 'Grep', 'Glob'],
          settingSources: [],
          maxTurns: 6,
          env: SESSION_ENV
        }
      })) {
        if (msg.type === 'result') reply = msg.subtype === 'success' ? msg.result : ''
      }
      this.emit(reply.trim() ? { kind: 'quick-answer', uuid, status: 'done', text: reply.trim() } : { kind: 'quick-answer', uuid, status: 'failed' })
    } catch {
      this.emit({ kind: 'quick-answer', uuid, status: 'failed' })
    }
  }

  async interrupt() {
    await this.q?.interrupt()
  }

  /** Stop one agent or background task; Claude's reply and the other agents carry on. */
  async stopTask(taskId: string) {
    await this.q?.stopTask(taskId)
  }

  async rewind(userMessageId: string, dryRun: boolean): Promise<RewindResult> {
    if (!this.q) throw new Error('Session is not running')
    const result = await this.q.rewindFiles(userMessageId, { dryRun })
    if (!dryRun) void this.refreshGit()
    return result
  }

  close() {
    if (!this.q) return
    clearInterval(this.idleTimer)
    this.input?.close()
    this.abort?.abort()
    this.q.close()
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: 'Session closed' })
      this.emit({ kind: 'permission-cancelled', id })
    }
    for (const id of [...this.questions.keys()]) this.answerQuestions(id, null)
    this.pending.clear()
    for (const [id, resolve] of this.checkins) {
      resolve('The session was closed.')
      this.emit({ kind: 'checkin-resolved', id, answer: 'closed' })
    }
    this.checkins.clear()
    this.reviewer.dispose()
    for (const t of this.sideTasks.values()) t.abort.abort()
    this.q = undefined
    this.input = undefined
    this.emit({ kind: 'status', status: 'stopped' })
  }

  setAutoCommit(on: boolean) {
    this.autoCommitOn = on
    this.emit({ kind: 'autocommit', enabled: on })
  }

  /** Commits everything Claude has changed this session that's still uncommitted. */
  commitNow() {
    return this.commit([...this.sessionEdits])
  }

  private async commit(files: string[]) {
    if (this.committing || !files.length) return
    this.committing = true
    try {
      // Another session in this folder switched the branch mid-turn: committing now would put this
      // session's work on the wrong branch.
      const now = (await gitInfo(this.cwd)).branch
      if (this.turnBranch && now && now !== this.turnBranch) {
        this.emit({ kind: 'commits', commits: [], skipped: tr('mainAgentHost.branchChanged', { from: this.turnBranch, to: now }) })
        return
      }
      // Never commit a file another session in this folder has also changed: it may hold their work.
      const peers = this.peers()
      const shared = files.filter((f) => peers.some((h) => h.owns(isAbsolute(f) ? f : resolve(this.cwd, f))))
      const mine = files.filter((f) => !shared.includes(f))
      if (shared.length) this.emit({ kind: 'alert', level: 'warn', text: tr('mainAgentHost.notAutoCommitting', { count: shared.length, files: shared.slice(0, 4).map((p) => p.replace(/\\/g, '/').split('/').pop()).join(', ') }) })
      if (!mine.length) return
      const result = await autoCommit(this.cwd, mine, this.currentTask)
      if (result.commits.length || result.skipped || result.error) this.emit({ kind: 'commits', ...result })
    } finally {
      this.committing = false
      void this.refreshGit()
    }
  }

  review(model: ReviewModel) {
    return this.reviewer.review(model)
  }

  respondCheckin(id: string, answer: string) {
    const resolve = this.checkins.get(id)
    if (!resolve) return
    this.checkins.delete(id)
    resolve(answer)
    this.emit({ kind: 'checkin-resolved', id, answer })
  }

  /** Blocks the check_in tool until the user answers in Glassbox. */
  private askUser(q: { confidence: 'low' | 'medium'; about: string; reason: string; options?: string[] }): Promise<string> {
    const id = randomUUID()
    return new Promise((resolve) => {
      this.checkins.set(id, resolve)
      this.emit({ kind: 'checkin', checkin: { id, ...q, at: Date.now() } })
    })
  }

  /**
   * Run a sidebar request (a diagram, a showcase, a status post…) as a separate background Claude
   * run, so it never queues behind or interrupts the main session. Same guardrails, no prompts.
   */
  runSide(spec: SideTaskSpec) {
    const id = randomUUID()
    const abort = new AbortController()
    const task: SideTask = { id, kind: spec.kind, title: spec.title, status: 'running', startedAt: Date.now(), toolCalls: 0, steps: [] }
    const step = (s: Omit<SideStep, 'at'>) => (task.steps = [...(task.steps ?? []), { at: Date.now(), ...s }].slice(-80))
    this.sideTasks.set(id, { task, abort })
    const update = (patch: Partial<SideTask>) => {
      Object.assign(task, patch)
      this.emit({ kind: 'side', task: { ...task } })
    }
    update({})
    const prompt: AsyncIterable<SDKUserMessage> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'user', message: { role: 'user', content: spec.prompt }, parent_tool_use_id: null } as SDKUserMessage
      }
    }
    void (async () => {
      try {
        for await (const msg of query({
          prompt,
          options: {
            cwd: this.cwd,
            model: 'sonnet',
            tools: spec.tools,
            abortController: abort,
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            hooks: { PreToolUse: [{ hooks: [this.onPreToolUse] }] },
            mcpServers: {
              glassbox: createGlassboxServer(
                (signal) => this.emit({ kind: 'glassbox', signal }),
                async (q) => `No one is available to answer in a background task. Make the most reasonable choice about "${q.about}" and say which you chose.`
              )
            },
            settingSources: ['user', 'project', 'local'],
            env: SESSION_ENV,
            persistSession: false,
            maxTurns: 40,
            systemPrompt: {
              type: 'preset',
              preset: 'claude_code',
              append:
                GLASSBOX_INSTRUCTIONS +
                '\n\nYou are a background helper started from a Glassbox side panel while the user\'s main session keeps working. Do only the task you are given. Do not change project files unless the task says to. Finish with a short summary of what you did.'
            }
          }
        })) {
          if (msg.type === 'assistant') {
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text.trim()) {
                step({ text: block.text.trim().slice(0, 400) })
                update({})
              }
              if (block.type === 'tool_use') {
                const i = (block.input ?? {}) as Record<string, unknown>
                // Keep inputs small: long values (file contents, prompts) are trimmed.
                step({ tool: block.name, input: Object.fromEntries(Object.entries(i).map(([k, v]) => [k, typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v])) })
                const detail = i.description ?? i.file_path ?? i.command ?? i.pattern ?? i.title
                update({ toolCalls: task.toolCalls + 1, activity: `${block.name.replace(/^mcp__(claude_ai_)?/, '').replace(/__/g, ' ')}${typeof detail === 'string' ? ': ' + detail.slice(0, 100) : ''}` })
              }
            }
          }
          if (msg.type === 'result') {
            update({
              status: msg.is_error ? 'failed' : 'done',
              endedAt: Date.now(),
              costUsd: msg.total_cost_usd,
              result: msg.subtype === 'success' ? msg.result : msg.errors?.join('\n'),
              activity: undefined
            })
          }
        }
      } catch (err) {
        if (task.status === 'running') update({ status: abort.signal.aborted ? 'stopped' : 'failed', endedAt: Date.now(), result: abort.signal.aborted ? undefined : String(err), activity: undefined })
      } finally {
        this.sideTasks.delete(id)
      }
    })()
    return id
  }

  stopSide(id: string) {
    this.sideTasks.get(id)?.abort.abort()
  }

  setRequirements(req: Requirements) {
    this.requirements = req
  }

  setGuardrails(rules: GuardRule[]) {
    this.guardrails = rules
  }

  async refreshContext() {
    if (!this.q) return
    try {
      this.emit({ kind: 'context', usage: await this.q.getContextUsage({ detail: 'full' }) })
    } catch (err) {
      this.emit({ kind: 'stderr', text: `getContextUsage failed: ${String(err)}\n` })
    }
  }

  async refreshMcp() {
    if (!this.q) return
    this.emit({ kind: 'mcp', servers: await this.q.mcpServerStatus() })
  }

  async toggleMcp(name: string, enabled: boolean) {
    await this.q?.toggleMcpServer(name, enabled)
    await this.refreshMcp()
  }

  /** The folder's repo root, once known (and only while the session is running). */
  root() {
    return this.q ? this.repoRoot : undefined
  }

  /** Whether this session changed `path` at or after `since`. */
  changedSince(path: string, since: number) {
    return (this.editTimes.get(norm(path)) ?? 0) >= since
  }

  /** Whether one of this session's shell commands was running at any point between from and to. */
  shellOverlaps(from: number, to: number) {
    return this.shellRuns.some((r) => r.start <= to && (r.end ?? Date.now()) >= from)
  }

  /** Whether this session has changed `path` at all. */
  owns(path: string) {
    return this.editTimes.has(norm(path))
  }

  async refreshGit() {
    const info = await gitInfo(this.cwd)
    if (info.root) this.repoRoot = info.root.replace(/\\/g, '/')
    this.emit({ kind: 'git', info })
  }

  respondPermission(id: string, decision: PermissionDecision, message?: string) {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    this.emit({ kind: 'permission-cancelled', id })
    if (decision === 'deny') {
      p.resolve({ behavior: 'deny', message: message?.trim() || 'The user denied this tool call in Glassbox.' })
      return
    }
    if (decision === 'shell') this.shellAllowed = true
    p.resolve({ behavior: 'allow', updatedInput: p.input, updatedPermissions: decision === 'always' ? p.suggestions : undefined })
    // Others waiting on the same answer (shell commands asked in parallel) go through too.
    if (decision === 'shell')
      for (const [otherId, other] of [...this.pending]) {
        if (!SHELL_TOOLS.has(other.toolName)) continue
        this.pending.delete(otherId)
        this.emit({ kind: 'permission-cancelled', id: otherId })
        other.resolve({ behavior: 'allow', updatedInput: other.input })
      }
    // Approving a plan leaves plan mode for the access mode you chose.
    if (p.toolName === 'ExitPlanMode') void this.setMode(this.baseMode)
  }

  async setMode(mode: PermissionMode) {
    if (mode !== 'plan') this.baseMode = mode as AccessMode
    this.mode = mode
    await this.q?.setPermissionMode(mode)
    this.emit({ kind: 'mode', mode, base: this.baseMode })
  }

  /** Leave plan mode without a plan being approved. */
  exitPlan() {
    return this.setMode(this.baseMode)
  }

  private touch() {
    this.lastActivity = Date.now()
  }

  /** Tools Claude has started and not yet had a result for, with when each started. */
  private openTools = new Map<string, number>()

  /**
   * Warn at most once per turn, and only when it looks stuck: a long build or test run is normal,
   * so a running tool gets much longer than silence does, and subagents' progress counts as activity.
   */
  private checkIdle() {
    if (!this.busy || this.pending.size || this.idleAlerted) return
    const now = Date.now()
    const oldestTool = Math.min(...this.openTools.values())
    const stuck = this.openTools.size ? now - oldestTool > TOOL_ALERT_MS : now - this.lastActivity > IDLE_ALERT_MS
    if (!stuck) return
    this.idleAlerted = true
    this.emit({
      kind: 'alert',
      level: 'warn',
      text: this.openTools.size
        ? tr('mainAgentHost.stepRunningLong', { minutes: Math.round((now - oldestTool) / 60_000) })
        : tr('mainAgentHost.nothingFromClaude', { minutes: Math.round((now - this.lastActivity) / 60_000) })
    })
  }

  private trackTools(m: unknown) {
    const msg = m as { type: string; message?: { content?: unknown } }
    const content = (msg.type === 'assistant' || msg.type === 'user') && Array.isArray(msg.message?.content) ? (msg.message.content as { type: string; id?: string; name?: string; tool_use_id?: string }[]) : []
    const main = (m as { parent_tool_use_id?: string | null }).parent_tool_use_id == null
    if (main && msg.type === 'assistant') this.mainActivity = Date.now()
    for (const b of content as { type: string; id?: string; name?: string; tool_use_id?: string; input?: { run_in_background?: boolean } }[]) {
      // An agent's own steps are tracked one by one; the call that started it stays open throughout, so it isn't.
      if (b.type === 'tool_use' && b.id && b.name !== 'Agent' && b.name !== 'Task') this.openTools.set(b.id, Date.now())
      // A foreground agent started by Claude itself: the main thread waits for it.
      if (b.type === 'tool_use' && b.id && main && (b.name === 'Agent' || b.name === 'Task') && !b.input?.run_in_background) this.waitingOn.add(b.id)
      if (b.type === 'tool_result' && b.tool_use_id) this.openTools.delete(b.tool_use_id), this.waitingOn.delete(b.tool_use_id)
    }
    if (msg.type === 'result') this.openTools.clear(), this.waitingOn.clear()
  }

  private async pump(q: Query) {
    try {
      for await (const msg of q) {
        this.touch()
        this.trackTools(msg)
        this.emit({ kind: 'sdk', msg })
        if ('session_id' in msg && typeof msg.session_id === 'string') this.sid = msg.session_id
        if (msg.type === 'result') {
          // The query's cost starts again at 0 after a resume; the saved total carries on from before.
          this.extras.costUsd = this.costBase + (msg.total_cost_usd ?? 0)
          if (this.sid) void saveExtras(this.sid, this.extras)
          this.busy = false
          this.emit({ kind: 'status', status: 'ready' })
          void this.refreshContext()
          if (this.autoCommitOn && this.turnEdits.size) void this.commit([...this.turnEdits])
          else void this.refreshGit()
          this.turnEdits.clear()
        }
      }
    } catch (err) {
      if (!this.abort?.signal.aborted) this.emit({ kind: 'error', message: String(err) })
    } finally {
      if (this.q === q) {
        clearInterval(this.idleTimer)
        this.q = undefined
        this.input = undefined
        this.emit({ kind: 'status', status: 'stopped' })
      }
    }
  }

  private onHook: HookCallback = async (input) => {
    this.emit({ kind: 'hook', input })
    return {}
  }

  private onPromptSubmit: HookCallback = async () => {
    void gitInfo(this.cwd).then((g) => (this.turnBranch = g.branch))
    const additionalContext = requirementsContext(this.requirements)
    return additionalContext ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } } : {}
  }

  private onFileChange: HookCallback = async (input) => {
    void this.refreshGit()
    // A showcase deck written without showcase_ready (the pr-showcase skill, say) still shows in the Showcase view.
    if (input.hook_event_name === 'PostToolUse' && input.tool_name === 'Write') {
      const p = String((input.tool_input as { file_path?: string } | undefined)?.file_path ?? '')
      const n = p.replace(/\\/g, '/').toLowerCase()
      if (n.endsWith('.html') && [showcaseDir(), skillDeckDir()].some((d) => n.startsWith(d.replace(/\\/g, '/').toLowerCase() + '/')))
        this.emit({ kind: 'glassbox', signal: { type: 'showcase', path: p, title: basename(p).replace(/\.html$/i, '').replace(/[-_]+/g, ' ') } })
    }
    if (input.hook_event_name === 'PostToolUse' && (input.tool_name === 'Bash' || input.tool_name === 'PowerShell')) {
      const before = await this.shellSnaps.get(input.tool_use_id)
      this.shellSnaps.delete(input.tool_use_id)
      const after = before && (await treeSnapshot(this.cwd))
      const started = this.shellStarts.get(input.tool_use_id) ?? Date.now()
      this.shellStarts.delete(input.tool_use_id)
      const run = [...this.shellRuns].reverse().find((r) => r.start === started)
      if (run) run.end = Date.now()
      if (before && after) {
        // Temporary files an editor writes while saving (Claude Code's edits leave name.tmp.<pid>.<hex>
        // for a moment) aren't anyone's change.
        const all = [...after].filter(([p, sig]) => before.get(p) !== sig).map(([p]) => p).filter((p) => !isClaudeOwnFile(p) && !/\.tmp\.\d+\.[0-9a-f]+$/i.test(p) && !/(~|\.swp|\.tmp)$/i.test(p))
        // Another session in this folder may have made some of these changes. Its own edits aren't
        // this session's; and while its shell commands were running too, nobody can tell whose a
        // change was, so it isn't counted as this session's (and so never auto-committed here).
        const peers = this.peers()
        const now = Date.now()
        const theirs = all.filter((p) => peers.some((h) => h.changedSince(p, started)))
        const unclear = all.filter((p) => !theirs.includes(p) && peers.some((h) => h.shellOverlaps(started, now)))
        const changed = all.filter((p) => !theirs.includes(p) && !unclear.includes(p))
        if (theirs.length + unclear.length)
          this.emit({
            kind: 'alert',
            level: 'warn',
            text: tr('mainAgentHost.changedByOtherSession', { count: theirs.length + unclear.length, alsoRunning: unclear.length ? tr('mainAgentHost.alsoRunningCommand') : '', files: [...theirs, ...unclear].slice(0, 4).map((p) => p.replace(/\\/g, '/').split('/').pop()).join(', ') })
          })
        for (const p of changed) this.editTimes.set(norm(p), now)
        if (changed.length) {
          for (const p of changed) {
            this.turnEdits.add(p)
            this.sessionEdits.add(p)
          }
          const record = { toolId: input.tool_use_id, files: changed, agentId: (input as { agent_id?: string }).agent_id ?? null, at: Date.now() }
          this.emit({ kind: 'shell-edits', ...record })
          this.extras.shellEdits.push(record)
          if (this.sid) void saveExtras(this.sid, this.extras)
        }
      }
    }
    if (input.hook_event_name === 'PostToolUse' && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(input.tool_name)) {
      const i = (input.tool_input ?? {}) as Record<string, unknown>
      const path = String(i.file_path ?? i.notebook_path ?? '')
      if (path && !isClaudeOwnFile(path)) {
        this.turnEdits.add(path)
        this.sessionEdits.add(path)
        this.editTimes.set(norm(isAbsolute(path) ? path : resolve(this.cwd, path)), Date.now())
      }
      if (input.tool_name === 'Write') this.reviewer.add({ toolUseId: input.tool_use_id, tool: 'Write', path, after: String(i.content ?? '').slice(0, 12_000) })
      else if (input.tool_name === 'Edit') this.reviewer.add({ toolUseId: input.tool_use_id, tool: 'Edit', path, before: String(i.old_string ?? ''), after: String(i.new_string ?? '') })
      else if (Array.isArray(i.edits)) {
        const edits = i.edits as { old_string: string; new_string: string }[]
        this.reviewer.add({ toolUseId: input.tool_use_id, tool: 'MultiEdit', path, before: edits.map((e) => e.old_string).join('\n…\n'), after: edits.map((e) => e.new_string).join('\n…\n') })
      }
    }
    return {}
  }

  /** Guardrails run before every tool call, whatever the permission mode or settings allow. */
  /** Questions Claude asked (AskUserQuestion) that wait for your answers, by id. */
  private questions = new Map<string, (answers: Record<string, string> | null) => void>()

  /** Your answers to Claude's questions; null means you dismissed them without answering. */
  answerQuestions(id: string, answers: Record<string, string> | null) {
    const done = this.questions.get(id)
    if (!done) return
    this.questions.delete(id)
    this.emit({ kind: 'user-questions-done', id })
    done(answers)
  }

  private onPreToolUse: HookCallback = async (input, toolUseId) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    // Claude's own questions (AskUserQuestion): asked in the box under the conversation, in every
    // permission mode, and the answers go back with the tool call the way the CLI's prompt sends them.
    if (input.tool_name === 'AskUserQuestion') {
      const toolInput = (input.tool_input ?? {}) as { questions?: UserQuestion[] }
      const id = (toolUseId ?? input.tool_use_id ?? randomUUID()) as string
      const answers = await new Promise<Record<string, string> | null>((resolve) => {
        this.questions.set(id, resolve)
        this.emit({ kind: 'user-questions', id, questions: toolInput.questions ?? [] })
      })
      if (!answers)
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'The user closed your questions without answering. Carry on with your best judgement, and say what you assumed.' } }
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...toolInput, answers } } }
    }
    if ((input.tool_name === 'Bash' || input.tool_name === 'PowerShell') && input.tool_use_id) {
      this.shellSnaps.set(input.tool_use_id, treeSnapshot(this.cwd))
      this.shellStarts.set(input.tool_use_id, Date.now())
      this.shellRuns = [...this.shellRuns.filter((r) => !r.end || Date.now() - r.end < 10 * 60_000), { start: Date.now() }]
    }
    const hit = this.evaluateGuardrails(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, toolUseId ?? input.tool_use_id)
    if (!hit) return {}
    this.emit({ kind: 'guard', hit })
    if (hit.action === 'block') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: ((hint) => (hint ? `Blocked by a Glassbox guardrail: ${hit.label}. ${hint}` : `Blocked by a Glassbox guardrail: ${hit.label}. Don't retry; explain what you needed and ask the user.`))(this.guardrails.find((r) => r.id === hit.ruleId)?.hint ?? DEFAULT_GUARDRAILS.find((r) => r.id === hit.ruleId)?.hint)
        }
      }
    }
    // Ask-guardrails wait for your answer here, in the hook, so they still apply in Full access
    // (where the SDK never calls canUseTool).
    const allowed = await this.askGuard(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, hit.label)
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: allowed ? 'allow' : 'deny',
        permissionDecisionReason: allowed ? `Approved by the user (Glassbox guardrail: ${hit.label})` : `The user declined this at a Glassbox guardrail: ${hit.label}. Don't retry; ask what they'd like instead.`
      }
    }
  }

  private askGuard(toolName: string, input: Record<string, unknown>, label: string): Promise<boolean> {
    return new Promise((resolve) => {
      const id = randomUUID()
      this.pending.set(id, { resolve: (r) => resolve(r.behavior === 'allow'), input, toolName })
      this.emit({ kind: 'permission', id, toolName, input, canAlwaysAllow: false, guard: label })
    })
  }

  private evaluateGuardrails(toolName: string, toolInput: Record<string, unknown>, toolUseId: string): GuardHit | undefined {
    const path = toolInput.file_path ?? toolInput.notebook_path
    const command = typeof toolInput.command === 'string' ? toolInput.command : ''
    for (const rule of this.guardrails) {
      if (rule.action === 'off') continue
      let detail: string | undefined
      if (rule.scope === 'shell' && SHELL_TOOLS.has(toolName) && command && new RegExp(rule.pattern, 'i').test(command)) detail = command
      else if (rule.scope === 'mcp' && toolName.startsWith('mcp__') && new RegExp(rule.pattern, 'i').test(toolName)) detail = toolName
      else if (rule.scope === 'edit' && EDIT_TOOLS.has(toolName) && typeof path === 'string') {
        const full = isAbsolute(path) ? path : resolve(this.cwd, path)
        if (rule.id === ':protected-files' || rule.id === ':ask-files') {
          const mark = rule.id === ':protected-files' ? 'avoid' : 'ask'
          const protectedPaths = this.requirements.files.filter((f) => f.mark === mark).map((f) => norm(resolve(this.cwd, f.path)))
          // A protected folder (a fenced module on the map) covers everything inside it.
          const target = norm(full)
          if (protectedPaths.some((p) => target === p || target.startsWith(p + '/'))) detail = path
        } else if (rule.id === ':api-only') {
          detail = this.reachesInside(full, toolInput)
        } else if (rule.id === ':outside-project') {
          const rel = relative(this.cwd, full)
          if ((rel.startsWith('..') || isAbsolute(rel)) && !isClaudeOwnFile(full)) detail = path
        } else if (rule.pattern && new RegExp(rule.pattern, 'i').test(path)) detail = path
      }
      if (detail !== undefined) return { toolUseId, toolName, ruleId: rule.id, label: rule.label, action: rule.action, detail, at: Date.now() }
    }
    return undefined
  }

  /**
   * An edit outside a module marked "public API only" that adds an import of one of its internal
   * files: the file and what it reaches for, or undefined. Needs the map's import resolver in
   * memory; until it's ready, only relative imports are read.
   */
  private reachesInside(full: string, input: Record<string, unknown>): string | undefined {
    const guarded = this.requirements.files.filter((f) => f.mark === 'api').map((f) => norm(resolve(this.cwd, f.path)))
    if (!guarded.length || !this.repoRoot) return undefined
    const target = norm(full)
    const outside = guarded.filter((p) => !(target === p || target.startsWith(p + '/')))
    if (!outside.length) return undefined
    const added = [input.content, input.new_string, ...(Array.isArray(input.edits) ? (input.edits as { new_string?: unknown }[]).map((e) => e.new_string) : [])].filter((x): x is string => typeof x === 'string').join('\n')
    const removed = [input.old_string, ...(Array.isArray(input.edits) ? (input.edits as { old_string?: unknown }[]).map((e) => e.old_string) : [])].filter((x): x is string => typeof x === 'string').join('\n')
    if (!added) return undefined
    const root = this.repoRoot
    const rel = full.replace(/\\/g, '/').slice(root.length + 1)
    const scan = cachedScan(root)
    const targets = (text: string) =>
      scan
        ? importTargets(scan, rel, text)
        : [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])(\.[^'"\n]{0,300})\1/g)].map((m) => resolve(full, '..', m[2]).replace(/\\/g, '/').slice(root.length + 1))
    const before = new Set(removed ? targets(removed) : [])
    for (const t of targets(added)) {
      if (before.has(t)) continue
      const abs = norm(`${root}/${t.replace(/\/$/, '')}`)
      const inside = outside.find((p) => abs === p || abs.startsWith(p + '/'))
      if (!inside) continue
      const modPath = inside.slice(norm(root).length + 1)
      if (!isPublicEntry(modPath, t)) return `${rel} imports ${t}`
    }
    return undefined
  }

  private canUseTool: CanUseTool = (toolName, input, { signal, suggestions }) =>
    new Promise<PermissionResult>((resolve) => {
      // Glassbox's own tools only update this UI; never prompt for them (plan mode would otherwise).
      if (toolName.startsWith('mcp__glassbox__')) return resolve({ behavior: 'allow', updatedInput: input })
      // Shell commands that only read (ls, cat, grep, git status/log/diff…) don't need asking, nor
      // any shell command once you've allowed them for the session. Guardrails already ran.
      if (SHELL_TOOLS.has(toolName) && (this.shellAllowed || isReadOnlyShell(String(input.command ?? '')))) return resolve({ behavior: 'allow', updatedInput: input })
      // Planning in Full access: plan mode on its own asks about everything that isn't read-only
      // (commands, Jira and other connectors), ignoring the access you chose. Keep Full access's
      // "never ask"; plan mode's point, no changes to the project before you approve, still holds:
      // edits are turned away with a note (Claude's own plan file excepted), not put to you.
      // Presenting the plan (and asking you a question) always comes to you: that's the approval itself.
      if (this.mode === 'plan' && this.baseMode === 'bypassPermissions' && toolName !== 'ExitPlanMode' && toolName !== 'AskUserQuestion') {
        const path = String(input.file_path ?? input.notebook_path ?? '')
        if (EDIT_TOOLS.has(toolName) && !/[\\/]\.claude[\\/]plans[\\/]/i.test(path))
          return resolve({ behavior: 'deny', message: 'Plan mode: no changes to files until the user approves your plan. Finish the plan and present it with ExitPlanMode.' })
        return resolve({ behavior: 'allow', updatedInput: input })
      }
      const id = randomUUID()
      this.pending.set(id, { resolve, input, toolName, suggestions })
      signal.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return
        resolve({ behavior: 'deny', message: 'Aborted' })
        this.emit({ kind: 'permission-cancelled', id })
      })
      this.emit({ kind: 'permission', id, toolName, input, canAlwaysAllow: !!suggestions?.length })
    })
}
