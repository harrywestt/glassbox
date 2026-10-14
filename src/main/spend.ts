import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { SpendSummary } from '../shared/events'

/**
 * What Claude has cost, as the SDK estimates it (per model, per turn), kept in a small ledger so the
 * dashboard can show today and the week by model and by project. A line per model per turn: the
 * session's main work, or one of Glassbox's helpers (quick answers, the reviewers, side tasks).
 */

type Line = { at: number; day: string; cwd: string; session?: string; title?: string; model: string; usd: number; helper?: string }

const file = () => {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'spend.jsonl')
}
const dayOf = (at: number) => {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Cost per model in an SDK result (modelUsage), or its total when it has no breakdown. */
export function costByModel(msg: { modelUsage?: Record<string, { costUSD?: number }>; total_cost_usd?: number }): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [model, u] of Object.entries(msg.modelUsage ?? {})) if (u?.costUSD) out[model] = u.costUSD
  if (!Object.keys(out).length && msg.total_cost_usd) out.unknown = msg.total_cost_usd
  return out
}

export function recordSpend(where: { cwd: string; session?: string; title?: string; helper?: string }, byModel: Record<string, number>) {
  const at = Date.now()
  const lines = Object.entries(byModel)
    .filter(([, usd]) => usd > 0.000001)
    .map(([model, usd]) => JSON.stringify({ at, day: dayOf(at), ...where, model, usd } satisfies Line))
  if (!lines.length) return
  try {
    appendFileSync(file(), lines.join('\n') + '\n')
  } catch {
    /* the dashboard just won't count it */
  }
}

/** Today, this week (the last 7 days) and the last 14 days, by model, project and helper. */
export function spendSummary(): SpendSummary {
  const now = Date.now()
  const today = dayOf(now)
  const days: string[] = []
  for (let i = 13; i >= 0; i--) days.push(dayOf(now - i * 86_400_000))
  const week = new Set(days.slice(-7))
  const out: SpendSummary = { today: 0, week: 0, days: days.map((date) => ({ date, total: 0, byModel: {} })), byModel: {}, byProject: [], helpers: {}, mainWeek: 0 }
  if (!existsSync(file())) return out
  const projects = new Map<string, number>()
  for (const raw of readFileSync(file(), 'utf8').split('\n')) {
    if (!raw) continue
    let l: Line
    try {
      l = JSON.parse(raw)
    } catch {
      continue
    }
    const d = out.days.find((x) => x.date === l.day)
    if (!d) continue
    d.total += l.usd
    d.byModel[l.model] = (d.byModel[l.model] ?? 0) + l.usd
    if (l.day === today) out.today += l.usd
    if (!week.has(l.day)) continue
    out.week += l.usd
    out.byModel[l.model] = (out.byModel[l.model] ?? 0) + l.usd
    projects.set(l.cwd, (projects.get(l.cwd) ?? 0) + l.usd)
    if (l.helper) out.helpers[l.helper] = (out.helpers[l.helper] ?? 0) + l.usd
    else out.mainWeek += l.usd
  }
  out.byProject = [...projects].map(([cwd, total]) => ({ cwd, total })).sort((a, b) => b.total - a.total).slice(0, 6)
  return out
}
