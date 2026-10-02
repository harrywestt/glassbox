import { useEffect, useState } from 'react'
import { DEFAULT_GUARDRAILS } from '../../shared/guardrails'
import type { GuardAction, GuardRule } from '../../shared/events'
import type { CommentTarget, SessionState, ToolCall } from './session'
import { toolSummary } from './session'
import { baseName } from './lib'
import { tr } from '../../shared/i18n'

/** Short label for what a comment is about, for the timeline and chips. */
export function targetLabel(t: CommentTarget): string {
  switch (t.kind) {
    case 'code':
      return t.startLine === t.endLine ? tr('review.codeLine', { file: baseName(t.path), line: t.startLine }) : tr('review.codeLines', { file: baseName(t.path), start: t.startLine, end: t.endLine })
    case 'tool':
      return t.label
    case 'decision':
      return t.title
    case 'questions':
      return tr('review.questions', { count: t.titles.length })
    case 'step':
      return tr('review.step', { label: t.label })
    case 'message':
      return tr('review.message', { excerpt: `${t.excerpt.slice(0, 60)}${t.excerpt.length > 60 ? '…' : ''}` })
    case 'plan':
      return tr('review.plan')
  }
}

/** The message Claude receives for a review comment. Sent with priority 'now' so it lands mid-turn. */
export function commentPrompt(t: CommentTarget, text: string): string {
  // One reply to several questions: Claude is told they were answered together, so it doesn't
  // take the whole reply as the answer to only the first.
  if (t.kind === 'questions')
    return `Answers from the user (sent from Glassbox) to your open questions:\n${t.titles.map((q, i) => `${i + 1}. "${q}"`).join('\n')}\n\nTheir answer, covering all of them:\n${text.trim()}\n\nWork out which part answers which question and act on each. If a question is still unanswered, say which and log it again as a question.`
  let about: string
  switch (t.kind) {
    case 'code':
      about = `${t.path}, ${t.startLine === t.endLine ? `line ${t.startLine}` : `lines ${t.startLine}-${t.endLine}`}:\n\`\`\`\n${t.snippet}\n\`\`\``
      break
    case 'tool':
      about = `your tool call "${t.label}"`
      break
    case 'decision':
      about = `what you logged: "${t.title}"`
      break
    case 'step':
      about = `the plan step "${t.label}"`
      break
    case 'message':
      about = `this part of your message: "${t.excerpt}"`
      break
    case 'plan':
      about = 'your plan'
  }
  return `Review comment from the user (sent from Glassbox while you work) on ${about}\n\n${text.trim()}\n\nTake this into account now: adjust your approach if needed and say briefly how you're handling it, then carry on.`
}

export const toolTarget = (call: ToolCall): CommentTarget => ({ kind: 'tool', toolId: call.id, label: `${call.name}: ${toolSummary(call).slice(0, 80)}` })

// ── Guardrail settings (app-wide, persisted locally) ──

const KEY = 'glassbox.guardrails'
const EVENT = 'glassbox:guardrails'

function load(): GuardRule[] {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { overrides: Record<string, GuardAction>; custom: GuardRule[] } | null
    if (saved) return [...DEFAULT_GUARDRAILS.map((r) => ({ ...r, action: saved.overrides[r.id] ?? r.action })), ...saved.custom]
  } catch {
    /* fall back to defaults */
  }
  return DEFAULT_GUARDRAILS
}

export function saveGuardrails(rules: GuardRule[]) {
  const overrides = Object.fromEntries(rules.filter((r) => r.builtin).map((r) => [r.id, r.action]))
  try {
    localStorage.setItem(KEY, JSON.stringify({ overrides, custom: rules.filter((r) => !r.builtin) }))
  } catch {
    /* not persisted this time */
  }
  window.dispatchEvent(new CustomEvent(EVENT))
}

export function useGuardrails(): GuardRule[] {
  const [rules, setRules] = useState(load)
  useEffect(() => {
    const update = () => setRules(load())
    window.addEventListener(EVENT, update)
    return () => window.removeEventListener(EVENT, update)
  }, [])
  return rules
}

// ── Side effects: what a tool call does to the world outside the conversation ──

export type Risk = 'high' | 'medium' | 'low'
export type SideEffect = { call: ToolCall; category: string; risk: Risk; detail: string }

