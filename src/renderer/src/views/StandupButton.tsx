import { useEffect, useState } from 'react'
import type { Standup } from '../../../shared/events'
import { Icon, IconButton } from '../components/ui'
import { tr } from '../../../shared/i18n'

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
      <button className="btn" onClick={() => (setOpen(true), !data && !busy && load(false))} title={tr('standupButton.buttonTitle')}>
        <Icon name="checklist" /> {tr('standupButton.standup')}
      </button>
      {open && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="dialog standup" role="dialog" aria-label={tr('standupButton.standup')}>
            <div className="standup-head">
              <div className="standup-title">
                <strong>{tr('standupButton.standup')}</strong>
                {data?.label && <span className="muted">{data.label}</span>}
              </div>
              <IconButton icon="refresh" title={tr('standupButton.writeAgain')} onClick={() => !busy && load(true)} disabled={busy} />
              <IconButton icon="close" title={tr('standupButton.close')} onClick={() => setOpen(false)} />
            </div>

            <div className="standup-body">
              {busy && !data?.groups.length ? (
                <div className="standup-wait">
                  <Icon name="loading" className="codicon-modifier-spin" />
                  <span>{tr('standupButton.reading')}</span>
                </div>
              ) : data?.error ? (
                <div className="standup-wait">{tr('standupButton.error', { error: data.error })}</div>
              ) : data && !data.groups.length ? (
                <div className="standup-wait">{tr('standupButton.nothingFound', { label: data.label })}</div>
              ) : (
                data?.groups.map((g) => (
                  <section key={g.epicKey ?? g.epic} className="standup-group">
                    <h3>
                      {g.epic}
                      {g.epicKey && (
                        <button className="standup-key" onClick={() => g.url && void window.glassbox.openExternal(g.url)} disabled={!g.url} title={g.url ? tr('standupButton.openEpic') : undefined}>
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
                  {tr('standupButton.from', { sessions: tr('standupButton.sessions', { count: data.sessions }), commits: tr('standupButton.commits', { count: data.commits }) })}
                  {data.jiraError && (
                    <>
                      {data.groupedBy === 'repo' ? tr('standupButton.groupedByProject') : ' '}
                      {/connect/i.test(data.jiraError) ? tr('standupButton.jiraNotConnected') : tr('standupButton.jiraNoAnswer')}{' '}
                      <button className="link small" onClick={() => load(true)} disabled={busy}>
                        {tr('standupButton.tryJiraAgain')}
                      </button>
                    </>
                  )}
                </span>
                <span className="spacer" />
                <button className="btn primary" onClick={copy}>
                  <Icon name={copied ? 'check' : 'copy'} /> {copied ? tr('standupButton.copied') : tr('standupButton.copy')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
