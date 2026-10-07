import { CHANGE_TOOLS, blockedOnYou, isClaudeOwnFile, type SessionState, type ToolCall, type Writing } from '../session'
import { liveVerb } from '../tally'
import { tr } from '../../../shared/i18n'

/** What a stretch of a lane was: the colours of Live's timeline. */
export type SegKind = 'read' | 'edit' | 'run' | 'think' | 'wait'
/** `from` and `to` are fractions of the window (0 is its start, 1 is now). */
export type Seg = { kind: SegKind; from: number; to: number }
export type Lane = { id: string; name: string; state: 'running' | 'done' | 'error' | 'paused'; meta: string; summary: string; segs: Seg[] }

const READ = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead', 'mcp__glassbox__browser_snapshot', 'mcp__glassbox__browser_eval'])
const RUN = new Set(['Bash', 'PowerShell', 'BashOutput', 'TaskOutput'])
const AGENT = new Set(['Agent', 'Task'])

export function kindOf(name: string): SegKind | null {
  if (CHANGE_TOOLS.has(name)) return 'edit'
  if (READ.has(name)) return 'read'
  if (RUN.has(name)) return 'run'
  if (AGENT.has(name)) return 'wait'
  return null
}

/** The last ten minutes. */
export const LANE_WINDOW = 10 * 60_000

export function lanes(s: SessionState, now: number): Lane[] {
  const start = now - LANE_WINDOW
  const frac = (t: number) => Math.min(1, Math.max(0, (t - start) / LANE_WINDOW))
  const segsFor = (agentId: string | null): Seg[] => {
    const out: Seg[] = []
    for (const c of Object.values(s.toolCalls)) {
      if (c.agentId !== agentId) continue
      const kind = kindOf(c.name)
      const end = c.endedAt ?? (c.status === 'running' ? now : c.at + 1000)
      if (!kind || end < start) continue
      // A background agent's call returns at once; the agent's own lane shows its work.
      out.push({ kind, from: frac(c.at), to: frac(end) })
    }
    for (const t of s.thinking ?? []) {
      if (t.agentId !== agentId) continue
      const end = t.end ?? now
      if (end >= start) out.push({ kind: 'think', from: frac(t.at), to: frac(end) })
    }
    // Every stretch at least a sliver wide, so a quick read still shows.
    return out.map((g) => ({ ...g, to: Math.max(g.to, g.from + 0.004) })).sort((a, b) => a.from - b.from)
  }
  const mainCalls = Object.values(s.toolCalls).filter((c) => c.agentId === null)
  const blocked = blockedOnYou(s)
  const main: Lane = {
    id: 'main',
    name: tr('live.lanes.main'),
    state: blocked ? 'paused' : s.status === 'running' ? 'running' : s.status === 'stopped' ? 'error' : 'done',
    meta: blocked ? tr('live.lanes.paused') : tr('live.lanes.tools', { count: mainCalls.length }),
    summary: blocked ? tr('live.lanes.waitingForYou') : liveVerb(s),
    segs: segsFor(null)
  }
  const agents: Lane[] = Object.values(s.agents)
    .filter((a) => a.status === 'running' || (a.endedAt ?? 0) > start)
    .sort((a, b) => a.at - b.at)
    .map((a) => ({
      id: a.id,
      name: a.description || a.type,
      state: a.status,
      meta: a.status === 'running' ? tr('live.lanes.agentRunning', { time: duration(now - a.at), count: a.toolCalls }) : a.status === 'done' ? tr('live.lanes.agentDone', { count: a.toolCalls }) : tr('live.lanes.agentFailed'),
      summary: firstLine(a.progress ?? a.result ?? ''),
      segs: segsFor(a.id)
    }))
  const commands: Lane[] = (s.backgroundTasks ?? [])
    .filter((t) => t.type === 'local_bash')
    .map((t) => ({ id: t.id, name: t.description || tr('live.lanes.command'), state: 'running', meta: tr('live.lanes.background', { time: duration(now - t.since) }), summary: '', segs: [{ kind: 'run', from: frac(t.since), to: 1 }] }))
  return [main, ...agents, ...commands]
}

