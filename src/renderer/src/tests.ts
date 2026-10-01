import { CHANGE_TOOLS, isClaudeOwnFile, type SessionState, type ToolCall } from './session'

/** A test run Claude did, read from its command and output. */
export type TestRun = {
  toolId: string
  at: number
  command: string
  passed: number
  failed: number
  skipped: number
  /** Names of failing tests, where the runner prints them. */
  failures: string[]
  ok: boolean
  /** Edits made since the previous test run (the likely cause when it goes red). */
  editsSince: string[]
}

const SHELL = new Set(['Bash', 'PowerShell'])
const TEST_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(vitest|jest|mocha|ava|playwright\s+test|cypress\s+run)\b|\bdotnet\s+test\b|\bpytest\b|python\s+-m\s+(pytest|unittest)\b|\bgo\s+test\b|\bcargo\s+test\b|\b(mvn|mvnw|gradle|gradlew)\b.*\btest\b|\bnode\s+--test\b|\brspec\b|\bphpunit\b/i

const num = (s: string | undefined) => (s ? Number(s) : 0)

/** Pass/fail counts from the summary lines of common test runners. */
function counts(out: string): { passed: number; failed: number; skipped: number } | null {
  const full = out.replace(/\x1b\[[0-9;]*m/g, '')
  // A command can run the tests more than once (a failing run, then a fixed one): read the last.
  const lastRun = (re: RegExp) => {
    const all = [...full.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))]
    return all.at(-1) ?? null
  }
  const starts = [/Tests:\s+.*?\d+ total/, /Tests\s+(?:\d+ \w+(?: \| )?)+\s*\(\d+\)/, /ℹ tests \d+/, /# tests \d+/, /=+ .*? in [\d.]+s/].map((re) => lastRun(re)?.index ?? -1)
  // Summaries come at the end of a run; cut the text back to the start of the last run's output.
  const lastStart = Math.max(...starts)
  const prevEnd = lastStart > 0 ? Math.max(...[/Tests:\s+.*?\d+ total/g, /ℹ duration_ms [\d.]+/g, /# duration_ms [\d.]+/g, /=+ .*? in [\d.]+s =*/g].map((re) => [...full.slice(0, lastStart).matchAll(re)].at(-1)).map((m) => (m ? m.index! + m[0].length : 0))) : 0
  const text = full.slice(prevEnd)
  let m: RegExpMatchArray | null
  // Jest: "Tests:       2 failed, 1 skipped, 10 passed, 13 total"
  if ((m = text.match(/Tests:\s+(.*?)(\d+) total/)))
    return { failed: num(m[1].match(/(\d+) failed/)?.[1]), skipped: num(m[1].match(/(\d+) (?:skipped|todo)/)?.[1]), passed: num(m[1].match(/(\d+) passed/)?.[1]) }
  // Vitest: "Tests  2 failed | 10 passed (12)"
  if ((m = text.match(/Tests\s+((?:\d+ \w+(?: \| )?)+)\s*\(\d+\)/)))
    return { failed: num(m[1].match(/(\d+) failed/)?.[1]), skipped: num(m[1].match(/(\d+) (?:skipped|todo)/)?.[1]), passed: num(m[1].match(/(\d+) passed/)?.[1]) }
  // dotnet test: "Failed!  - Failed:     2, Passed:    10, Skipped:     0, Total:    12" (one line per project)
  const dotnet = [...text.matchAll(/(?:Passed|Failed)!\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+)/g)]
  if (dotnet.length) return dotnet.reduce((a, d) => ({ failed: a.failed + num(d[1]), passed: a.passed + num(d[2]), skipped: a.skipped + num(d[3]) }), { failed: 0, passed: 0, skipped: 0 })
  // pytest: "=== 2 failed, 10 passed, 1 skipped in 1.2s ==="
  if ((m = text.match(/=+ (.*?(?:passed|failed|error).*?) in [\d.]+s/)))
    return { failed: num(m[1].match(/(\d+) failed/)?.[1]) + num(m[1].match(/(\d+) errors?/)?.[1]), skipped: num(m[1].match(/(\d+) skipped/)?.[1]), passed: num(m[1].match(/(\d+) passed/)?.[1]) }
  // node --test, spec reporter (the default): "ℹ pass 10" "ℹ fail 2"
  if ((m = text.match(/ℹ pass (\d+)/))) return { passed: num(m[1]), failed: num(text.match(/ℹ fail (\d+)/)?.[1]), skipped: num(text.match(/ℹ skipped (\d+)/)?.[1]) + num(text.match(/ℹ todo (\d+)/)?.[1]) }
  // node --test / TAP: "# pass 10" "# fail 2"
  if ((m = text.match(/# pass (\d+)/))) return { passed: num(m[1]), failed: num(text.match(/# fail (\d+)/)?.[1]), skipped: num(text.match(/# skip (\d+)/)?.[1]) }
  // Mocha: "10 passing", "2 failing"
  if ((m = text.match(/(\d+) passing/))) return { passed: num(m[1]), failed: num(text.match(/(\d+) failing/)?.[1]), skipped: num(text.match(/(\d+) pending/)?.[1]) }
  // cargo: "test result: FAILED. 10 passed; 2 failed; 0 ignored"
  if ((m = text.match(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/))) return { passed: num(m[1]), failed: num(m[2]), skipped: num(m[3]) }
  // go test: count "--- PASS" / "--- FAIL" lines
  const goPass = (text.match(/^\s*--- PASS/gm) ?? []).length
  const goFail = (text.match(/^\s*--- FAIL/gm) ?? []).length
  if (goPass || goFail) return { passed: goPass, failed: goFail, skipped: (text.match(/^\s*--- SKIP/gm) ?? []).length }
  return null
}

/** Names of failing tests from the runner's output (first few). */
function failureNames(out: string): string[] {
  const text = out.replace(/\x1b\[[0-9;]*m/g, '')
  const names = new Set<string>()
  const add = (s: string | undefined) => s && names.size < 12 && names.add(s.trim())
  for (const m of text.matchAll(/^\s*●\s+(.+?)\s*$/gm)) if (!/Console|Test suite failed/.test(m[1])) add(m[1]) // jest
  for (const m of text.matchAll(/^\s*(?:×|✗|❯|FAIL)\s+(\S+\.(?:test|spec)\.\w+\s*>\s*.+?)\s*(?:\d+ms)?$/gm)) add(m[1]) // vitest
  for (const m of text.matchAll(/^\s*Failed\s+([\w.<>`,[\]]+)\s*\[/gm)) add(m[1]) // dotnet
  for (const m of text.matchAll(/^FAILED\s+(\S+)/gm)) add(m[1]) // pytest
  for (const m of text.matchAll(/^\s*--- FAIL: (\S+)/gm)) add(m[1]) // go
  for (const m of text.matchAll(/^not ok \d+ - (.+)$/gm)) add(m[1]) // TAP
  for (const m of text.matchAll(/^\s*✖ (.+?)(?: \([\d.]+m?s\))?$/gm)) if (!/^failing tests:?$/i.test(m[1])) add(m[1]) // node --test (spec)
  return [...names]
}

/**
 * The part of a shell command that's actually run: heredoc bodies and long quoted strings are
 * dropped, so a script that merely contains "npm test" (e.g. writing a README) isn't a test run.
 */
function commandHead(cmd: string): string {
  return cmd.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\s*\1\b/g, '<<heredoc').replace(/(["'])(?:(?!\1)[\s\S]){60,}?\1/g, '""')
}

export const isTestCall = (c: ToolCall) => SHELL.has(c.name) && TEST_COMMAND.test(commandHead(String(c.input.command ?? '')))

/** Every test run in the session, oldest first, each with the edits made since the one before. */
export function testRuns(s: SessionState): TestRun[] {
  const calls = Object.values(s.toolCalls)
    .filter((c) => c.status !== 'running' && isTestCall(c))
    .sort((a, b) => a.at - b.at)
  const edits = s.files.filter((f) => CHANGE_TOOLS.has(f.tool) && !isClaudeOwnFile(f.path) && s.toolCalls[f.toolId]?.status !== 'error')
  const runs: TestRun[] = []
  let prevAt = 0
  for (const c of calls) {
    const out = c.result ?? ''
    const n = counts(out)
    // When the last run in the output passed, earlier failures in the same command were fixed.
    const failures = n && n.failed === 0 ? [] : failureNames(out)
    const failed = n?.failed ?? (c.status === 'error' ? Math.max(1, failures.length) : failures.length)
    const passed = n?.passed ?? 0
    // A run with no recognisable summary that errored still counts as red.
    if (!n && c.status !== 'error' && !failures.length && !/pass|ok\b|✓/i.test(out)) {
      prevAt = c.at
      continue
    }
    const since = [...new Set(edits.filter((e) => e.at > prevAt && e.at < c.at).map((e) => e.path))]
    runs.push({ toolId: c.id, at: c.at, command: String(c.input.command ?? ''), passed, failed, skipped: n?.skipped ?? 0, failures, ok: failed === 0 && c.status !== 'error', editsSince: since })
    prevAt = c.at
  }
  return runs
}

/** Files edited after the last test run: changes the tests haven't seen yet. */
export function untestedEdits(s: SessionState, runs: TestRun[]): string[] {
  const last = runs.at(-1)
  if (!last) return []
  return [...new Set(s.files.filter((f) => CHANGE_TOOLS.has(f.tool) && !isClaudeOwnFile(f.path) && f.at > last.at).map((f) => f.path))]
}

export const runSummary = (r: TestRun) =>
  r.ok ? `${r.passed} passed${r.skipped ? `, ${r.skipped} skipped` : ''}` : `${r.failed} failed${r.passed ? `, ${r.passed} passed` : ''}`
