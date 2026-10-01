import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * "! command" in the message box, as in the CLI: you run a shell command yourself, in the session's
 * folder. Output streams back as it comes; Claude sees the command and its output with your next
 * message. Bash (Git Bash on Windows, the shell the CLI's ! uses), else PowerShell.
 */

const running = new Map<string, ChildProcess>()

let found: { file: string; args: (cmd: string) => string[] } | undefined
function shell() {
  if (found) return found
  if (process.platform !== 'win32') return (found = { file: process.env.SHELL || '/bin/bash', args: (c) => ['-lc', c] })
  const candidates = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)']!, 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
  ]
  let bash = candidates.find((p) => p && existsSync(p))
  if (!bash) {
    try {
      // git.exe lives in Git\cmd; bash.exe is in Git\bin next to it.
      const git = execFileSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim()
      const guess = join(git, '..', '..', 'bin', 'bash.exe')
      if (existsSync(guess)) bash = guess
    } catch {
      /* no git on the path */
    }
  }
  found = bash ? { file: bash, args: (c) => ['-lc', c] } : { file: 'powershell.exe', args: (c) => ['-NoLogo', '-NoProfile', '-Command', c] }
  return found
}

export function runBang(id: string, cwd: string, command: string, emit: (e: { data?: string; exit?: number | null; error?: string }) => void) {
  const { file, args } = shell()
  let proc: ChildProcess
  try {
    proc = spawn(file, args(command), { cwd, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CHERE_INVOKING: '1' } })
  } catch (err) {
    emit({ error: String(err), exit: null })
    return
  }
  running.set(id, proc)
  const out = (b: Buffer) => emit({ data: b.toString('utf8') })
  proc.stdout?.on('data', out)
  proc.stderr?.on('data', out)
  proc.on('error', (err) => emit({ error: String(err) }))
  proc.on('close', (code) => {
    running.delete(id)
    emit({ exit: code })
  })
}

export function stopBang(id: string) {
  const p = running.get(id)
  if (!p?.pid) return
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true })
  else p.kill('SIGTERM')
}

export function stopAllBangs() {
  for (const id of [...running.keys()]) stopBang(id)
}
