import type { SessionState } from './session'
import { CHANGE_TOOLS } from './session'
import { relPath } from './lib'

export const READ_TOOLS = ['Read', 'Grep', 'Glob']
export const SHELL_TOOLS = ['Bash', 'PowerShell']

/**
 * A short brief of the main session for side tasks, which run separately and can't see its
 * conversation: the task, what you've asked, decisions, files touched and the latest reply.
 */
export function sessionBrief(s: SessionState, cwd: string): string {
  const lines: string[] = []
  if (s.task) {
    lines.push(`Current task: ${s.task.summary}`)
    for (const st of s.task.steps ?? []) lines.push(`  - [${st.status}] ${st.label}`)
  }
  const prompts = s.timeline.filter((i) => i.kind === 'user').slice(-4)
  if (prompts.length) lines.push('What the user asked (most recent last):', ...prompts.map((p) => `  - ${(p as { text: string }).text.slice(0, 400)}`))
  if (s.decisions.length) lines.push('Decisions and assumptions so far:', ...s.decisions.slice(-12).map((d) => `  - ${d.kind}: ${d.title}`))
  const edited = [...new Set(s.files.filter((f) => CHANGE_TOOLS.has(f.tool)).map((f) => relPath(cwd, f.path)))]
  const read = [...new Set(s.files.filter((f) => f.tool === 'Read').map((f) => relPath(cwd, f.path)))].filter((p) => !edited.includes(p))
  if (edited.length) lines.push(`Files changed: ${edited.slice(0, 30).join(', ')}`)
  if (read.length) lines.push(`Files read: ${read.slice(0, 30).join(', ')}`)
  const last = [...s.timeline].reverse().find((i) => i.kind === 'text' && i.agentId === null) as { text: string } | undefined
  if (last) lines.push(`Latest message from the main session:\n${last.text.slice(0, 1500)}`)
  return lines.length ? lines.join('\n') : 'The main session has not started any work yet.'
}
