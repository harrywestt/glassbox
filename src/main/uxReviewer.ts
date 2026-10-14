import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { query } from './claude'
import type { Finding, FindingSeverity } from '../shared/events'

/** A screenshot waiting for the UX reviewer: the picture, and where it was taken. */
export type Shot = { path: string; url?: string; title?: string; note?: string }

const SEVERITIES = new Set<FindingSeverity>(['blocker', 'major', 'minor', 'nit', 'question'])
/** Shots are reviewed together (so it can compare them), a handful at a time. */
const BATCH = 6
/** A quiet spell after the last shot before a part-full batch is reviewed. */
const SETTLE_MS = 15_000
const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

const PROMPT = `You are a senior product designer reviewing screenshots of a web app that another agent is testing. You only see the pictures; you can't click anything. Look for what a careful designer would send back before launch:
- Bad UX: unclear labels or actions, missing feedback, confusing hierarchy, cramped or broken layout, text cut off or overflowing, poor contrast, tiny targets, things that look clickable and aren't (or the reverse), empty, loading and error states that leave people stuck.
- Inconsistencies: across these screens and the ones described in your notes from earlier batches: buttons, spacing, type sizes, colours, icons, capitalisation, wording for the same thing, alignment.
- AI slop: generic template look, meaningless decoration, gradient or glow filler, emoji used as icons, vague filler copy ("Unlock the power of…", "Seamlessly…"), placeholder or lorem text, made-up numbers, cards for everything, everything centred.
- Broken things: overlapping elements, misaligned grids, unstyled or half-styled parts, images that didn't load, odd scrollbars.
Report only real, specific problems you can point at in a picture, each once. Don't report what's merely a taste preference, and don't guess at behaviour you can't see. Fewer, sharper findings beat many vague ones.
Answer with ONLY JSON, no prose: {"findings":[{"shot":1,"severity":"major|minor|nit|question","title":"one line, specific","detail":"where on the screen and why it matters","suggestion":"what to change"}],"notes":"a few lines describing this app's look (colours, type, buttons, spacing, tone) so later batches can check consistency against it"}. shot is the number of the screenshot it's about.`

/**
 * The UX reviewer: a second agent that looks over screenshots (a deep QA run's, or any Claude asks
 * it to) for bad UX, inconsistencies and AI slop. It runs on its own in the background, so the
 * agent doing the testing never waits for it; its findings arrive as they're ready. It sees only
 * the pictures: no tools, no project settings, nothing it does touches the session.
 */
export class UxReviewer {
  private queue: Shot[] = []
  private running: Promise<void> | null = null
  private timer: NodeJS.Timeout | undefined
  private notes = ''
  private reviewed = 0
  private found: Finding[] = []
  private seen = new Set<string>()

  constructor(
    private cwd: string,
    private task: () => string | undefined,
    private emit: (findings: Finding[]) => void,
    /** How it's getting on: shown as a loader above the message box. */
    private progress: (p: { busy: boolean; reviewed: number; pending: number; error?: string }) => void,
    /** What each batch cost (the SDK's result), for the session's spend. */
    private onCost?: (msg: { modelUsage?: Record<string, { costUSD?: number }>; total_cost_usd?: number }) => void
  ) {}

  /** Queues a screenshot; a full batch is reviewed straight away, a part-full one after a quiet spell. */
  add(shot: Shot) {
    const path = isAbsolute(shot.path) ? shot.path : resolve(this.cwd, shot.path)
    if (this.seen.has(path.toLowerCase()) || !TYPES[extname(path).toLowerCase()] || !existsSync(path)) return false
    this.seen.add(path.toLowerCase())
    this.queue.push({ ...shot, path })
    this.report()
    clearTimeout(this.timer)
    if (this.queue.length >= BATCH) void this.drain()
    else this.timer = setTimeout(() => void this.drain(), SETTLE_MS)
    return true
  }

  /** Everything found so far, and what's still to look at. */
  status() {
    return { findings: this.found, reviewed: this.reviewed, pending: this.queue.length + (this.running ? 1 : 0), busy: !!this.running }
  }

