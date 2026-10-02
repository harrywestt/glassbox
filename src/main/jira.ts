import { query, type McpServerConfig, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Ticket, TicketActionResult, TicketComment, TicketResult, TicketTransition, TicketTransitionsResult } from '../shared/events'

export { ticketKeyFromBranch } from '../shared/ticket'

/**
 * Jira through Claude's Atlassian connector (a claude.ai MCP connector), not a REST token.
 *
 * Each operation is a small one-shot query that may call only the one or two Atlassian tools it
 * needs. The connector's proxy config is found once by starting an idle query with user settings
 * (the only way claude.ai connectors are fetched), then passed explicitly with strictMcpConfig so
 * later queries load that one server and nothing else from the user's setup. The ticket data is
 * read from the tool results themselves, so the model only has to make the call.
 */

const SERVER = 'atlassian'
const T = (name: string) => `mcp__${SERVER}__${name}`
const RESOURCES = T('getAccessibleAtlassianResources')
const GET_ISSUE = T('getJiraIssue')
const GET_TRANSITIONS = T('getTransitionsForJiraIssue')
const TRANSITION = T('transitionJiraIssue')
const COMMENT = T('addCommentToJiraIssue')

const CONNECT = 'The Atlassian connector isn’t connected. Connect it in claude.ai (Settings, Connectors), then retry.'
const CACHE_MS = 60_000
const RUN_TIMEOUT_MS = 90_000

type Connector = { config: McpServerConfig; tools: string[] }
type Site = { cloudId: string; url?: string }

let connector: Promise<Connector> | null = null
let site: Site | null = null
const cache = new Map<string, { at: number; ticket: Ticket }>()
// Tickets are kept on disk too, so a reopened session shows its ticket at once (refreshed behind it).
let diskLoaded = false
const ticketsFile = async () => (await import('node:path')).join((await import('electron')).app.getPath('userData'), 'tickets.json')
async function loadDisk() {
  if (diskLoaded) return
  diskLoaded = true
  try {
    const saved = JSON.parse(await (await import('node:fs/promises')).readFile(await ticketsFile(), 'utf8')) as Record<string, { at: number; ticket: Ticket }>
    for (const [k, v] of Object.entries(saved)) if (!cache.has(k)) cache.set(k, v)
  } catch {
    /* nothing saved yet */
  }
}
async function saveDisk() {
  try {
    const recent = [...cache].sort((a, b) => b[1].at - a[1].at).slice(0, 100)
    await (await import('node:fs/promises')).writeFile(await ticketsFile(), JSON.stringify(Object.fromEntries(recent)))
  } catch {
    /* kept in memory */
  }
}
const inflight = new Map<string, Promise<TicketResult>>()

class JiraError extends Error {}

/** Start an idle query with user settings so claude.ai connectors load, and read the Atlassian one's config. */
async function discover(cwd: string): Promise<Connector> {
  let stop!: () => void
  const idle: AsyncIterable<never> = {
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((r) => (stop = r))
    }
  }
  const q: Query = query({ prompt: idle, options: { cwd, model: 'haiku', tools: [], settingSources: ['user'], persistSession: false } })
  try {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const servers = await q.mcpServerStatus()
      const atl = servers.find((s) => s.source === 'claudeai' && /atlassian/i.test(s.name))
      if (atl && atl.status !== 'pending') {
        if (atl.status !== 'connected' || atl.config?.type !== 'claudeai-proxy') throw new JiraError(CONNECT)
        // The typed union omits claudeai-proxy, but the CLI accepts it in mcpServers (verified).
        return { config: atl.config as unknown as McpServerConfig, tools: (atl.tools ?? []).map((t) => t.name) }
      }
      // claude.ai connectors have all loaded and none is Atlassian.
      const cloud = servers.filter((s) => s.source === 'claudeai')
      if (!atl && cloud.length && cloud.every((s) => s.status !== 'pending')) throw new JiraError(CONNECT)
      await new Promise((r) => setTimeout(r, 300))
    }
    throw new JiraError(CONNECT)
  } finally {
    stop?.()
    q.close()
  }
}

function getConnector(cwd: string): Promise<Connector> {
  if (!connector) {
    connector = discover(cwd)
    connector.catch(() => (connector = null)) // try again next time
  }
  return connector
}

type ToolOutput = { name: string; text: string; isError: boolean }

const resultText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('')
      : ''