/** Two threads changing the same file within two minutes of each other, in the last ten. */
export function collision(s: SessionState, now: number): { path: string; a: string; b: string; gap: number } | null {
  // Mid-sentence names: "the main thread", an agent's own description, or "an agent".
  const name = (id: string | null) => (id === null ? tr('live.lanes.mainInSentence') : s.agents[id]?.description ? `"${s.agents[id].description}"` : tr('live.lanes.anAgentInSentence'))
  const edits = s.files.filter((f) => CHANGE_TOOLS.has(f.tool) && f.at > now - LANE_WINDOW && s.toolCalls[f.toolId]?.status !== 'error').sort((a, b) => b.at - a.at)
  for (const e of edits)
    for (const o of edits)
      if (o.path === e.path && o.agentId !== e.agentId && Math.abs(o.at - e.at) < 120_000) return { path: e.path, a: name(o.agentId), b: name(e.agentId), gap: Math.abs(o.at - e.at) }
  return null
}

/* ── Has it been checked ── */

const CHECK = /\b(test|tests|jest|vitest|pytest|mocha|playwright|dotnet\s+(?:test|build)|cargo\s+(?:test|build|check)|go\s+(?:test|build|vet)|tsc|typecheck|type-check|lint|eslint|build|mvn|gradle)\b/i
const TEST = /\b(test|tests|jest|vitest|pytest|mocha|playwright|spec)\b/i

export type CheckRun = { id: string; command: string; test: boolean; at: number; end?: number; status: ToolCall['status'] }
export type Ledger = { path: string; editedAt: number; state: 'failing' | 'unchecked' | 'builds' | 'checking' | 'passed'; detail: string }

export function checkRuns(s: SessionState): CheckRun[] {
  return Object.values(s.toolCalls)
    .filter((c) => (c.name === 'Bash' || c.name === 'PowerShell') && CHECK.test(String(c.input.command ?? '')))
    .map((c) => ({ id: c.id, command: String(c.input.command), test: TEST.test(String(c.input.command)), at: c.at, end: c.endedAt, status: c.status }))
    .sort((a, b) => a.at - b.at)
}

/** Files changed this session, newest first: path to when it was last changed. */
export function changedFiles(s: SessionState): Map<string, number> {
  const last = new Map<string, number>()
  for (const f of s.files) {
    if (!CHANGE_TOOLS.has(f.tool) || isClaudeOwnFile(f.path) || s.toolCalls[f.toolId]?.status === 'error') continue
    last.set(f.path, Math.max(last.get(f.path) ?? 0, f.at))
  }
  return new Map([...last].sort((a, b) => b[1] - a[1]))
}

const ORDER: Ledger['state'][] = ['failing', 'unchecked', 'builds', 'checking', 'passed']

export function ledger(s: SessionState, now: number): Ledger[] {
  const runs = checkRuns(s)
  const out: Ledger[] = []
  for (const [path, editedAt] of changedFiles(s)) {
    const after = runs.filter((r) => r.at > editedAt)
    const changed = tr('live.checked.changed', { ago: ago(now - editedAt) })
    const test = after.filter((r) => r.test && r.status !== 'running').at(-1)
    const build = after.filter((r) => !r.test && r.status !== 'running').at(-1)
    const row = (state: Ledger['state'], detail: string): Ledger => ({ path, editedAt, state, detail: `${changed} ${detail}` })
    if (after.some((r) => r.status === 'running')) out.push(row('checking', tr('live.checked.running')))
    else if (test?.status === 'error') out.push(row('failing', tr('live.checked.testsFailed', { ago: ago(now - (test.end ?? test.at)) })))
    else if (test) out.push(row('passed', tr('live.checked.testsPassed', { ago: ago(now - (test.end ?? test.at)) })))
    else if (build?.status === 'error') out.push(row('failing', tr('live.checked.buildFailed', { ago: ago(now - (build.end ?? build.at)) })))
    else if (build) out.push(row('builds', tr('live.checked.builds', { ago: ago(now - (build.end ?? build.at)) })))
    else out.push(row('unchecked', tr('live.checked.none')))
  }
  return out.sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || b.editedAt - a.editedAt)
}

/* ── What Claude has looked at ── */

/** Line ranges (1-based, inclusive) read from each file, from the Read calls' own line numbers. */
export function readRanges(s: SessionState): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>()
  for (const c of Object.values(s.toolCalls)) {
    if (c.name !== 'Read' || c.status !== 'done') continue
    const path = String(c.input.file_path ?? '')
    const range = rangeOf(c)
    if (path && range) out.set(path, [...(out.get(path) ?? []), range])
  }
  return out
}

