import { useEffect, useState } from 'react'
import type { Standup } from '../../../shared/events'
import { Icon, IconButton } from '../components/ui'

/** Plain text for pasting into Slack or Teams: each epic, then its bullets. */
function asText(s: Standup): string {
  return s.groups
    .map((g) => [`${g.epic}${g.epicKey ? ` (${g.epicKey})` : ''}`, ...g.items.map((i) => `- ${i.text}${i.ticket ? ` (${i.ticket.key})` : ''}`)].join('\n'))
    .join('\n\n')
}

/**
 * One button for the morning stand-up: what you did on the last working day, grouped by epic,
 * ready to read out or paste.
 */
export function StandupButton() {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<Standup | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = (force: boolean) => {
    setBusy(true)
    window.glassbox
      .standup(force)
      .then(setData)
      .catch((e) => setData({ from: '', to: '', label: '', groups: [], sessions: 0, commits: 0, generatedAt: Date.now(), error: String(e) }))
      .finally(() => setBusy(false))
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const copy = () => {
    if (!data) return
    void navigator.clipboard.writeText(asText(data)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }

  return (
    <>
      <button className="btn" onClick={() => (setOpen(true), !data && !busy && load(false))} title="What you did on the last working day, grouped by epic">
        <Icon name="checklist" /> Stand-up
      </button>
      {open && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="dialog standup" role="dialog" aria-label="Stand-up">
            <div className="standup-head">
              <div className="standup-title">
                <strong>Stand-up</strong>
                {data?.label && <span className="muted">{data.label}</span>}
              </div>
              <IconButton icon={busy ? 'loading' : 'refresh'} title="Write it again" onClick={() => !busy && load(true)} disabled={busy} />
              <IconButton icon="close" title="Close (Esc)" onClick={() => setOpen(false)} />
            </div>

            <div className="standup-body">
              {busy && !data?.groups.length ? (
                <div className="standup-wait">
                  <Icon name="loading" className="codicon-modifier-spin" />
                  <span>Reading your sessions and commits, then finding each ticket’s epic in Jira…</span>
                </div>
              ) : data?.error ? (
                <div className="standup-wait">Couldn’t put it together: {data.error}</div>
              ) : data && !data.groups.length ? (
                <div className="standup-wait">Nothing found for {data.label}: no Claude sessions or commits from you that day.</div>
              ) : (
                data?.groups.map((g) => (
                  <section key={g.epicKey ?? g.epic} className="standup-group">
                    <h3>
                      {g.epic}
                      {g.epicKey && (
                        <button className="standup-key" onClick={() => g.url && void window.glassbox.openExternal(g.url)} disabled={!g.url} title={g.url ? 'Open the epic in Jira' : undefined}>
                          {g.epicKey}
                        </button>
                      )}
                    </h3>
                    <ul>
                      {g.items.map((i, n) => (
                        <li key={n}>
                          <span>{i.text}</span>
                          {i.ticket && (
                            <button className="standup-key" onClick={() => i.ticket?.url && void window.glassbox.openExternal(i.ticket.url)} disabled={!i.ticket.url} title={[i.ticket.summary, i.ticket.status].filter(Boolean).join('\n') || undefined}>
                              {i.ticket.key}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                ))
              )}
            </div>

            {data && !data.error && data.groups.length > 0 && (
              <div className="standup-foot">
                <span className="muted small">
                  From {data.sessions} session{data.sessions === 1 ? '' : 's'} and {data.commits} commit{data.commits === 1 ? '' : 's'}.
                  {data.jiraError && (
                    <>
                      {data.groupedBy === 'repo' ? ' Grouped by project: ' : ' '}
                      {/connect/i.test(data.jiraError) ? 'Jira isn’t connected (connect the Atlassian connector in claude.ai to group by epic).' : 'Jira didn’t answer, so epics are missing.'}{' '}
                      <button className="link small" onClick={() => load(true)} disabled={busy}>
                        Try Jira again
                      </button>
                    </>
                  )}
                </span>
                <span className="spacer" />
                <button className="btn primary" onClick={copy}>
                  <Icon name={copied ? 'check' : 'copy'} /> {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
