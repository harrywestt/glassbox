import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, shell } from 'electron'
import { type Query } from '@anthropic-ai/claude-agent-sdk'
import { claudeExecutable, query } from './claude'
import type { AccountItem, AccountsResult, SignInState } from '../shared/events'
import { tr } from '../shared/i18n'

/**
 * Everything Glassbox needs you signed in to, in one place: Claude, the GitHub CLI, and the
 * claude.ai connectors (Jira through Atlassian first), and signing in to each.
 */

const CONNECTORS_URL = 'https://claude.ai/settings/connectors'
const CACHE_MS = 5 * 60_000
let cached: { at: number; result: AccountsResult } | null = null
let inflight: Promise<AccountsResult> | null = null

/** The Claude CLI bundled with the SDK, or `claude` on PATH. */
function claudeExe(): string {
  return claudeExecutable() ?? 'claude'
}

const run = (file: string, args: string[], timeout = 15_000) =>
  new Promise<{ code: number; out: string; err: string; missing?: boolean }>((resolve) =>
    execFile(file, args, { timeout, windowsHide: true }, (e, out, err) =>
      resolve({ code: e ? (typeof (e as NodeJS.ErrnoException).code === 'number' ? Number((e as NodeJS.ErrnoException).code) : 1) : 0, out: String(out), err: String(err), missing: (e as NodeJS.ErrnoException | null)?.code === 'ENOENT' })
    )
  )

async function claudeStatus(): Promise<AccountItem> {
  const r = await run(claudeExe(), ['auth', 'status', '--json'])
  try {
    const j = JSON.parse(r.out) as { loggedIn?: boolean; email?: string; orgName?: string; subscriptionType?: string }
    if (j.loggedIn) return { id: 'claude', name: 'Claude', kind: 'claude', status: 'ok', detail: [j.email, j.orgName].filter(Boolean).join(', ') }
  } catch {
    /* not JSON: treat as signed out */
  }
  return { id: 'claude', name: 'Claude', kind: 'claude', status: 'signin', detail: tr('mainAccounts.notSignedIn') }
}

async function githubStatus(): Promise<AccountItem> {
  const r = await run('gh', ['auth', 'status', '--hostname', 'github.com'])
  if (r.missing) return { id: 'github', name: 'GitHub', kind: 'github', status: 'missing', detail: tr('mainAccounts.ghMissing') }
  const user = (r.out + r.err).match(/account\s+(\S+)/)?.[1]
  if (r.code === 0) return { id: 'github', name: 'GitHub', kind: 'github', status: 'ok', detail: user }
  return { id: 'github', name: 'GitHub', kind: 'github', status: 'signin', detail: tr('mainAccounts.notSignedIn') }
}

/** The claude.ai connectors and whether each is connected, read from an idle (model-free) query. */
async function connectorStatus(): Promise<AccountItem[]> {
  let stop!: () => void
  const idle: AsyncIterable<never> = { async *[Symbol.asyncIterator]() { await new Promise<void>((r) => (stop = r)) } }
  const q: Query = query({ prompt: idle, options: { cwd: app.getPath('home'), model: 'haiku', tools: [], settingSources: ['user'], persistSession: false } })
  try {
    const deadline = Date.now() + 20_000
    let servers: Awaited<ReturnType<Query['mcpServerStatus']>> = []
    while (Date.now() < deadline) {
      servers = await q.mcpServerStatus()
      const cloud = servers.filter((s) => s.source === 'claudeai')
      if (cloud.length && cloud.every((s) => s.status !== 'pending')) break
      await new Promise((r) => setTimeout(r, 300))
    }
    const items = servers
      .filter((s) => s.source === 'claudeai' || s.status === 'needs-auth')
      .map((s): AccountItem => {
        const name = s.name.replace(/^claude\.ai\s+/i, '')
        const jira = /atlassian/i.test(name)
        const status = s.status === 'connected' ? 'ok' : s.status === 'needs-auth' ? 'signin' : s.status === 'failed' ? 'error' : 'signin'
        return { id: `connector:${s.name}`, name: jira ? tr('mainAccounts.jiraName') : name, kind: 'connector', status, detail: status === 'ok' ? tr('mainAccounts.connected') : status === 'error' ? tr('mainAccounts.couldNotConnect') : tr('mainAccounts.needsSignIn') }
      })
    // Jira first (the Ticket tab needs it), then anything needing attention, then the rest by name.
    const rank = (a: AccountItem) => (/jira/i.test(a.name) ? 0 : a.status === 'ok' ? 2 : 1)
    return items.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  } catch {
    return []
  } finally {
    stop?.()
    q.close()
  }
}