/** The lines a Read call showed, from its own line numbers (worked out once per call). */
const rangeCache = new WeakMap<ToolCall, [number, number] | null>()
function rangeOf(c: ToolCall): [number, number] | null {
  if (rangeCache.has(c)) return rangeCache.get(c)!
  const text = String(c.result ?? '')
  const lineNo = (line: string) => /^\s*(\d+)[→\t]/.exec(line)?.[1]
  const first = lineNo(text.slice(0, 200))
  // The last numbered line: look back from the end a line at a time (results end with notes, not code).
  let last: string | undefined
  for (let end = text.length; end > 0 && last === undefined; ) {
    const start = text.lastIndexOf('\n', end - 1) + 1
    last = lineNo(text.slice(start, end))
    end = start - 1
    if (text.length - end > 4000) break
  }
  const range: [number, number] | null = first && last ? [Number(first), Number(last)] : null
  rangeCache.set(c, range)
  return range
}

/** Where each change landed in the file now: line ranges, found by looking for the new text. */
export function changedRanges(s: SessionState, path: string, text: string): [number, number][] {
  const out: [number, number][] = []
  const lineAt = (i: number) => text.slice(0, i).split('\n').length
  for (const f of s.files) {
    if (f.path !== path) continue
    const c = s.toolCalls[f.toolId]
    if (!c || c.status === 'error') continue
    if (c.name === 'Write') return [[1, text.split('\n').length]]
    const pieces = c.name === 'MultiEdit' ? ((c.input.edits as { new_string: string }[] | undefined) ?? []).map((e) => e.new_string) : [String(c.input.new_string ?? '')]
    for (const p of pieces) {
      const i = p ? text.indexOf(p) : -1
      if (i >= 0) out.push([lineAt(i), lineAt(i + p.length)])
    }
  }
  return out
}

/** Lines in `changed` that no read covered. */
export function unreadChanged(read: [number, number][], changed: [number, number][]): number {
  let n = 0
  for (const [a, b] of changed) for (let l = a; l <= b; l++) if (!read.some(([x, y]) => l >= x && l <= y)) n++
  return n
}

/** Skills Claude used this session, and the agents' types (which bring their own instructions). */
export function skillsUsed(s: SessionState): string[] {
  return [...new Set(Object.values(s.toolCalls).filter((c) => c.name === 'Skill').map((c) => String(c.input.skill ?? c.input.name ?? '')).filter(Boolean))]
}

/* ── What needs you ── */

export type Flag = {
  id: string
  kind: 'blind' | 'circles' | 'clash' | 'offplan' | 'assumption' | 'unread'
  at: number
  title: string
  detail: string
  /** What the main button opens. */
  show?: { label: string; target: { view: 'diff' | 'file' | 'ripple'; path: string } }
  /** Prefilled for the message box: you edit it before it goes. */
  tell: string
}

/** The same check command failing three times running with the same first error. */
export function circles(s: SessionState): Flag | null {
  const byCommand = new Map<string, ToolCall[]>()
  for (const c of Object.values(s.toolCalls).sort((a, b) => a.at - b.at)) {
    if (c.name !== 'Bash' && c.name !== 'PowerShell') continue
    const key = String(c.input.command ?? '').trim().replace(/\s+/g, ' ')
    byCommand.set(key, [...(byCommand.get(key) ?? []), c])
  }
  for (const [command, calls] of byCommand) {
    const tail = calls.slice(-3)
    if (tail.length < 3 || !tail.every((c) => c.status === 'error')) continue
    const sig = (c: ToolCall) => (String(c.result ?? '').split('\n').find((l) => /error|exception|fail/i.test(l)) ?? '').trim().slice(0, 160)
    if (!sig(tail[0]) || !tail.every((c) => sig(c) === sig(tail[0]))) continue
    return {
      id: `circles:${command}`,
      kind: 'circles',
      at: tail[2].at,
      title: tr('live.flags.circlesTitle'),
      detail: `${command.slice(0, 80)}: ${sig(tail[0])}`,
      tell: tr('live.flags.circlesTell', { command: command.slice(0, 120) })
    }
  }
  return null
}

/** Files changed that no plan step names (only when the plan names its files). */
export function offPlan(s: SessionState, rel: (p: string) => string): Flag[] {
  const planned = (s.task?.steps ?? []).flatMap((st) => st.files ?? []).map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase())
  if (!planned.length) return []
  return [...changedFiles(s)]
    .filter(([p]) => !planned.some((q) => rel(p).toLowerCase().endsWith(q) || q.endsWith(rel(p).toLowerCase())))
    .slice(0, 3)
    .map(([p, at]) => ({
      id: `offplan:${p}`,
      kind: 'offplan' as const,
      at,
      title: tr('live.flags.offPlanTitle', { file: rel(p) }),
      detail: tr('live.flags.offPlanDetail'),
      show: { label: tr('live.flags.viewChange'), target: { view: 'diff' as const, path: p } },
      tell: tr('live.flags.offPlanTell', { file: rel(p) })
    }))
}

