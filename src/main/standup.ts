import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { getSessionMessages, listSessions, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { query } from './claude'
import { findIssues, type IssueBrief } from './jira'
import type { Standup, StandupGroup } from '../shared/events'
import { tr } from '../shared/i18n'

/**
 * The morning stand-up: what you did on the last working day, grouped by Jira epic.
 *
 * Gathered from what's already on this machine (Claude sessions that ran that day and your own
 * commits in their repos), with each ticket's epic looked up through the Atlassian connector.
 * One Sonnet call then writes it up; it only words the bullets, the grouping comes from Jira.
 */

const run = promisify(execFile)
const KEY = /(?<![A-Z0-9])([A-Z][A-Z0-9]+-\d+)(?!\d)/g
const OTHER = tr('mainStandup.otherWork')

type Work = { key: string | null; repo: string; commits: string[]; sessions: { title: string; asks: string[]; outcome?: string }[] }

/** The last working day: yesterday, or Friday (through the weekend) on a Monday or at the weekend. */
export function workingWindow(now = new Date()): { from: Date; to: Date; label: string } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dow = today.getDay()
  // Monday and Sunday reach back to Friday and take in the weekend; Saturday is just Friday.
  const back = dow === 1 ? 3 : dow === 0 ? 2 : 1
  const from = new Date(today)
  from.setDate(today.getDate() - back)
  const to = today
  const weekend = dow === 1 || dow === 0
  const day = from.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
  return { from, to, label: weekend ? tr('mainStandup.since', { day }) : tr('mainStandup.yesterday', { day }) }
}

const keysIn = (s: string | undefined) => [...(s ?? '').matchAll(KEY)].map((m) => m[1].toUpperCase())
const git = async (cwd: string, args: string[]) => (await run('git', ['-C', cwd, ...args], { maxBuffer: 8 * 1024 * 1024, windowsHide: true })).stdout.trim()

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c) => (c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? String((c as { text?: string }).text ?? '') : '')).join('\n')
      : ''

/** What happened in one Claude session inside the window: your asks and how it ended. */
async function sessionWork(id: string, from: number, to: number) {
  const msgs = await getSessionMessages(id).catch(() => [])
  const asks: string[] = []
  let outcome: string | undefined
  for (const m of msgs) {
    const t = Date.parse((m as { timestamp?: string }).timestamp ?? '')
    if (!(t >= from && t < to) || m.parent_tool_use_id) continue
    const text = textOf((m.message as { content?: unknown })?.content).trim()
    if (!text) continue
    if (m.type === 'user') {
      if (text.startsWith('<') || text.startsWith('Caveat:') || text.startsWith('[Request interrupted')) continue
      asks.push(text.replace(/\s+/g, ' ').slice(0, 280))
    } else if (m.type === 'assistant') outcome = text.replace(/\s+/g, ' ').slice(0, 500)
  }
  return { asks: asks.slice(0, 8), outcome }
}

async function gather(from: Date, to: Date) {
  const f = from.getTime(), t = to.getTime()
  const all = await listSessions({ limit: 400 }).catch(() => [])
  // Throwaway sessions in the temp folder (scratch repos, tests) aren't work to report.
  const slash = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  const temp = slash(tmpdir())
  const scratch = (cwd?: string) => !!cwd && slash(cwd).startsWith(temp)
  const inWindow = all.filter((s) => s.lastModified >= f && (s.createdAt ?? 0) < t && !scratch(s.cwd)).slice(0, 40)
  const work = new Map<string, Work>()
  const bucket = (key: string | null, repo: string) => {
    const id = key ?? `repo:${repo}`
    let w = work.get(id)
    if (!w) work.set(id, (w = { key, repo, commits: [], sessions: [] }))
    return w
  }

  // Sessions, by the ticket in their branch (or failing that, the first ticket they mention).
  const repos = new Set<string>()
  for (const s of inWindow) {
    const { asks, outcome } = await sessionWork(s.sessionId, f, t)
    if (!asks.length) continue
    const cwd = s.cwd ?? ''
    const root = cwd ? await git(cwd, ['rev-parse', '--show-toplevel']).catch(() => cwd) : ''
    if (root) repos.add(root)
    const key = keysIn(s.gitBranch)[0] ?? keysIn(asks.join(' '))[0] ?? null
    bucket(key, root ? basename(root) : tr('mainStandup.noProject')).sessions.push({ title: s.customTitle ?? s.summary, asks, outcome })
  }

  // Your commits in those repos, by the ticket in the branch they were made on or their message.
  for (const root of repos) {
    const email = await git(root, ['config', 'user.email']).catch(() => '')
    const log = await git(root, ['log', '--all', '--source', '--no-merges', `--since=${from.toISOString()}`, `--until=${to.toISOString()}`, ...(email ? [`--author=${email}`] : []), '--format=%s%x1f%S']).catch(() => '')
    for (const line of log.split('\n').filter(Boolean)) {
      const [subject, ref] = line.split('\x1f')
      const key = keysIn(ref)[0] ?? keysIn(subject)[0] ?? null
      const w = bucket(key, basename(root))
      if (!w.commits.includes(subject)) w.commits.push(subject)
    }
  }
  return { work: [...work.values()], sessions: inWindow.length, repos: [...repos] }
}

