import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, shell } from 'electron'
import { type Query } from '@anthropic-ai/claude-agent-sdk'
import { claudeExecutable, query } from './claude'
import type { AccountItem, AccountsResult } from '../shared/events'
import { tr } from '../shared/i18n'

/**
 * Everything Glassbox needs you signed in to, in one place: Claude, the GitHub CLI, and the
 * claude.ai connectors (Jira through Atlassian first). Status only; signing in happens in the
 * tool that owns the login (a terminal for the CLIs, claude.ai for connectors).
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

/** Open wherever that account signs in: a terminal for the Claude and GitHub CLIs, claude.ai for connectors. */
export async function signIn(id: string): Promise<void> {
  cached = null
  if (id === 'claude') return openTerminal(tr('mainAccounts.signInClaude'), claudeExe(), ['auth', 'login'])
  if (id === 'github') return openTerminal(tr('mainAccounts.signInGitHub'), 'gh', ['auth', 'login', '--web', '--hostname', 'github.com'])
  if (id === 'github-install') return void shell.openExternal('https://cli.github.com')
  if (id.startsWith('connector:')) return void shell.openExternal(CONNECTORS_URL)
}

function openTerminal(title: string, file: string, args: string[]) {
  const q = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s)
  if (process.platform === 'win32') {
    // A visible console, left open so any code the login shows can be read.
    spawn('cmd.exe', ['/c', 'start', `"${title}"`, 'cmd', '/k', [file, ...args].map(q).join(' ')], { detached: true, windowsVerbatimArguments: true, stdio: 'ignore' }).unref()
  } else if (process.platform === 'darwin') {
    // A Terminal window, so the sign-in code and prompts can be seen (spawning it hidden shows nothing).
    const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
    const command = [file, ...args].map(sh).join(' ')
    const apple = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    spawn('osascript', ['-e', `tell application "Terminal" to do script "${apple}"`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref()
  } else {
    spawn(file, args, { detached: true, stdio: 'ignore' }).unref()
  }
}