/** Parse JSON the model wrote, tolerating a ```json fence or text around it. */
function parseJson(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = (fenced ? fenced[1] : text).trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * One helper query. It may call only `allowed` (plus the site lookup when the cloud id isn't
 * known yet), and must finish with a JSON line. Returns every result of the tools it called.
 */
async function run(cwd: string, allowed: string[], task: string): Promise<{ outputs: ToolOutput[]; reply: Record<string, unknown> | null }> {
  const { config, tools } = await getConnector(cwd)
  const allow = new Set(site ? allowed : [RESOURCES, ...allowed])
  const siteStep = site
    ? `Use cloudId "${site.cloudId}".`
    : `First call ${RESOURCES} (no arguments) and use the "id" of the site whose scopes include "read:jira-work" as the cloudId.`
  const prompt = `${siteStep}\n${task}\nMake each call exactly once with exactly the arguments given. Don't call anything else. When done, reply with only one line of JSON: {"ok":true}, or {"error":"<what went wrong, one short sentence>"} if a call failed.`

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), RUN_TIMEOUT_MS)
  const names = new Map<string, string>()
  const outputs: ToolOutput[] = []
  let reply: Record<string, unknown> | null = null
  const deny = (name: string) => !allow.has(name)
  try {
    for await (const msg of query({
      prompt,
      options: {
        cwd,
        model: 'haiku',
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: { [SERVER]: config },
        allowedTools: [...allow],
        // Keep the other connector tools out of the model's context entirely.
        disallowedTools: tools.map(T).filter((t) => !allow.has(t)),
        // Anything not in allowedTools is refused without asking; the hook below also refuses it
        // (hooks run whatever the permission rules say, so user allow rules can't widen this).
        permissionMode: 'dontAsk',
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (input) => {
                  const name = 'tool_name' in input ? String(input.tool_name) : ''
                  if (!deny(name)) return {}
                  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Only the Jira call asked for is allowed.' } }
                }
              ]
            }
          ]
        },
        systemPrompt: 'You make the Jira calls you are told to make with the Atlassian tools, then report the outcome as JSON. Never do anything else.',
        abortController: abort,
        persistSession: false,
        maxTurns: 6,
        thinking: { type: 'disabled' }
      }
    }) as AsyncIterable<SDKMessage>) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        const s = msg.mcp_servers.find((m) => m.name === SERVER)
        if (!s || s.status !== 'connected') {
          connector = null // the stored config may be stale
          throw new JiraError(CONNECT)
        }
      } else if (msg.type === 'assistant') {
        for (const b of msg.message.content) if (b.type === 'tool_use') names.set(b.id, b.name)
      } else if (msg.type === 'user' && Array.isArray(msg.message.content)) {
        for (const b of msg.message.content) {
          if (typeof b === 'object' && b.type === 'tool_result') {
            outputs.push({ name: names.get(b.tool_use_id) ?? '', text: resultText(b.content), isError: !!b.is_error })
          }
        }
      } else if (msg.type === 'result') {
        if (msg.subtype === 'success') reply = parseJson(msg.result)
      }
    }
  } catch (err) {
    if (err instanceof JiraError) throw err
    if (abort.signal.aborted) throw new JiraError('Jira took too long to answer. Retry.')
    throw new JiraError(`Couldn't reach Jira: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
  }
  rememberSite(outputs)
  return { outputs, reply }
}

function rememberSite(outputs: ToolOutput[]) {
  const out = outputs.find((o) => o.name === RESOURCES && !o.isError)
  if (!out) return
  try {
    const list = JSON.parse(out.text) as { id: string; url?: string; scopes?: string[] }[]
    const jira = list.find((r) => r.scopes?.some((s) => s.includes('jira'))) ?? list[0]
    if (jira?.id) site = { cloudId: jira.id, url: jira.url }
  } catch {
    /* leave unknown; the next call looks it up again */
  }
}

/** The one output of `tool`, or a clear error from its failure or the model's report. */
function outputOf(outputs: ToolOutput[], reply: Record<string, unknown> | null, tool: string, key: string): string {
  const resources = outputs.find((o) => o.name === RESOURCES)
  if (resources?.isError) throw new JiraError(describe(resources.text, key))
  if (resources && !site) throw new JiraError('Your Atlassian account has no Jira site the connector can reach.')
  const out = outputs.find((o) => o.name === tool)
  if (!out) throw new JiraError(typeof reply?.error === 'string' ? describe(reply.error, key) : 'Jira didn’t answer. Retry.')
  if (out.isError || /^\s*(error|\{"error)/i.test(out.text)) throw new JiraError(describe(out.text, key))
  return out.text
}

function describe(text: string, key: string): string {
  if (/does not exist|not found|404|no issue|permission to see/i.test(text)) return `Couldn't find ${key} in Jira.`
  if (/unauthori[sz]ed|401|403|forbidden|re-?auth|sign in|log ?in|token/i.test(text)) {
    connector = null
    return CONNECT
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 240) || 'Jira returned an error.'
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
const person = (v: unknown) => str(asRecord(v).displayName) ?? str(asRecord(v).emailAddress)
/** Jira's "2026-06-05T12:00:00.000+0100" as a standard ISO string. */
const iso = (v: unknown): string | undefined => {
  const s = str(v)
  if (!s) return undefined
  const t = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isNaN(t) ? s : new Date(t).toISOString()
}
const category = (v: unknown): Ticket['statusCategory'] => {
  const k = str(asRecord(v).key)
  return k === 'new' ? 'todo' : k === 'indeterminate' ? 'inprogress' : k === 'done' ? 'done' : undefined
}
/** Body text: markdown from the connector, or plain text pulled from ADF if that's what came back. */
function markdown(v: unknown): string {
  if (typeof v === 'string') return v
  if (!v || typeof v !== 'object') return ''
  const node = v as { type?: string; text?: string; content?: unknown[] }
  const inner = (node.content ?? []).map(markdown)
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'paragraph' || node.type === 'heading') return inner.join('') + '\n\n'
  if (node.type === 'listItem') return '- ' + inner.join('').trim() + '\n'
  return inner.join('')
}

function toTicket(text: string, key: string): Ticket {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(text)
  } catch {
    throw new JiraError('Jira sent something Glassbox couldn’t read. Retry.')
  }
  const nodes = asRecord(data.issues).nodes
  const issue = asRecord(Array.isArray(nodes) ? nodes[0] : Array.isArray(data.issues) ? data.issues[0] : data)
  const f = asRecord(issue.fields)
  if (!issue.key && !f.summary) throw new JiraError(`Couldn't find ${key} in Jira.`)
  const realKey = str(issue.key) ?? key
  const rawComments = asRecord(f.comment).comments
  const comments: TicketComment[] = (Array.isArray(rawComments) ? rawComments : []).map((c) => {
    const r = asRecord(c)
    return { id: str(r.id), author: person(r.author) ?? 'Unknown', created: iso(r.created) ?? '', body: markdown(r.body).trim() }
  })
  const status = asRecord(f.status)
  return {
    key: realKey,
    url: str(issue.webUrl) ?? (site?.url ? `${site.url.replace(/\/$/, '')}/browse/${realKey}` : undefined),
    summary: str(f.summary) ?? realKey,
    status: str(status.name) ?? 'Unknown',
    statusCategory: category(status.statusCategory),
    type: str(asRecord(f.issuetype).name),
    priority: str(asRecord(f.priority).name),
    assignee: person(f.assignee),
    reporter: person(f.reporter),
    updated: iso(f.updated),
    description: markdown(f.description).trim(),
    comments
  }
}

