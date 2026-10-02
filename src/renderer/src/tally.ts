import type { SessionState } from './session'
import { baseName } from './lib'
import { tr } from '../../shared/i18n'

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

/** Agents and background tasks you can stop one at a time: the agents Glassbox tracks, then any other background task (a long command, say). */
export function stoppableTasks(s: SessionState): { id: string; label: string; agentId?: string }[] {
  const agents = Object.values(s.agents).filter((a) => a.status === 'running' && a.taskId)
  const seen = new Set(agents.map((a) => a.taskId))
  return [
    ...agents.sort((a, b) => a.at - b.at).map((a) => ({ id: a.taskId!, label: a.description || a.type, agentId: a.id })),
    ...(s.backgroundTasks ?? []).filter((t) => !seen.has(t.id)).map((t) => ({ id: t.id, label: t.description || (t.type === 'local_bash' ? tr('tally.backgroundCommand') : tr('tally.backgroundTask')) }))
  ]
}

export function tallyOf(s: SessionState | undefined): Tally {
  if (!s) return 'idle'
  if (s.permissions.length || s.userQuestions?.length || s.checkins.some((c) => c.answer === undefined) || s.decisions.some((d) => d.kind === 'question' && !d.challenged)) return 'wait'
  if (s.status === 'stopped') return 'err'
  if (s.status === 'running' || (s.status === 'ready' && backgroundWork(s) > 0)) return 'live'
  if (s.status === 'ready') return 'ok'
  return 'idle'
}

const VERBS: Record<string, (input: Record<string, unknown>) => string> = {
  Edit: (i) => tr('tally.editing', { file: file(i) }),
  MultiEdit: (i) => tr('tally.editing', { file: file(i) }),
  Write: (i) => tr('tally.writingFile', { file: file(i) }),
  NotebookEdit: (i) => tr('tally.editing', { file: file(i) }),
  Read: (i) => tr('tally.reading', { file: file(i) }),
  Grep: () => tr('tally.searchingCode'),
  Glob: () => tr('tally.lookingForFiles'),
  Bash: () => tr('tally.runningCommand'),
  PowerShell: () => tr('tally.runningCommand'),
  Task: () => tr('tally.runningAgent'),
  Agent: () => tr('tally.runningAgent'),
  WebFetch: () => tr('tally.readingWebPage'),
  WebSearch: () => tr('tally.searchingWeb'),
  TodoWrite: () => tr('tally.planning')
}
const file = (i: Record<string, unknown>) => baseName(String(i.file_path ?? i.notebook_path ?? i.path ?? tr('tally.aFile')))

/** What the session is doing right now, in a few words, for the label under its monitor. */
export function liveVerb(s: SessionState | undefined): string {
  // A restored tab's session starts the first time you open it.
  if (!s) return tr('tally.opensWhenSwitched')
  if (s.userQuestions?.length) return tr('tally.askedQuestions', { count: s.userQuestions[0].questions.length })
  if (s.permissions.length) return tr('tally.needsApproval')
  if (s.checkins.some((c) => c.answer === undefined)) return tr('tally.pausedToAsk')
  if (s.decisions.some((d) => d.kind === 'question' && !d.challenged)) return tr('tally.askedQuestion')
  switch (s.status) {
    case 'new':
      return tr('tally.opensWhenSwitched')
    case 'starting':
      return tr('tally.starting')
    case 'stopped':
      return tr('tally.stopped')
    case 'ready': {
      // Claude's turn is over but an agent it started in the background is still working.
      const bg = backgroundWork(s)
      if (bg) return tr('tally.agentsBackground', { count: bg })
      return s.timeline.some((i) => i.kind === 'result') ? tr('tally.done') : tr('tally.ready')
    }
  }
  const running = Object.values(s.toolCalls).filter((c) => c.status === 'running').sort((a, b) => b.at - a.at)[0]
  if (running) {
    const name = running.name.startsWith('mcp__') ? running.name.split('__').pop()!.replace(/_/g, ' ') : running.name
    return VERBS[running.name]?.(running.input) ?? tr('tally.using', { name })
  }
  return Object.keys(s.drafts).length ? tr('tally.writing') : tr('tally.thinking')
}

export const TALLY_LABEL: Record<Tally, string> = { live: tr('tally.label.live'), wait: tr('tally.label.wait'), ok: tr('tally.label.ok'), idle: tr('tally.label.idle'), err: tr('tally.label.err') }
