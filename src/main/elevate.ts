import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TIMEOUT_MS = 10 * 60_000
const MAX_OUTPUT = 30_000

const q = (s: string) => `'${s.replace(/'/g, "''")}'`

/** The PowerShell script that runs the command and writes its output and exit code to files. */
export function buildScript(cwd: string, command: string, out: string, code: string): string {
  return [
    "$ErrorActionPreference = 'Continue'",
    `Set-Location -LiteralPath ${q(cwd)}`,
    '$global:LASTEXITCODE = 0',
    '$errorsBefore = $Error.Count',
    'try {',
    `  & { ${command} } *>&1 | Out-String -Width 4096 | Set-Content -LiteralPath ${q(out)} -Encoding utf8`,
    // A native command's exit code, else 1 if PowerShell reported any error.
    '  $c = if ($global:LASTEXITCODE) { $global:LASTEXITCODE } elseif ($Error.Count -gt $errorsBefore) { 1 } else { 0 }',
    '} catch {',
    `  $_ | Out-String | Add-Content -LiteralPath ${q(out)} -Encoding utf8`,
    '  $c = 1',
    '}',
    `Set-Content -LiteralPath ${q(code)} -Value $c`
  ].join('\r\n')
}

/**
 * Runs one PowerShell command with administrator rights, through the normal Windows prompt (UAC).
 * On a standard account that prompt asks for an administrator's password and the command runs as
 * that account; everything else (Claude, gh, git) stays signed in as you. Output and exit code come
 * back through a temporary folder.
 */
export async function runElevated(cwd: string, command: string): Promise<{ output: string; exitCode: number | null; declined?: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), 'glassbox-admin-'))
  const script = join(dir, 'run.ps1')
  const out = join(dir, 'out.txt')
  const code = join(dir, 'code.txt')
  writeFileSync(script, buildScript(cwd, command, out, code), { encoding: 'utf8' })
  try {
    const launched = await new Promise<boolean>((done) =>
      execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${q(`"${script}"`)}`],
        { windowsHide: true, timeout: TIMEOUT_MS },
        (err) => done(!err)
      )
    )
    const read = (f: string) => {
      try {
        return readFileSync(f, 'utf8').replace(/^﻿/, '')
      } catch {
        return null
      }
    }
    const exit = read(code)
    if (!launched && exit === null) return { output: '', exitCode: null, declined: true }
    const text = read(out) ?? ''
    return { output: text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… (output truncated)` : text, exitCode: exit === null ? null : Number(exit.trim()) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
