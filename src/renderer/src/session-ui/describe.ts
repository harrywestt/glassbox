import type { ToolCall } from '../session'
import { baseName } from '../lib'
import { tr } from '../../../shared/i18n'

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const baseOf = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return clip(url, 40)
  }
}

/** "slack_send_message" on server "claude_ai_Slack" → "Send message in Slack". */
function mcpPhrase(name: string, input: Record<string, unknown>): string {
  const m = name.match(/^mcp__(?:claude_ai_)?(.+?)__(.+)$/)
  if (!m) return name
  const server = m[1].replace(/_/g, ' ')
  const tool = m[2].replace(new RegExp(`^${m[1].split('_').pop()}_`, 'i'), '').replace(/_/g, ' ')
  const what = str(input.title) || str(input.summary) || str(input.query) || str(input.channel_id)
  return what ? tr('describe.mcpInWhat', { tool: sentence(tool), server, what: clip(what, 60) }) : tr('describe.mcpIn', { tool: sentence(tool), server })
}

/** A tool call as a plain-English phrase, e.g. "Read api.js", "Ran: list all repo files". */
export function describeTool(c: ToolCall): string {
  const i = c.input
  const file = baseName(str(i.file_path) || str(i.notebook_path))
  switch (c.name) {
    case 'Read':
      return tr('describe.read', { file })
    case 'Write':
      return tr('describe.wrote', { file })
    case 'Edit':
    case 'MultiEdit':
      return tr('describe.edited', { file })
    case 'NotebookEdit':
      return tr('describe.editedNotebook', { file })
    case 'Bash':
    case 'PowerShell':
      return str(i.description) ? sentence(str(i.description)) : tr('describe.ran', { command: clip(str(i.command), 70) })
    case 'Grep':
      return str(i.path)
        ? tr('describe.searchedForIn', { pattern: clip(str(i.pattern), 40), path: baseName(str(i.path)) })
        : tr('describe.searchedFor', { pattern: clip(str(i.pattern), 40) })
    case 'Glob':
      return tr('describe.lookedForFiles', { pattern: clip(str(i.pattern), 50) })
    case 'WebFetch':
      return tr('describe.openedSite', { host: host(str(i.url)) })
    case 'WebSearch':
      return tr('describe.searchedWeb', { query: clip(str(i.query), 50) })
    case 'Agent':
    case 'Task':
      return tr('describe.startedAgent', { description: clip(str(i.description), 70) })
    case 'Skill':
      return tr('describe.usedSkill', { skill: str(i.skill) || str(i.name) })
    case 'TodoWrite':
      return tr('describe.updatedTodos')
    case 'ToolSearch':
      return tr('describe.loadedTools')
    case 'ExitPlanMode':
      return tr('describe.presentedPlan')
    case 'AskUserQuestion': {
      const qs = (Array.isArray(i.questions) ? i.questions : []) as { question?: string }[]
      return qs.length > 1 ? tr('describe.askedQuestions', { n: qs.length }) : tr('describe.askedQuestion', { question: clip(str(qs[0]?.question), 70) })
    }
    case 'mcp__glassbox__show_diagram':
      return tr('describe.drewDiagram', { title: clip(str(i.title), 60) })
    case 'mcp__glassbox__show_flow':
      return tr('describe.showedFlow', { title: clip(str(i.title), 60) })
    case 'mcp__glassbox__showcase_ready':
      return tr('describe.finishedShowcase')
    case 'mcp__glassbox__open_file': {
      const f = baseOf(str(i.path))
      if (!i.line) return tr('describe.showedFile', { file: f })
      return i.endLine && i.endLine !== i.line
        ? tr('describe.showedFileLines', { file: f, line: String(i.line), endLine: String(i.endLine) })
        : tr('describe.showedFileLine', { file: f, line: String(i.line) })
    }
    case 'mcp__glassbox__open_diff':
      return tr('describe.showedChanges', { file: baseOf(str(i.path)) })
    case 'mcp__glassbox__show_on_map':
      return tr('describe.showedOnMap', { paths: clip((Array.isArray(i.paths) ? (i.paths as unknown[]) : []).map((p) => baseOf(String(p))).join(', '), 60) })
    case 'mcp__glassbox__show_impact':
      return tr('describe.showedImpact', { file: baseOf(str(i.path)) })
    case 'mcp__glassbox__open_preview':
      return tr('describe.openedPreview', { url: clip(str(i.url), 60) })
    case 'mcp__glassbox__start_app':
      return str(i.service) ? tr('describe.startedService', { service: str(i.service) }) : tr('describe.startedApp')
    case 'mcp__glassbox__stop_app':
      return str(i.service) ? tr('describe.stoppedService', { service: str(i.service) }) : tr('describe.stoppedApp')
    case 'mcp__glassbox__app_status':
      return tr('describe.checkedRunning')
    case 'mcp__glassbox__app_logs':
      return tr('describe.readLogs', { service: str(i.service) })
    case 'mcp__glassbox__open_tab':
      return tr('describe.openedTab', { tab: str(i.tab) })
    case 'mcp__glassbox__build_showcase':
      return tr('describe.startedShowcase')
    case 'mcp__glassbox__run_as_admin':
      return tr('describe.ranAsAdmin', { what: clip(str(i.reason) || str(i.command), 70) })
    default:
      return c.name.startsWith('mcp__') ? mcpPhrase(c.name, i) : sentence(c.name.replace(/_/g, ' '))
  }
}