  /** Reviews whatever's queued now and waits until nothing is left (or the time runs out). */
  async flush(ms = 180_000) {
    clearTimeout(this.timer)
    const until = Date.now() + ms
    while ((this.queue.length || this.running) && Date.now() < until) {
      if (!this.running) void this.drain()
      await Promise.race([this.running, new Promise((r) => setTimeout(r, 1000))])
    }
  }

  dispose() {
    clearTimeout(this.timer)
    this.queue = []
  }

  private report(error?: string) {
    this.progress({ busy: !!this.running, reviewed: this.reviewed, pending: this.queue.length, error })
  }

  private drain(): Promise<void> {
    if (this.running || !this.queue.length) return this.running ?? Promise.resolve()
    clearTimeout(this.timer)
    const batch = this.queue.splice(0, BATCH)
    this.running = this.review(batch).finally(() => {
      this.running = null
      this.report()
      // More arrived while it was looking: carry on.
      if (this.queue.length >= BATCH) void this.drain()
      else if (this.queue.length) this.timer = setTimeout(() => void this.drain(), SETTLE_MS)
    })
    this.report()
    return this.running
  }

  private async review(batch: Shot[]) {
    const content: SDKUserMessage['message']['content'] = []
    const task = this.task()
    content.push({
      type: 'text',
      text: `${PROMPT}\n\n${task ? `What's being tested: ${task}\n\n` : ''}${this.notes ? `Your notes on this app from earlier screenshots:\n${this.notes}\n\n` : ''}${batch.length} screenshot${batch.length > 1 ? 's' : ''} follow, numbered in order.`
    })
    batch.forEach((s, i) => {
      content.push({ type: 'text', text: `Screenshot ${i + 1}${s.title ? `: "${s.title}"` : ''}${s.url ? ` (${s.url})` : ''}${s.note ? `. ${s.note}` : ''}` })
      content.push({ type: 'image', source: { type: 'base64', media_type: TYPES[extname(s.path).toLowerCase()] as 'image/png', data: readFileSync(s.path).toString('base64') } })
    })
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null } as SDKUserMessage
    }
    try {
      let text = ''
      for await (const msg of query({
        prompt: prompt(),
        options: { cwd: this.cwd, model: 'sonnet', tools: [], settingSources: [], persistSession: false, maxTurns: 1, thinking: { type: 'adaptive' } }
      })) {
        if (msg.type === 'result') this.onCost?.(msg)
        if (msg.type === 'result' && msg.subtype === 'success') text = msg.result
      }
      const { findings, notes } = parse(text, batch)
      if (notes) this.notes = notes.slice(0, 1500)
      this.reviewed += batch.length
      this.found.push(...findings)
      if (findings.length) this.emit(findings)
    } catch (err) {
      // Put them back so the next run tries again.
      this.queue.unshift(...batch)
      this.report(String(err))
      await new Promise((r) => setTimeout(r, 10_000))
    }
  }
}

function parse(text: string, batch: Shot[]): { findings: Finding[]; notes?: string } {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return { findings: [] }
  try {
    const raw = JSON.parse(match[0]) as { findings?: Record<string, unknown>[]; notes?: unknown }
    const findings = (raw.findings ?? [])
      .filter((r) => r && typeof r.title === 'string')
      .map((r) => {
        const shot = batch[Math.max(0, Math.min(batch.length - 1, Number(r.shot ?? 1) - 1))]
        return {
          id: randomUUID(),
          source: 'ux' as const,
          severity: SEVERITIES.has(r.severity as FindingSeverity) ? (r.severity as FindingSeverity) : 'minor',
          title: String(r.title),
          detail: typeof r.detail === 'string' ? r.detail : undefined,
          suggestion: typeof r.suggestion === 'string' ? r.suggestion : undefined,
          image: shot?.path,
          page: shot?.url,
          at: Date.now()
        }
      })
    return { findings, notes: typeof raw.notes === 'string' ? raw.notes : undefined }
  } catch {
    return { findings: [] }
  }
}
