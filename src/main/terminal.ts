import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { IPty } from 'node-pty'

/**
 * Terminals you run your own commands in, one or more per session, each a real shell (PowerShell
 * on Windows, your login shell elsewhere) in the session's folder. Output streams to the renderer;
 * shells close with their session.
 */

type Term = { pty: IPty; scope: string }
const terms = new Map<string, Term>()
let nextId = 1

function shell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const pwsh = [process.env.ProgramFiles && join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe')].find((p) => p && existsSync(p))
    return { file: pwsh ?? 'powershell.exe', args: ['-NoLogo'] }
  }
  return { file: process.env.SHELL || '/bin/bash', args: ['-l'] }
}

export async function openTerminal(scope: string, cwd: string, cols: number, rows: number, send: (channel: string, payload: unknown) => void): Promise<string> {
  const { spawn } = await import('node-pty')
  const { file, args } = shell()
  const id = `t${nextId++}`
  const pty = spawn(file, args, {
    name: 'xterm-256color',
    cols: Math.max(20, cols),
    rows: Math.max(4, rows),
    cwd: existsSync(cwd) ? cwd : process.cwd(),
    env: { ...process.env, TERM_PROGRAM: 'Glassbox' } as Record<string, string>,
    useConpty: true
  })
  terms.set(id, { pty, scope })
  pty.onData((data) => send('glassbox:terminal', { id, data }))
  pty.onExit(({ exitCode }) => {
    terms.delete(id)
    send('glassbox:terminal', { id, exit: exitCode })
  })
  return id
}

export function writeTerminal(id: string, data: string) {
  terms.get(id)?.pty.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  try {
    terms.get(id)?.pty.resize(Math.max(20, cols), Math.max(4, rows))
  } catch {
    /* the shell already exited */
  }
}

export function closeTerminal(id: string) {
  const t = terms.get(id)
  if (!t) return
  terms.delete(id)
  try {
    t.pty.kill()
  } catch {
    /* already gone */
  }
}

/** A session closed (or Glassbox is quitting): its shells go with it. */
export function closeTerminals(scope?: string) {
  for (const [id, t] of terms) if (!scope || t.scope === scope) closeTerminal(id)
}
