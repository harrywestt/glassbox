import type { ToolCall } from '../session'
import { baseName } from '../lib'

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
  return `${sentence(tool)} in ${server}${what ? `: ${clip(what, 60)}` : ''}`
}

/** A tool call as a plain-English phrase, e.g. "Read api.js", "Ran: list all repo files". */
export function describeTool(c: ToolCall): string {
  const i = c.input
  const file = baseName(str(i.file_path) || str(i.notebook_path))
  switch (c.name) {
    case 'Read':
      return `Read ${file}`
    case 'Write':
      return `Wrote ${file}`
    case 'Edit':
    case 'MultiEdit':
      return `Edited ${file}`
    case 'NotebookEdit':
      return `Edited notebook ${file}`
    case 'Bash':
    case 'PowerShell':
      return str(i.description) ? sentence(str(i.description)) : `Ran ${clip(str(i.command), 70)}`
    case 'Grep':
      return `Searched for “${clip(str(i.pattern), 40)}”${str(i.path) ? ` in ${baseName(str(i.path))}` : ''}`
    case 'Glob':
      return `Looked for files matching ${clip(str(i.pattern), 50)}`
    case 'WebFetch':
      return `Opened ${host(str(i.url))}`
    case 'WebSearch':
      return `Searched the web for “${clip(str(i.query), 50)}”`
    case 'Agent':
    case 'Task':
      return `Started an agent: ${clip(str(i.description), 70)}`
    case 'Skill':
      return `Used the ${str(i.skill) || str(i.name)} skill`
    case 'TodoWrite':
      return 'Updated its to-do list'
    case 'ToolSearch':
      return 'Loaded extra tools'
    case 'ExitPlanMode':
      return 'Presented its plan'
    case 'mcp__glassbox__show_diagram':
      return `Drew a diagram: ${clip(str(i.title), 60)}`
    case 'mcp__glassbox__show_flow':
      return `Showed a flow: ${clip(str(i.title), 60)}`
    case 'mcp__glassbox__showcase_ready':
      return 'Finished the showcase'
    case 'mcp__glassbox__open_file':
      return `Showed you ${baseOf(str(i.path))}${i.line ? `, line ${i.line}${i.endLine && i.endLine !== i.line ? `–${i.endLine}` : ''}` : ''}`
    case 'mcp__glassbox__open_diff':
      return `Showed you the changes to ${baseOf(str(i.path))}`
    case 'mcp__glassbox__show_on_map':
      return `Showed you on the map: ${clip((Array.isArray(i.paths) ? (i.paths as unknown[]) : []).map((p) => baseOf(String(p))).join(', '), 60)}`
    case 'mcp__glassbox__show_impact':
      return `Showed you what depends on ${baseOf(str(i.path))}`
    case 'mcp__glassbox__open_preview':
      return `Opened ${clip(str(i.url), 60)} in the preview`
    case 'mcp__glassbox__start_app':
      return str(i.service) ? `Started ${str(i.service)} and opened the preview` : 'Started the app and opened the preview'
    case 'mcp__glassbox__stop_app':
      return str(i.service) ? `Stopped ${str(i.service)}` : 'Stopped the app'
    case 'mcp__glassbox__app_status':
      return "Checked what's running"
    case 'mcp__glassbox__app_logs':
      return `Read the ${str(i.service)} logs`
    case 'mcp__glassbox__open_tab':
      return `Opened ${str(i.tab)}`
    case 'mcp__glassbox__build_showcase':
      return 'Started a showcase'
    case 'mcp__glassbox__run_as_admin':
      return `Ran as administrator: ${clip(str(i.reason) || str(i.command), 70)}`
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

const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`)
const join = (parts: string[]) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`)

/** One line for a run of tool calls, e.g. "Read 3 files, ran 2 commands and edited api.js". */
export function summarizeTools(calls: ToolCall[]): string {
  const by = new Map<Bucket, ToolCall[]>()
  for (const c of calls) by.set(bucketOf(c.name), [...(by.get(bucketOf(c.name)) ?? []), c])
  const files = (cs: ToolCall[]) => [...new Set(cs.map((c) => baseName(str(c.input.file_path) || str(c.input.notebook_path))))]
  const parts: string[] = []
  const reads = by.get('read')
  if (reads) {
    const f = files(reads)
    parts.push(f.length <= 2 ? `read ${f.join(' and ')}` : `read ${f.length} files`)
  }
  const searches = by.get('search')
  if (searches) parts.push(searches.length === 1 ? 'searched once' : searches.length === 2 ? 'searched twice' : `searched ${searches.length} times`)
  const commands = by.get('command')
  if (commands) parts.push(commands.length === 1 ? `ran “${clip(describeTool(commands[0]), 50).toLowerCase()}”` : `ran ${commands.length} commands`)
  const edits = by.get('edit')
  if (edits) {
    const f = files(edits)
    parts.push(f.length <= 2 ? `edited ${f.join(' and ')}` : `edited ${f.length} files`)
  }
  const web = by.get('web')
  if (web) parts.push(plural(web.length, 'opened a web page', 'web pages opened'))
  const agents = by.get('agent')
  if (agents) parts.push(plural(agents.length, 'started an agent', 'agents started'))
  const connectors = by.get('connector')
  if (connectors) parts.push(connectors.length === 1 ? describeTool(connectors[0]).toLowerCase() : `used connectors ${connectors.length} times`)
  const other = by.get('other')
  if (other) parts.push(other.length === 1 ? describeTool(other[0]).toLowerCase() : `${other.length} other steps`)
  return sentence(join(parts))
}
