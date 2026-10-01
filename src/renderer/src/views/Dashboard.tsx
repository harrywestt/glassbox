import { AccountsButton } from './AccountsButton'
import { setPinned, usePinned } from '../pins'
import { StandupButton } from './StandupButton'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useActions } from '../App'
import type { SessionState } from '../session'
import type { Tab } from '../tabs'
import { baseName, formatTokens, timeAgo, timeUntil } from '../lib'
import { Empty, Icon, IconButton, Meter, Skeleton, SkeletonRows } from '../components/ui'
import type { LocalUsageDay, SDKSessionInfo, UsageSnapshot } from '../../../shared/events'
import type { GitHubSummary } from '../../../shared/github'
import { AppearanceCard } from './AppearanceCard'
import { AdminChip } from './AdminCard'
import { SessionsOverview } from './SessionsOverview'
import { GitHubSection } from './GitHubSection'
import { money, useFx } from '../money'

type Props = { tabs: Tab[]; sessions: Record<string, SessionState>; visible: boolean }

const REFRESH_MS = 60_000

export function Dashboard({ tabs, sessions, visible, active }: Props & { active?: string }) {
  // Each part loads on its own and its card fills in when it arrives; nothing waits on the slowest.
  const [usage, setUsage] = useState<UsageSnapshot | null>(null)
  const [days, setDays] = useState<UsageSnapshot['days'] | null>(null)
  const [usageError, setUsageError] = useState<string | null>(null)
  const [history, setHistory] = useState<SDKSessionInfo[] | null>(null)
  const [github, setGithub] = useState<GitHubSummary | null>(null)
  const fx = useFx()
  const [loading, setLoading] = useState(false)

  const tabDirs = tabs.map((t) => t.cwd).join('|')
  const refresh = useCallback(
    async (force = false) => {
      setLoading(true)
      const open = tabDirs.split('|').filter(Boolean)
      const limits = window.glassbox.usage.limits().then(
        (u) => (setUsage(u), setUsageError(null)),
        (err) => setUsageError(String(err))
      )
      const local = window.glassbox.usage.local().then((l) => setDays(l.days), () => setDays((d) => d ?? []))
      // GitHub starts straight away with the open sessions' folders, then widens once History says
      // which other folders you've worked in.
      const github = window.glassbox.github.summary(open.slice(0, 12), force).then(setGithub, () => {})
      const past = window.glassbox.history.list().then(
        (h) => {
          setHistory(h)
          const dirs = [...new Set([...open, ...h.map((x) => x.cwd).filter((c): c is string => !!c)])].slice(0, 12)
          if (dirs.length > open.length) return window.glassbox.github.summary(dirs, force).then(setGithub, () => {})
        },
        () => setHistory((h) => h ?? [])
      )
      await Promise.allSettled([limits, local, github, past])
      setLoading(false)
    },
    [tabDirs]
  )

  useEffect(() => {
    if (!visible) return
    void refresh()
    const t = setInterval(() => void refresh(), REFRESH_MS)
    return () => clearInterval(t)
  }, [visible, refresh])

  return (
    <div className="dashboard">
      <div className="dash-inner">
        <header className="dash-header">
          <div>
            <h1>Dashboard</h1>
            <div className="account-line">
              {usage ? <span>{usage.account?.email}</span> : <span className="skeleton-bar inline" style={{ width: 180 }} />}
              {usage?.account?.organization && <span>{usage.account.organization}</span>}
              {usage?.account?.subscriptionType && <span className="tag">{usage.account.subscriptionType}</span>}
            </div>
          </div>
          <span className="spacer" />
          <StandupButton />
          <AccountsButton />
          <AdminChip />
          {usage && <span className="muted small">Updated {timeAgo(usage.fetchedAt)}</span>}
          <IconButton icon={loading ? 'loading' : 'refresh'} title="Refresh" onClick={() => void refresh(true)} />
        </header>

        {usageError && <div className="note note-error">{usageError}</div>}

        <SessionsOverview tabs={tabs} sessions={sessions} active={active} />

        <div className="dash-grid">
          <div className="dash-col">
            <section className="card">
              <div className="card-title">Plan usage</div>
              {usage?.error && <div className="note note-warn">{usage.error}</div>}
              {!usage ? (
                <Skeleton lines={4} widths={['40%', '100%', '40%', '100%']} />
              ) : usage.rateLimits.length === 0 ? (
                <div className="muted small">No plan limits apply to this account (it uses an API key or a cloud provider).</div>
              ) : (
                <div className="limits">
                  {usage.rateLimits.map((w) => {
                    const left = Math.max(0, 100 - w.utilization)
                    return (
                      <div key={w.key} className="limit">
                        <div className="limit-top">
                          <span className="limit-label">{w.label}</span>
                          <span className="limit-value">{left.toFixed(0)}% left</span>
                        </div>
                        <Meter value={w.utilization} />
                        <div className="limit-foot muted small">
                          <span className={w.utilization >= 90 ? 'err' : w.utilization >= 70 ? 'warn' : ''}>
                            {w.utilization >= 90 && <Icon name="error" />} {w.utilization >= 70 && w.utilization < 90 && <Icon name="warning" />} {w.utilization.toFixed(0)}% used
                          </span>
                          {w.resetsAt && (
                            <span title={new Date(w.resetsAt).toLocaleString()}>
                              Resets in {timeUntil(w.resetsAt)}
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                  {usage.extraUsage && (
                    <div className="limit">
                      <div className="limit-top">
                        <span className="limit-label">Extra usage this month</span>
                        <span className="limit-value">
                          {(() => {
                            // Amounts arrive in minor units (cents) of the billing currency.
                            const cur = usage.extraUsage.currency ?? 'USD'
                            const used = money((usage.extraUsage.usedCredits ?? 0) / 100, cur, fx)
                            const limit = usage.extraUsage.monthlyLimit != null ? money(usage.extraUsage.monthlyLimit / 100, cur, fx) : null
                            return (
                              <span title={`Spent ${used.title}${limit ? ` of ${limit.title}` : ''}`}>
                                {used.text} <span className="muted small">of {limit ? limit.text : 'no limit'}</span>
                              </span>
                            )
                          })()}
                        </span>
                      </div>
                      <Meter value={usage.extraUsage.utilization ?? 0} />
                    </div>
                  )}
                </div>
              )}
            </section>

            <section className="card">
              <div className="card-title" title="Last 14 days, across every Claude Code session on this machine">Tokens per day</div>
              {days ? <UsageChart days={days} /> : <div className="chart-skeleton" aria-busy="true" aria-label="Loading">{Array.from({ length: 14 }, (_, i) => <span key={i} className="skeleton-bar" style={{ height: `${28 + ((i * 37) % 60)}%` }} />)}</div>}
            </section>

            <AppearanceCard />

          </div>

          <div className="dash-col">
            <GitHubSection summary={github} onOpen={(url) => void window.glassbox.openExternal(url)} />
            <section className="card history-card">
              <HistoryList history={history} tabs={tabs} sessions={sessions} />
            </section>
          </div>

        </div>
      </div>
    </div>
  )
}

/** Single-series bar chart: one accent hue, rounded data-ends on a shared baseline, per-bar hover tooltip. */
function UsageChart({ days }: { days: LocalUsageDay[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const totals = days.map((d) => d.input + d.output + d.cacheRead + d.cacheWrite)
  const max = Math.max(1, ...totals)
  const nice = niceCeil(max)
  const W = 640
  const H = 180
  const pad = { l: 44, r: 8, t: 10, b: 24 }
  const bw = (W - pad.l - pad.r) / days.length
  const barW = Math.max(4, bw - 6)
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / nice)
  const ticks = [0, nice / 2, nice]

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Tokens per day for the last 14 days">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={pad.l - 6} y={y(t) + 4} className="axis" textAnchor="end">{formatTokens(t)}</text>
          </g>
        ))}
        {days.map((d, i) => {
          const v = totals[i]
          const x = pad.l + i * bw + (bw - barW) / 2
          const top = y(v)
          const h = Math.max(0, H - pad.b - top)
          const r = Math.min(4, h, barW / 2)
          const date = new Date(d.date + 'T00:00:00')
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={pad.l + i * bw} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" />
              {h > 0 && (
                <path
                  className={hover === i ? 'bar active' : 'bar'}
                  d={`M${x},${H - pad.b} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${H - pad.b} Z`}
                />
              )}
              {(i % 2 === days.length % 2 || i === days.length - 1) && (
                <text x={x + barW / 2} y={H - 6} className="axis" textAnchor="middle">
                  {i === days.length - 1 ? 'Today' : date.toLocaleDateString([], { day: 'numeric', month: 'short' })}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      {hover !== null && (
        <div className="chart-tip" style={{ left: `${((pad.l + hover * bw + bw / 2) / W) * 100}%` }}>
          <strong>{new Date(days[hover].date + 'T00:00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</strong>
          <div className="tip-row"><span>Total</span><span>{totals[hover].toLocaleString()}</span></div>
          <div className="tip-row muted"><span>Cache read</span><span>{days[hover].cacheRead.toLocaleString()}</span></div>
          <div className="tip-row muted"><span>Cache write</span><span>{days[hover].cacheWrite.toLocaleString()}</span></div>
          <div className="tip-row muted"><span>Input</span><span>{days[hover].input.toLocaleString()}</span></div>
          <div className="tip-row muted"><span>Output</span><span>{days[hover].output.toLocaleString()}</span></div>
          <div className="tip-row muted"><span>Requests</span><span>{days[hover].requests.toLocaleString()}</span></div>
        </div>
      )}
    </div>
  )
}

function niceCeil(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v))
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((c) => c >= v) ?? 10 * p
}

function HistoryList({ history, tabs, sessions }: { history: SDKSessionInfo[] | null; tabs: Tab[]; sessions: Record<string, SessionState> }) {
  const actions = useActions()
  const [q, setQ] = useState('')
  const openIds = new Set(tabs.flatMap((t) => [t.resumeId, sessions[t.id]?.sessionId]).filter(Boolean))
  const pinned = usePinned()
  const [pinError, setPinError] = useState<string | null>(null)

  const groups = useMemo(() => {
    const items = (history ?? []).filter((h) => {
      if (!q) return true
      return `${h.customTitle ?? ''} ${h.summary} ${h.firstPrompt ?? ''} ${h.cwd ?? ''} ${h.gitBranch ?? ''}`.toLowerCase().includes(q.toLowerCase())
    })
    const startOfDay = new Date().setHours(0, 0, 0, 0)
    // Pinned sessions first, whenever they were last used.
    const buckets: [string, SDKSessionInfo[]][] = [['Pinned', []], ['Today', []], ['Yesterday', []], ['This week', []], ['Older', []]]
    for (const h of items) {
      if (pinned.has(h.sessionId)) {
        buckets[0][1].push(h)
        continue
      }
      const i = 1 + (h.lastModified >= startOfDay ? 0 : h.lastModified >= startOfDay - 86_400_000 ? 1 : h.lastModified >= startOfDay - 6 * 86_400_000 ? 2 : 3)
      buckets[i][1].push(h)
    }
    return buckets.filter(([, list]) => list.length)
  }, [history, q, pinned])

  return (
    <>
      <div className="history-head">
        <div className="card-title">History</div>
        <span className="spacer" />
        <div className="search">
          <Icon name="search" />
          <input placeholder="Search past sessions" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {pinError && <div className="note note-error small">{pinError}</div>}
      <div className="history-list">
        {!history && <SkeletonRows rows={6} />}
        {history && groups.length === 0 && <Empty icon="history" title={q ? 'No matching sessions' : 'No sessions yet'} />}
        {groups.map(([label, list]) => (
          <div key={label}>
            <div className="group-title">{label}</div>
            {list.map((h) => {
              const open = openIds.has(h.sessionId)
              return (
                <div
                  key={h.sessionId}
                  className="history-row"
                  onClick={() => h.cwd && actions.openSession(h.cwd, { resumeId: h.sessionId, title: h.customTitle ?? h.summary })}
                  title={h.firstPrompt ?? h.summary}
                >
                  <Icon name={open ? 'comment-discussion' : 'history'} className={open ? 'accent' : 'muted'} />
                  <div className="grow history-main">
                    <div className="ellipsis">{h.customTitle ?? h.summary}</div>
                    <div className="muted small ellipsis">
                      <Icon name="folder" /> {h.cwd ? baseName(h.cwd) : 'unknown'}
                      {h.gitBranch && (
                        <>
                          {' '}
                          <Icon name="git-branch" /> {h.gitBranch}
                        </>
                      )}
                    </div>
                  </div>
                  {open && <span className="tag accent">open</span>}
                  <button
                    className={pinned.has(h.sessionId) ? 'icon-btn pin-btn on' : 'icon-btn pin-btn'}
                    aria-pressed={pinned.has(h.sessionId)}
                    title={pinned.has(h.sessionId) ? 'Pinned: kept for good. Click to unpin' : 'Pin to keep it for good'}
                    onClick={(e) => {
                      e.stopPropagation()
                      setPinError(null)
                      void setPinned(h, !pinned.has(h.sessionId)).then((err) => err && setPinError(err))
                    }}
                  >
                    <Icon name={pinned.has(h.sessionId) ? 'pinned' : 'pin'} />
                  </button>
                  <span className="muted small">{timeAgo(h.lastModified)}</span>
                  <Icon name="chevron-right" className="muted" />
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </>
  )
}