export function getAccounts(force = false): Promise<AccountsResult> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.result)
  if (inflight) return inflight
  inflight = Promise.all([claudeStatus(), githubStatus(), connectorStatus()])
    .then(([c, g, conns]) => {
      const result: AccountsResult = { items: [c, g, ...conns], at: Date.now() }
      cached = { at: Date.now(), result }
      return result
    })
    .finally(() => (inflight = null))
  return inflight
}

/**
 * Signing in, inside Glassbox: the Claude and GitHub CLIs run here (with Glassbox's own PATH, so it
 * works without a terminal set up for them), and what they say comes back to the Accounts panel: the
 * page to open, the one-time code to enter there, and a box for a code the page hands back. Connectors
 * sign in on claude.ai.
 */
const signIns = new Map<string, { child: ChildProcess; state: SignInState }>()

export function signIn(id: string, send: (s: SignInState) => void): void {
  cached = null
  if (id === 'github-install') return void shell.openExternal('https://cli.github.com')
  if (id.startsWith('connector:')) return void shell.openExternal(CONNECTORS_URL)
  if (id !== 'claude' && id !== 'github') return
  signIns.get(id)?.child.kill()
  const [file, args] = id === 'claude' ? [claudeExe(), ['auth', 'login']] : ['gh', ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https']]
  const state: SignInState = { id, status: 'running', lines: [] }
  const update = (patch: Partial<SignInState>) => {
    Object.assign(state, patch)
    send({ ...state, lines: [...state.lines] })
  }
  // No terminal, so the CLIs don't wait for keys only a terminal has (gh's "press Enter").
  const child = spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', FORCE_COLOR: '0' } })
  signIns.set(id, { child, state })
  const read = (chunk: Buffer) => {
    const text = clean(chunk.toString('utf8'))
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    if (!lines.length) return
    const all = [...state.lines, ...lines].slice(-40)
    const joined = all.join('\n')
    const url = joined.match(/https:\/\/[^\s'"<>]+/g)?.pop() ?? state.url
    const code = joined.match(/one-time code\W*([A-Z0-9]{4}-[A-Z0-9]{4})/i)?.[1] ?? state.code
    // The CLI waits for a code pasted from the page (Claude's "Paste code here if prompted").
    const asksForCode = state.asksForCode || /paste code/i.test(joined)
    update({ lines: all, url, code, asksForCode })
  }
  child.stdout?.on('data', read)
  child.stderr?.on('data', read)
  child.on('error', (e) => update({ status: 'failed', error: (e as NodeJS.ErrnoException).code === 'ENOENT' ? tr('mainAccounts.cliMissing', { name: id === 'claude' ? 'Claude' : 'GitHub CLI (gh)' }) : e.message }))
  child.on('exit', (code) => {
    signIns.delete(id)
    cached = null
    if (state.status === 'running') update({ status: code === 0 ? 'done' : 'failed', error: code === 0 ? undefined : state.lines.slice(-2).join(' ') || tr('mainAccounts.signInFailed') })
  })
  // A sign-in left waiting gives up after a while, rather than running for ever.
  setTimeout(() => signIns.get(id)?.child === child && (child.kill(), update({ status: 'failed', error: tr('mainAccounts.signInTimedOut') })), 10 * 60_000)
}

/** A line typed into the sign-in (the code a sign-in page hands back). */
export function signInInput(id: string, text: string) {
  signIns.get(id)?.child.stdin?.write(`${text.trim()}\n`)
}

export function signInCancel(id: string) {
  const s = signIns.get(id)
  if (!s) return
  signIns.delete(id)
  s.child.kill()
}

/** Terminal colours and links (OSC 8) taken out, so the text and addresses read cleanly. */
function clean(s: string): string {
  return s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
}