const fail = (err: unknown): { error: string } => ({ error: err instanceof Error ? err.message : String(err) })
const normKey = (key: string) => key.trim().toUpperCase()

export async function getTicket(cwd: string, rawKey: string, force = false): Promise<TicketResult> {
  const key = normKey(rawKey)
  await loadDisk()
  const hit = cache.get(key)
  if (!force && hit) {
    // Fresh enough, or older but shown straight away while a fresh copy loads for next time.
    if (Date.now() - hit.at >= CACHE_MS && !inflight.has(key)) void getTicket(cwd, rawKey, true)
    return { ticket: hit.ticket, stale: Date.now() - hit.at >= CACHE_MS }
  }
  const running = inflight.get(key)
  if (running) return running
  const p = (async (): Promise<TicketResult> => {
    try {
      const fields = ['summary', 'status', 'issuetype', 'priority', 'assignee', 'reporter', 'updated', 'description', 'comment']
      const args = { issueIdOrKey: key, fields, responseContentFormat: 'markdown' }
      const { outputs, reply } = await run(cwd, [GET_ISSUE], `Then call ${GET_ISSUE} with cloudId and these arguments: ${JSON.stringify(args)}`)
      const ticket = toTicket(outputOf(outputs, reply, GET_ISSUE, key), key)
      cache.set(key, { at: Date.now(), ticket })
      void saveDisk()
      return { ticket }
    } catch (err) {
      return fail(err)
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, p)
  return p
}

export async function getTransitions(cwd: string, rawKey: string): Promise<TicketTransitionsResult> {
  const key = normKey(rawKey)
  try {
    const { outputs, reply } = await run(cwd, [GET_TRANSITIONS], `Then call ${GET_TRANSITIONS} with cloudId and these arguments: ${JSON.stringify({ issueIdOrKey: key })}`)
    const data = asRecord(JSON.parse(outputOf(outputs, reply, GET_TRANSITIONS, key)))
    const list = Array.isArray(data.transitions) ? data.transitions : []
    const transitions: TicketTransition[] = list
      .map(asRecord)
      .filter((t) => t.isAvailable !== false && str(t.id))
      .map((t) => ({ id: String(t.id), name: str(t.name) ?? String(t.id), to: str(asRecord(t.to).name) }))
    return { transitions }
  } catch (err) {
    return fail(err instanceof SyntaxError ? new JiraError('Jira sent something Glassbox couldn’t read. Retry.') : err)
  }
}

export async function transitionTicket(cwd: string, rawKey: string, transitionId: string): Promise<TicketActionResult> {
  const key = normKey(rawKey)
  try {
    const args = { issueIdOrKey: key, transition: { id: String(transitionId) } }
    const { outputs, reply } = await run(cwd, [TRANSITION], `Then call ${TRANSITION} with cloudId and these arguments: ${JSON.stringify(args)}`)
    outputOf(outputs, reply, TRANSITION, key)
    return { ok: true }
  } catch (err) {
    return fail(err)
  } finally {
    cache.delete(key)
  }
}

export async function commentOnTicket(cwd: string, rawKey: string, body: string): Promise<TicketActionResult> {
  const key = normKey(rawKey)
  if (!body.trim()) return { error: 'The comment is empty.' }
  try {
    const args = { issueIdOrKey: key, commentBody: body, contentFormat: 'markdown' }
    const { outputs, reply } = await run(cwd, [COMMENT], `Then call ${COMMENT} with cloudId and these arguments (pass commentBody exactly as given, unchanged): ${JSON.stringify(args)}`)
    outputOf(outputs, reply, COMMENT, key)
    return { ok: true }
  } catch (err) {
    return fail(err)
  } finally {
    cache.delete(key)
  }
}

const SEARCH = T('searchJiraIssuesUsingJql')

export type IssueBrief = { key: string; summary: string; status: string; type?: string; url?: string; epic?: { key: string; summary: string } }

function briefOf(raw: unknown): IssueBrief | null {
  const issue = asRecord(raw)
  const f = asRecord(issue.fields)
  const key = str(issue.key)
  if (!key) return null
  const type = str(asRecord(f.issuetype).name)
  const parent = asRecord(f.parent)
  const pf = asRecord(parent.fields)
  // The parent is the epic in current Jira; an epic groups itself.
  const epic = type === 'Epic' ? { key, summary: str(f.summary) ?? key } : str(parent.key) ? { key: String(parent.key), summary: str(pf.summary) ?? String(parent.key) } : undefined
  return {
    key,
    summary: str(f.summary) ?? key,
    status: str(asRecord(f.status).name) ?? 'Unknown',
    type,
    url: str(issue.webUrl) ?? (site?.url ? `${site.url.replace(/\/$/, '')}/browse/${key}` : undefined),
    epic
  }
}

function issuesIn(text: string): unknown[] {
  const data = asRecord(JSON.parse(text))
  const nodes = asRecord(data.issues).nodes
  return Array.isArray(nodes) ? nodes : Array.isArray(data.issues) ? data.issues : data.key ? [data] : []
}

/**
 * Summary, status and epic for a set of ticket keys: one JQL search, or one lookup per key when
 * the search is refused (a single unknown key fails the whole `key in (...)` query).
 */
export async function findIssues(cwd: string, keys: string[]): Promise<{ issues: IssueBrief[]; error?: string }> {
  const list = [...new Set(keys.map(normKey))].slice(0, 40)
  if (!list.length) return { issues: [] }
  const fields = ['summary', 'status', 'issuetype', 'parent']
  try {
    const args = { jql: `key in (${list.join(',')})`, fields, maxResults: list.length }
    const { outputs, reply } = await run(cwd, [SEARCH], `Then call ${SEARCH} with cloudId and these arguments: ${JSON.stringify(args)}`)
    const issues = issuesIn(outputOf(outputs, reply, SEARCH, list[0])).map(briefOf).filter((x): x is IssueBrief => !!x)
    if (issues.length) return { issues }
  } catch (err) {
    if (err instanceof JiraError && err.message === CONNECT) return { issues: [], error: CONNECT }
  }
  const found: IssueBrief[] = []
  let error: string | undefined
  for (let i = 0; i < list.length; i += 6) {
    await Promise.all(
      list.slice(i, i + 6).map(async (key) => {
        try {
          const args = { issueIdOrKey: key, fields }
          const { outputs, reply } = await run(cwd, [GET_ISSUE], `Then call ${GET_ISSUE} with cloudId and these arguments: ${JSON.stringify(args)}`)
          const b = briefOf(issuesIn(outputOf(outputs, reply, GET_ISSUE, key))[0])
          if (b) found.push(b)
        } catch (err) {
          if (err instanceof JiraError && err.message === CONNECT) error = CONNECT
        }
      })
    )
    if (error) break
  }
  return { issues: found, error }
}