/** Assumptions Claude logged that nobody has answered. */
export function assumptions(s: SessionState): Flag[] {
  return s.decisions
    .filter((d) => d.kind === 'assumption' && !d.challenged && !d.dismissed && !d.reply)
    .slice(-3)
    .map((d) => ({ id: `assumption:${d.id}`, kind: 'assumption' as const, at: d.at, title: d.title, detail: d.detail ?? tr('live.flags.assumptionDetail'), tell: tr('live.flags.assumptionTell', { title: d.title }) }))
}

/* ── The edit on stage ── */

/** A string field from JSON that may still be arriving: as much of it as is there. */
export function partialField(json: string, key: string): string | undefined {
  const at = json.indexOf(`"${key}"`)
  if (at < 0) return undefined
  let i = json.indexOf('"', json.indexOf(':', at + key.length + 2) + 1)
  if (i < 0) return undefined
  let out = ''
  for (i = i + 1; i < json.length; i++) {
    const ch = json[i]
    if (ch === '"') return out
    if (ch !== '\\') {
      out += ch
      continue
    }
    const n = json[++i]
    if (n === undefined) break
    if (n === 'n') out += '\n'
    else if (n === 't') out += '\t'
    else if (n === 'r') out += ''
    else if (n === 'u') {
      const hex = json.slice(i + 1, i + 5)
      if (hex.length < 4) break
      out += String.fromCharCode(parseInt(hex, 16))
      i += 4
    } else out += n
  }
  return out
}

export type Stage =
  | { kind: 'writing' | 'held'; w: Writing; path: string; before: string; after: string }
  | { kind: 'landed'; call: ToolCall; path: string; before: string; after: string; at: number }
  | { kind: 'none' }

/** The edit worth watching: one you held, else one being written, else the last that landed. */
export function stage(s: SessionState): Stage {
  const fields = (name: string, input: Record<string, unknown> | string) => {
    const get = (k: string) => (typeof input === 'string' ? partialField(input, k) : (input[k] as string | undefined))
    if (name === 'Write') return { path: get('file_path') ?? '', before: '', after: get('content') ?? '' }
    if (name === 'MultiEdit') {
      const edits = typeof input === 'string' ? [] : ((input.edits as { old_string: string; new_string: string }[]) ?? [])
      return { path: get('file_path') ?? '', before: edits.map((e) => e.old_string).join('\n…\n'), after: edits.map((e) => e.new_string).join('\n…\n') }
    }
    return { path: get('file_path') ?? get('notebook_path') ?? '', before: get('old_string') ?? '', after: get('new_string') ?? get('new_source') ?? '' }
  }
  const writing = s.writing ?? []
  const heldId = Object.keys(s.held ?? {})[0]
  const held = heldId && (writing.find((w) => w.id === heldId) ?? (s.toolCalls[heldId] && { id: heldId, name: s.toolCalls[heldId].name, agentId: s.toolCalls[heldId].agentId, json: JSON.stringify(s.toolCalls[heldId].input), at: s.held![heldId] }))
  if (held) return { kind: 'held', w: held, ...fields(held.name, held.json) }
  const now = writing.filter((w) => Object.values(s.writingNow ?? {}).includes(w.id) || (!s.toolCalls[w.id] && Date.now() - w.at < 60_000)).at(-1)
  if (now) return { kind: 'writing', w: now, ...fields(now.name, now.json) }
  // Only edits that reached the file: one you turned down (or that failed) never landed.
  const last = Object.values(s.toolCalls).filter((c) => CHANGE_TOOLS.has(c.name) && c.status === 'done').sort((a, b) => (b.endedAt ?? b.at) - (a.endedAt ?? a.at))[0]
  if (last) return { kind: 'landed', call: last, at: last.endedAt ?? last.at, ...fields(last.name, last.input) }
  return { kind: 'none' }
}

/* ── Small helpers ── */

export const firstLine = (t: string) => t.split('\n').find((l) => l.trim())?.trim() ?? ''

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function ago(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 10) return tr('live.time.justNow')
  if (s < 60) return tr('live.time.seconds', { n: s })
  const m = Math.round(s / 60)
  return m < 60 ? tr('live.time.minutes', { n: m }) : tr('live.time.hours', { n: Math.round(m / 60) })
}

/** A wait timer: 2:14, or 1:02:14 past an hour. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
