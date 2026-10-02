import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { query } from './claude'
import type { Finding, FindingSeverity, ReviewModel } from '../shared/events'

type PendingEdit = { toolUseId: string; tool: string; path: string; before?: string; after: string }

const MAX_CHARS = 60_000
const MAX_FILE_CHARS = 16_000
const SEVERITIES = new Set<FindingSeverity>(['blocker', 'major', 'minor', 'nit', 'question'])
const FENCE = '```'

const PROMPT = `You are a senior engineer doing a second-pair-of-eyes review of edits another AI agent just made. You get each changed file as it is now, plus the individual edits; judge the edits in the context of the whole file (an edit snippet on its own is often incomplete, so don't flag that).
Report only things worth interrupting it for: likely bugs, broken edge cases, security problems, data loss, race conditions, clear contract or convention breaks, or edits that don't fit the stated task. Don't report style preferences, and don't repeat something already obvious from the diff. If everything looks fine, return [].
Answer with ONLY a JSON array, no prose: [{"severity":"blocker|major|minor|question","file":"path","line":123,"title":"one line","detail":"why it matters","suggestion":"what to do"}]. line is optional.`

/**
 * On-demand reviewer: collects Claude's edits and, when the user asks, has a second model review
 * them against the current files. It runs with no tools and no project settings, and nothing it
 * does touches the session.
 */
export class Reviewer {
  private queue: PendingEdit[] = []
  private running = false

  constructor(
    private cwd: string,
    private task: () => string | undefined,
    private emit: (findings: Finding[], reviewed: string[]) => void,
    private state: (busy: boolean, pending: number, error?: string) => void
  ) {}

  add(edit: PendingEdit) {
    this.queue.push(edit)
    this.state(this.running, this.queue.length)
  }

  dispose() {
    this.queue = []
  }

  /** Reviews every edit made since the last review. */
  async review(model: ReviewModel) {
    if (this.running || !this.queue.length) return
    const batch = this.queue.splice(0)
    this.running = true
    this.state(true, 0)
    try {
      let body = '## Changed files as they are now\n\n'
      for (const path of [...new Set(batch.map((e) => e.path))]) {
        let current: string
        try {
          current = readFileSync(isAbsolute(path) ? path : resolve(this.cwd, path), 'utf8').slice(0, MAX_FILE_CHARS)
        } catch {
          current = '(file no longer exists)'
        }
        const part = `### ${path}\n${FENCE}\n${current}\n${FENCE}\n`
        if (body.length + part.length > MAX_CHARS / 2) break
        body += part
      }
      body += '\n## The edits\n\n'
      for (const e of batch) {
        const part =
          e.tool === 'Write'
            ? `### ${e.path} (new or rewritten file)\n${FENCE}\n${e.after}\n${FENCE}\n`
            : `### ${e.path}\nBefore:\n${FENCE}\n${e.before ?? ''}\n${FENCE}\nAfter:\n${FENCE}\n${e.after}\n${FENCE}\n`
        if (body.length + part.length > MAX_CHARS) break
        body += part
      }
      const task = this.task()
      const prompt = `${PROMPT}\n\n${task ? `The agent's current task: ${task}\n\n` : ''}${body}`
      let text = ''
      for await (const msg of query({
        prompt,
        options: { cwd: this.cwd, model, tools: [], settingSources: [], persistSession: false, maxTurns: 1, thinking: model === 'haiku' ? { type: 'disabled' } : { type: 'adaptive' } }
      })) {
        if (msg.type === 'result' && msg.subtype === 'success') text = msg.result
      }
      this.emit(parse(text), batch.map((b) => b.toolUseId))
      this.state(false, this.queue.length)
    } catch (err) {
      // Put the edits back so the review can be retried.
      this.queue.unshift(...batch)
      this.state(false, this.queue.length, `Review failed: ${String(err)}`)
    } finally {
      this.running = false
    }
  }
}

function parse(text: string): Finding[] {
  const match = text.match(/\[[\s\S]*\]/)
  if (!match) return []
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>[]
    return raw
      .filter((r) => r && typeof r.title === 'string')
      .map((r) => ({
        id: randomUUID(),
        source: 'reviewer' as const,
        severity: SEVERITIES.has(r.severity as FindingSeverity) ? (r.severity as FindingSeverity) : 'minor',
        title: String(r.title),
        detail: typeof r.detail === 'string' ? r.detail : undefined,
        file: typeof r.file === 'string' ? r.file : undefined,
        line: typeof r.line === 'number' ? r.line : undefined,
        suggestion: typeof r.suggestion === 'string' ? r.suggestion : undefined,
        at: Date.now()
      }))
  } catch {
    return []
  }
}