const SHELL_RULES: [RegExp, string, Risk][] = [
  [/\bterraform\s+(apply|destroy)|\bkubectl\s+(apply|delete)|\b(aws|az|gcloud)\s+\S+\s+(create|delete|update|put|deploy)/i, tr('review.category.infrastructure'), 'high'],
  [/\bgit\s+push\b.*(--force|-f\b)|\bgit\s+(reset\s+--hard|clean\s+-f|branch\s+-D)/i, tr('review.category.gitHistory'), 'high'],
  [/\b(drop|truncate|delete\s+from|update\s+\w+\s+set)\b/i, tr('review.category.databaseWrite'), 'high'],
  [/\brm\s+-\w*r|\bRemove-Item\b.*-Recurse|\brd\s+\/s|\bdel\s+\/s/i, tr('review.category.deleteFiles'), 'high'],
  [/\bgit\s+(push|commit|merge|rebase|checkout|switch|stash|tag|cherry-pick)\b/i, tr('review.category.git'), 'medium'],
  [/\bgh\s+(pr|issue|release|workflow)\s+(create|merge|close|edit|comment|run)/i, tr('review.category.gitHub'), 'medium'],
  [/\b(npm|pnpm|yarn)\s+(i|install|add|remove|uninstall)\b|\bpip\s+install|\bdotnet\s+(add|remove)\s|\bcargo\s+add|\bgo\s+get/i, tr('review.category.dependencies'), 'medium'],
  [/\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i, tr('review.category.network'), 'medium'],
  [/\bdocker\s+(run|rm|rmi|system|compose\s+(up|down))|\b(kill|taskkill|Stop-Process)\b/i, tr('review.category.processes'), 'medium'],
  [/\b(mv|move|Move-Item|cp|copy|Copy-Item)\b/i, tr('review.category.moveOrCopy'), 'low']
]

export function sideEffectOf(call: ToolCall, cwd: string): SideEffect | null {
  const i = call.input
  if ((call.name === 'Bash' || call.name === 'PowerShell') && typeof i.command === 'string') {
    for (const [re, category, risk] of SHELL_RULES) if (re.test(i.command)) return { call, category, risk, detail: i.command }
    return null
  }
  if (call.name === 'WebFetch' || call.name === 'WebSearch') return { call, category: tr('review.category.network'), risk: 'low', detail: String(i.url ?? i.query ?? '') }
  const path = i.file_path ?? i.notebook_path
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(call.name) && typeof path === 'string') {
    const n = (p: string) => p.replace(/\\/g, '/').toLowerCase()
    const inside = n(path).startsWith(n(cwd) + '/') || !/^([a-z]:|\/)/i.test(path)
    // Claude Code's own plan and memory files live in ~/.claude; writing them is expected.
    const claudeOwn = /\/\.claude\/(plans|projects)\//.test(n(path))
    return inside || claudeOwn ? null : { call, category: tr('review.category.outsideProject'), risk: 'high', detail: path }
  }
  if (call.name.startsWith('mcp__') && !call.name.startsWith('mcp__glassbox__') && /(send|create|update|delete|post|add|edit|transition|reply|forward|trash|share|publish|upload|merge)/i.test(call.name)) {
    return { call, category: tr('review.category.connectorAction'), risk: 'high', detail: call.name.replace(/^mcp__(claude_ai_)?/, '').replace(/__/g, ': ') }
  }
  return null
}

// ── Checks: tests, lint and builds Claude has run ──

export type CheckKind = 'test' | 'lint' | 'build'
export type Check = { call: ToolCall; kind: CheckKind; passed: boolean | null; summary: string }

const CHECK_RULES: [RegExp, CheckKind][] = [
  [/\b(vitest|jest|pytest|mocha|playwright|dotnet\s+test|go\s+test|cargo\s+test|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+test|bun\s+test|deno\s+test)\b|\bnode\s+--test\b/i, 'test'],
  [/\b(eslint|tsc|typecheck|lint|prettier\s+--check|csharpier|ruff|mypy|golangci-lint|clippy)\b/i, 'lint'],
  [/\b(dotnet\s+build|vite\s+build|next\s+build|npm\s+run\s+build|pnpm\s+(run\s+)?build|cargo\s+build|go\s+build|mvn\s+(package|verify)|gradle\s+build|electron-vite\s+build)\b/i, 'build']
]

export function checkOf(call: ToolCall): Check | null {
  const cmd = call.input.command
  if ((call.name !== 'Bash' && call.name !== 'PowerShell') || typeof cmd !== 'string') return null
  const kind = CHECK_RULES.find(([re]) => re.test(cmd))?.[1]
  if (!kind) return null
  const out = call.result ?? ''
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  const summary =
    [...lines].reverse().find((l) => /(\d+\s+(passed|failed|tests?|errors?|warnings?))|Tests?:|error TS\d+|Build (succeeded|FAILED)|✓|✗|FAIL|PASS/i.test(l)) ??
    lines.at(-1) ??
    ''
  const failed = call.status === 'error' || /\b([1-9]\d*\s+(failed|errors?))\b|error TS\d+|Build FAILED|\bFAIL\b|exit code [1-9]/i.test(out)
  return { call, kind, passed: call.status === 'running' ? null : !failed, summary: summary.slice(0, 160) }
}

/** User turns with the files edited during each: the checkpoints you can rewind to. */
export function checkpoints(s: SessionState) {
  return s.timeline
    .filter((i): i is Extract<typeof i, { kind: 'user' }> => i.kind === 'user')
    .map((u) => ({ ...u, files: [...new Set(s.files.filter((f) => f.turn === u.turn && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'ShellEdit'].includes(f.tool) && s.toolCalls[f.toolId]?.status !== 'error').map((f) => f.path))] }))
}
