import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { LocalUsageDay, RateLimitWindow, UsageSnapshot } from '../shared/events'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const DAYS = 14

const WINDOW_LABELS: Record<string, string> = {
  five_hour: 'Current 5-hour window',
  seven_day: 'This week, all models',
  seven_day_opus: 'This week, Opus',
  seven_day_sonnet: 'This week, Sonnet',
  seven_day_oauth_apps: 'This week, connected apps'
}

type FileAgg = {
  mtimeMs: number
  size: number
  days: Map<string, LocalUsageDay>
  models: Map<string, { tokens: number; requests: number }>
  cwd?: string
  tokens: number
}

/**
 * Plan limits come from an idle SDK session's usage control request (no model call).
 * Token history comes from scanning Claude Code's local transcripts, cached per file.
 */
export class UsageService {
  private q?: Query
  private cache = new Map<string, FileAgg>()

  private session(): Query {
    if (!this.q) {
      const idle: AsyncIterable<SDKUserMessage> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }
      this.q = query({ prompt: idle, options: { cwd: homedir(), settingSources: [], persistSession: false } })
    }
    return this.q
  }

  async snapshot(): Promise<UsageSnapshot> {
    const [limits, local] = await Promise.all([this.limits(), this.local()])
    return { ...limits, ...local }
  }

  /** Token history from this machine's transcripts (the slow part the first time; cached per file after). */
  local(): Promise<Pick<UsageSnapshot, 'days' | 'models' | 'projects'>> {
    return this.scanTranscripts()
  }

  /** The account and plan limits, from the idle session: quick, and no transcript reading. */
  async limits(): Promise<UsageSnapshot> {
    const snapshot: UsageSnapshot = { fetchedAt: Date.now(), subscriptionType: null, rateLimits: [], days: [], models: [], projects: [] }
    try {
      const q = this.session()
      const [usage, account] = await Promise.all([
        q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: false }),
        q.accountInfo()
      ])
      snapshot.account = account
      snapshot.subscriptionType = usage.subscription_type
      const limits = usage.rate_limits
      if (limits) {
        const windows: RateLimitWindow[] = []
        for (const [key, label] of Object.entries(WINDOW_LABELS)) {
          const w = limits[key as keyof typeof limits] as { utilization: number | null; resets_at: string | null } | null | undefined
          if (w && w.utilization != null) windows.push({ key, label, utilization: w.utilization, resetsAt: w.resets_at })
        }
        for (const m of limits.model_scoped ?? []) {
          if (m.utilization != null) windows.push({ key: `model:${m.display_name}`, label: `This week, ${m.display_name}`, utilization: m.utilization, resetsAt: m.resets_at })
        }
        snapshot.rateLimits = windows
        const extra = limits.extra_usage
        if (extra?.is_enabled) {
          snapshot.extraUsage = { monthlyLimit: extra.monthly_limit, usedCredits: extra.used_credits, utilization: extra.utilization, currency: extra.currency }
        }
      }
      snapshot.todayRequests = usage.behaviors?.day.request_count
      snapshot.todaySessions = usage.behaviors?.day.session_count
    } catch (err) {
      snapshot.error = `Couldn't read plan limits: ${String(err)}`
    }
    return snapshot
  }

  dispose() {
    this.q?.close()
  }

  private async scanTranscripts() {
    const since = Date.now() - DAYS * 86_400_000
    const files: string[] = []
    const walk = async (dir: string) => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const full = join(dir, e.name)
        if (e.isDirectory()) await walk(full)
        else if (e.name.endsWith('.jsonl')) files.push(full)
      }
    }
    await walk(PROJECTS_DIR)

    const aggs: FileAgg[] = []
    for (const file of files) {
      const info = await stat(file)
      if (info.mtimeMs < since) continue
      const cached = this.cache.get(file)
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
        aggs.push(cached)
        continue
      }
      const agg = await scanFile(file, since, info.mtimeMs, info.size)
      this.cache.set(file, agg)
      aggs.push(agg)
    }

    const days = new Map<string, LocalUsageDay>()
    for (let i = DAYS - 1; i >= 0; i--) {
      const date = localDate(Date.now() - i * 86_400_000)
      days.set(date, { date, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 })
    }
    const models = new Map<string, { tokens: number; requests: number }>()
    const projects = new Map<string, { tokens: number; sessions: number }>()
    for (const agg of aggs) {
      for (const d of agg.days.values()) {
        const t = days.get(d.date)
        if (!t) continue
        t.input += d.input
        t.output += d.output
        t.cacheRead += d.cacheRead
        t.cacheWrite += d.cacheWrite
        t.requests += d.requests
      }
      for (const [model, m] of agg.models) {
        const t = models.get(model) ?? { tokens: 0, requests: 0 }
        t.tokens += m.tokens
        t.requests += m.requests
        models.set(model, t)
      }
      if (agg.cwd && agg.tokens) {
        const p = projects.get(agg.cwd) ?? { tokens: 0, sessions: 0 }
        p.tokens += agg.tokens
        p.sessions += 1
        projects.set(agg.cwd, p)
      }
    }
    return {
      days: [...days.values()],
      models: [...models.entries()].filter(([model, m]) => m.tokens > 0 && !model.startsWith('<')).map(([model, m]) => ({ model, ...m })).sort((a, b) => b.tokens - a.tokens),
      projects: [...projects.entries()].map(([cwd, p]) => ({ cwd, ...p })).sort((a, b) => b.tokens - a.tokens).slice(0, 8)
    }
  }
}

function localDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function scanFile(file: string, since: number, mtimeMs: number, size: number): Promise<FileAgg> {
  const agg: FileAgg = { mtimeMs, size, days: new Map(), models: new Map(), tokens: 0 }
  const seen = new Set<string>()
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const msg = entry.message
    const u = msg?.usage
    if (entry.type !== 'assistant' || !u || !entry.timestamp) continue
    const ts = Date.parse(entry.timestamp)
    if (ts < since) continue
    const key = `${msg.id}:${entry.requestId ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    agg.cwd ??= entry.cwd
    const date = localDate(ts)
    const day = agg.days.get(date) ?? { date, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }
    day.input += u.input_tokens ?? 0
    day.output += u.output_tokens ?? 0
    day.cacheRead += u.cache_read_input_tokens ?? 0
    day.cacheWrite += u.cache_creation_input_tokens ?? 0
    day.requests += 1
    agg.days.set(date, day)
    const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    agg.tokens += tokens
    const model = agg.models.get(msg.model ?? 'unknown') ?? { tokens: 0, requests: 0 }
    model.tokens += tokens
    model.requests += 1
    agg.models.set(msg.model ?? 'unknown', model)
  }
  return agg
}
