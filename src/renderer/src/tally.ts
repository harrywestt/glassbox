import type { SessionState } from './session'
import { baseName } from './lib'

/**
 * A session's tally lamp, as in a broadcast gallery: red while Claude works, amber when it's
 * waiting for you, green when it's ready or done, unlit while it starts. Every lamp in the app
 * (titlebar, program strip, fleet board, map) comes from here.
 */
export type Tally = 'live' | 'wait' | 'ok' | 'idle' | 'err'

/** Agents still working after Claude's own turn: the ones Glassbox tracks, or the SDK's count if higher. */
export function backgroundWork(s: SessionState): number {
  return Math.max(Object.values(s.agents).filter((a) => a.status === 'running').length, s.backgroundAgents ?? 0)
}

export function tallyOf(s: SessionState | undefined): Tally {
  if (!s) return 'idle'
  if (s.permissions.length || s.checkins.some((c) => c.answer === undefined) || s.decisions.some((d) => d.kind === 'question' && !d.challenged)) return 'wait'
  if (s.status === 'stopped') return 'err'
  if (s.status === 'running' || (s.status === 'ready' && backgroundWork(s) > 0)) return 'live'
  if (s.status === 'ready') return 'ok'
  return 'idle'
}

const VERBS: Record<string, (input: Record<string, unknown>) => string> = {
  Edit: (i) => `Editing ${file(i)}`,
  MultiEdit: (i) => `Editing ${file(i)}`,
  Write: (i) => `Writing ${file(i)}`,
  NotebookEdit: (i) => `Editing ${file(i)}`,
  Read: (i) => `Reading ${file(i)}`,
  Grep: () => 'Searching the code',
  Glob: () => 'Looking for files',
  Bash: () => 'Running a command',
  PowerShell: () => 'Running a command',
  Task: () => 'Running an agent',
  Agent: () => 'Running an agent',
  WebFetch: () => 'Reading a web page',
  WebSearch: () => 'Searching the web',
  TodoWrite: () => 'Planning'
}
const file = (i: Record<string, unknown>) => baseName(String(i.file_path ?? i.notebook_path ?? i.path ?? 'a file'))

/** What the session is doing right now, in a few words, for the label under its monitor. */
export function liveVerb(s: SessionState | undefined): string {
  if (!s) return 'Starting'
  if (s.permissions.length) return 'Needs your approval'
  if (s.checkins.some((c) => c.answer === undefined)) return 'Paused to ask you'
  if (s.decisions.some((d) => d.kind === 'question' && !d.challenged)) return 'Asked you a question'
  switch (s.status) {
    case 'new':
    case 'starting':
      return 'Starting'
    case 'stopped':
      return 'Stopped'
    case 'ready': {
      // Claude's turn is over but an agent it started in the background is still working.
      const bg = backgroundWork(s)
      if (bg) return bg === 1 ? 'An agent is working in the background' : `${bg} agents working in the background`
      return s.timeline.some((i) => i.kind === 'result') ? 'Done' : 'Ready'
    }
  }
  const running = Object.values(s.toolCalls).filter((c) => c.status === 'running').sort((a, b) => b.at - a.at)[0]
  if (running) {
    const name = running.name.startsWith('mcp__') ? running.name.split('__').pop()!.replace(/_/g, ' ') : running.name
    return VERBS[running.name]?.(running.input) ?? `Using ${name}`
  }
  return Object.keys(s.drafts).length ? 'Writing' : 'Thinking'
}

export const TALLY_LABEL: Record<Tally, string> = { live: 'Working', wait: 'Needs you', ok: 'Done', idle: 'Ready', err: 'Stopped' }