type Bucket = 'read' | 'edit' | 'command' | 'search' | 'web' | 'agent' | 'connector' | 'other'
const bucketOf = (name: string): Bucket =>
  name === 'Read'
    ? 'read'
    : ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name)
      ? 'edit'
      : name === 'Bash' || name === 'PowerShell'
        ? 'command'
        : name === 'Grep' || name === 'Glob' || name === 'WebSearch'
          ? 'search'
          : name === 'WebFetch'
            ? 'web'
            : name === 'Agent' || name === 'Task'
              ? 'agent'
              : name.startsWith('mcp__') && !name.startsWith('mcp__glassbox__')
                ? 'connector'
                : 'other'

const join = (parts: string[]) => (parts.length <= 1 ? parts.join('') : tr('describe.list', { items: parts.slice(0, -1).join(', '), last: parts.at(-1) }))
/** One or two names: "a" or "a and b". */
const names = (f: string[]) => (f.length === 2 ? tr('describe.pair', { a: f[0], b: f[1] }) : f.join(''))

/** One line for a run of tool calls, e.g. "Read 3 files, ran 2 commands and edited api.js". */
export function summarizeTools(calls: ToolCall[]): string {
  const by = new Map<Bucket, ToolCall[]>()
  for (const c of calls) by.set(bucketOf(c.name), [...(by.get(bucketOf(c.name)) ?? []), c])
  const files = (cs: ToolCall[]) => [...new Set(cs.map((c) => baseName(str(c.input.file_path) || str(c.input.notebook_path))))]
  const parts: string[] = []
  const reads = by.get('read')
  if (reads) {
    const f = files(reads)
    parts.push(f.length <= 2 ? tr('describe.summary.readFiles', { files: names(f) }) : tr('describe.summary.readManyFiles', { n: f.length }))
  }
  const searches = by.get('search')
  if (searches)
    parts.push(
      searches.length === 1
        ? tr('describe.summary.searchedOnce')
        : searches.length === 2
          ? tr('describe.summary.searchedTwice')
          : tr('describe.summary.searchedTimes', { n: searches.length })
    )
  const commands = by.get('command')
  if (commands)
    parts.push(
      commands.length === 1
        ? tr('describe.summary.ranOne', { what: clip(describeTool(commands[0]), 50).toLowerCase() })
        : tr('describe.summary.ranCommands', { n: commands.length })
    )
  const edits = by.get('edit')
  if (edits) {
    const f = files(edits)
    parts.push(f.length <= 2 ? tr('describe.summary.editedFiles', { files: names(f) }) : tr('describe.summary.editedManyFiles', { n: f.length }))
  }
  const web = by.get('web')
  if (web) parts.push(tr('describe.summary.webPages', { count: web.length }))
  const agents = by.get('agent')
  if (agents) parts.push(tr('describe.summary.agents', { count: agents.length }))
  const connectors = by.get('connector')
  if (connectors) parts.push(connectors.length === 1 ? describeTool(connectors[0]).toLowerCase() : tr('describe.summary.usedConnectors', { n: connectors.length }))
  const other = by.get('other')
  if (other) parts.push(other.length === 1 ? describeTool(other[0]).toLowerCase() : tr('describe.summary.otherSteps', { n: other.length }))
  return sentence(join(parts))
}
