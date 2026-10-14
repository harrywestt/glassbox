import { useEffect, useState } from 'react'
import type { SpendSummary } from '../../../shared/events'
import { money, useFx } from '../money'
import { baseName } from '../lib'
import { tr } from '../../../shared/i18n'

/** "claude-opus-5-5[1m]" → "Opus 5.5 (1M)", "claude-haiku-4-5-20251001" → "Haiku 4.5". */
export function modelName(id: string): string {
  const wide = /\[1m\]/i.test(id)
  const m = id.toLowerCase().replace(/\[.*?\]/g, '').replace(/^claude-/, '').replace(/-\d{8}$/, '').match(/^([a-z]+)-?([\d-]*)$/)
  if (!m) return id === 'unknown' ? tr('spend.other') : id
  const name = m[1][0].toUpperCase() + m[1].slice(1) + (m[2] ? ' ' + m[2].replace(/-/g, '.') : '')
  return wide ? `${name} (1M)` : name
}

/** A colour per model family, in a fixed order (the app's chart palette): Opus, Sonnet, Haiku, Fable, then the rest. */
const FAMILY = ['opus', 'sonnet', 'haiku', 'fable']
const colourOf = (id: string) => {
  const i = FAMILY.findIndex((f) => id.toLowerCase().includes(f))
  return `var(--cat-${i >= 0 ? i + 1 : 5})`
}

/** Spend split by model: a bar, then a row each (name, amount, share), largest first. */
export function SpendBreakdown({ byModel, compact }: { byModel: Record<string, number>; compact?: boolean }) {
  const fx = useFx()
  // The same model under its 1M name counts with it.
  const merged = new Map<string, number>()
  for (const [id, usd] of Object.entries(byModel)) merged.set(modelName(id).replace(/ \(1M\)$/, ''), (merged.get(modelName(id).replace(/ \(1M\)$/, '')) ?? 0) + usd)
  const ids = new Map<string, string>()
  for (const id of Object.keys(byModel)) ids.set(modelName(id).replace(/ \(1M\)$/, ''), id)
  const rows = [...merged].sort((a, b) => b[1] - a[1])
  const total = rows.reduce((n, [, v]) => n + v, 0)
  if (!total) return <div className="muted small">{tr('spend.nothingYet')}</div>
  return (
    <div className={compact ? 'spend compact' : 'spend'}>
      <div className="spend-bar" role="img" aria-label={rows.map(([n, v]) => `${n} ${Math.round((v / total) * 100)}%`).join(', ')}>
        {rows.map(([name, v]) => (
          <span key={name} style={{ width: `${(v / total) * 100}%`, background: colourOf(ids.get(name) ?? name) }} title={`${name}: ${money(v, 'USD', fx).text}`} />
        ))}
      </div>
      <ul className="spend-rows">
        {rows.map(([name, v]) => (
          <li key={name}>
            <span className="spend-swatch" style={{ background: colourOf(ids.get(name) ?? name) }} aria-hidden />
            <span className="grow">{name}</span>
            <span className="num" title={money(v, 'USD', fx).title}>{money(v, 'USD', fx).text}</span>
            <span className="num muted spend-pct">{Math.round((v / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const HELPER_KEYS = ['quick', 'review', 'ux', 'side'] as const

/** What Glassbox's helpers (quick answers, the reviewers, side tasks) spent, as one line. */
export function HelperLine({ helpers, total }: { helpers: Record<string, number>; total: number }) {
  const fx = useFx()
  const sum = Object.values(helpers).reduce((a, b) => a + b, 0)
  if (!sum) return null
  const parts = HELPER_KEYS.filter((k) => helpers[k]).map((k) => `${tr(`spend.helper.${k}`)} ${money(helpers[k], 'USD', fx).text}`)
  return (
    <div className="muted small spend-helpers" title={parts.join(', ')}>
      {tr('spend.helpers', { amount: money(sum, 'USD', fx).text, percent: total ? Math.round((sum / total) * 100) : 0 })}
    </div>
  )
}

/** The dashboard's spend: today and this week, by model, by day and by project, and the helpers' share. */
export function SpendCard({ visible }: { visible: boolean }) {
  const fx = useFx()
  const [s, setS] = useState<SpendSummary | null>(null)
  useEffect(() => {
    if (!visible) return
    const load = () => void window.glassbox.spend.summary().then(setS).catch(() => {})
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [visible])
  const max = Math.max(...(s?.days ?? []).map((d) => d.total), 0.0001)
  return (
    <section className="card spend-card">
      <div className="card-title" title={tr('spend.cardTip')}>{tr('spend.title')}</div>
      {!s ? (
        <div className="muted small">{tr('dashboard.loading')}</div>
      ) : (
        <>
          <div className="spend-totals">
            <div>
              <div className="spend-big num">{money(s.today, 'USD', fx).text}</div>
              <div className="muted small">{tr('spend.today')}</div>
            </div>
            <div>
              <div className="spend-big num">{money(s.week, 'USD', fx).text}</div>
              <div className="muted small">{tr('spend.week')}</div>
            </div>
          </div>
          <div className="spend-days" aria-hidden>
            {s.days.map((d) => (
              <span key={d.date} className="spend-day" title={`${d.date}: ${money(d.total, 'USD', fx).text}`}>
                <span style={{ height: `${Math.max(d.total ? 4 : 0, (d.total / max) * 100)}%` }} />
              </span>
            ))}
          </div>
          <SpendBreakdown byModel={s.byModel} />
          <HelperLine helpers={s.helpers} total={s.week} />
          {s.byProject.length > 1 && (
            <ul className="spend-projects">
              {s.byProject.map((p) => (
                <li key={p.cwd} title={p.cwd}>
                  <span className="grow ellipsis">{baseName(p.cwd)}</span>
                  <span className="num">{money(p.total, 'USD', fx).text}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