/** Ask Sonnet to word it: one short bullet per ticket (or per repo for untracked work). */
async function writeUp(items: (Work & { issue?: IssueBrief })[], label: string): Promise<Record<string, string>> {
  const input = items.map((w, i) => ({
    id: String(i),
    ticket: w.issue ? `${w.issue.key}: ${w.issue.summary} (${w.issue.status})` : w.key ?? undefined,
    repo: w.repo,
    commits: w.commits.slice(0, 12),
    sessions: w.sessions.map((s) => ({ title: s.title, asked: s.asks, lastReply: s.outcome }))
  }))
  const prompt = `This is what a developer worked on (${label}), gathered from their Claude Code sessions and git commits. Write their stand-up update: for each item, one bullet in the first person, past tense, saying what they actually got done or moved forward (not what they asked for). Plain words a teammate understands, at most 25 words, no ticket keys, no filler like "worked on". If an item has nothing concrete, say briefly what they looked into.\n\nReply with only JSON: {"<id>": "<bullet>", ...}\n\n${JSON.stringify(input)}`
  let out = ''
  for await (const msg of query({
    prompt,
    options: { model: 'sonnet', tools: [], settingSources: [], persistSession: false, maxTurns: 1, thinking: { type: 'disabled' }, systemPrompt: 'You write concise stand-up updates. Reply with JSON only.', cwd: homedir() }
  }) as AsyncIterable<SDKMessage>) {
    if (msg.type === 'result' && msg.subtype === 'success') out = msg.result
  }
  const body = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)
  try {
    return JSON.parse(body) as Record<string, string>
  } catch {
    return {}
  }
}

export async function getStandup(dir: string, force = false): Promise<Standup> {
  const { from, to, label } = workingWindow()
  const file = join(dir, 'standup.json')
  if (!force) {
    try {
      const hit = JSON.parse(readFileSync(file, 'utf8')) as Standup
      if (hit.from === from.toISOString()) return hit
    } catch {
      /* none yet */
    }
  }
  try {
    const { work, sessions, repos } = await gather(from, to)
    const keys = work.map((w) => w.key).filter((k): k is string => !!k)
    const { issues, error: jiraError } = await findIssues(repos[0] ?? homedir(), keys).catch((e) => ({ issues: [] as IssueBrief[], error: String(e) }))
    const byKey = new Map(issues.map((i) => [i.key, i]))
    const items = work.map((w) => ({ ...w, issue: w.key ? byKey.get(w.key) : undefined }))
    const words = items.length ? await writeUp(items, label) : {}

    // Without Jira there are no epics to group by: group by project instead, so it still reads well.
    const byRepo = !!jiraError && !issues.length
    const groups = new Map<string, StandupGroup>()
    items.forEach((w, i) => {
      const epic = w.issue?.epic
      const id = byRepo ? `repo:${w.repo}` : epic?.key ?? OTHER
      let g = groups.get(id)
      if (!g) groups.set(id, (g = byRepo ? { epic: basename(w.repo) || OTHER, items: [] } : { epic: epic ? epic.summary : OTHER, epicKey: epic?.key, url: epic && w.issue?.url ? w.issue.url.replace(/[^/]+$/, epic.key) : undefined, items: [] }))
      const fallback = w.commits[0] ?? w.sessions[0]?.title ?? w.issue?.summary ?? tr('mainStandup.workedOnThis')
      g.items.push({ text: words[String(i)] ?? fallback, ticket: w.issue ? { key: w.issue.key, summary: w.issue.summary, status: w.issue.status, url: w.issue.url } : w.key ? { key: w.key } : undefined, repo: w.repo })
    })
    // Epics first (largest first), untracked work last.
    const ordered = [...groups.values()].sort((a, b) => Number(a.epic === OTHER) - Number(b.epic === OTHER) || b.items.length - a.items.length)
    const result: Standup = { from: from.toISOString(), to: to.toISOString(), label, groups: ordered, sessions, commits: work.reduce((n, w) => n + w.commits.length, 0), jiraError, groupedBy: byRepo ? 'repo' : 'epic', generatedAt: Date.now() }
    // Without Jira it isn't kept: the next time you open it (say, after connecting Jira) it tries again.
    if (!jiraError)
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(file, JSON.stringify(result))
      } catch {
        /* not cached; still shown */
      }
    return result
  } catch (err) {
    return { from: from.toISOString(), to: to.toISOString(), label, groups: [], sessions: 0, commits: 0, generatedAt: Date.now(), error: err instanceof Error ? err.message : String(err) }
  }
}
