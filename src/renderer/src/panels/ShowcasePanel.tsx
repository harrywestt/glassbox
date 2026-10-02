import { useEffect, useState } from 'react'
import { useSession } from '../views/SessionView'
import { sessionBrief } from '../side'
import { Empty, Icon, IconButton, Toggle } from '../components/ui'
import { Select } from '../components/Select'
import { SideTaskSteps } from '../session-ui/SideTasks'
import { tr } from '../../../shared/i18n'

/**
 * The Showcase work tab: build a shareable deck of this session's work (published as a Claude
 * Artifact) in the background, watch it being built, and preview the result.
 */
export function ShowcasePanel() {
  const { tab, s } = useSession()
  const [branches, setBranches] = useState<string[]>([])
  const [base, setBase] = useState<string>('')
  const [notes, setNotes] = useState('')
  const [linkIt, setLinkIt] = useState(true)
  const [reload, setReload] = useState(0)
  const canSend = s.status !== 'new' && s.status !== 'stopped'
  const runs = Object.values(s.sideTasks).filter((t) => t.kind === 'showcase').sort((a, b) => b.startedAt - a.startedAt)
  const latestRun = runs[0]
  const building = latestRun?.status === 'running'

  useEffect(() => {
    if (!s.git?.isRepo) return
    window.glassbox.git.branches(tab.cwd).then(({ branches, defaultBase }) => {
      setBranches(branches)
      setBase((b) => b || defaultBase || '')
    })
  }, [tab.cwd, s.git?.isRepo])

  useEffect(() => setReload((n) => n + 1), [s.showcase?.at])

  const generate = () =>
    window.glassbox.session.sideShowcase(
      tab.id,
      { name: s.sessionId ?? tab.id, base: base || null, notes, previousArtifactUrl: s.showcase?.artifactUrl, linkIt },
      sessionBrief(s, tab.cwd)
    )

  const deck = s.showcase
  const src = deck ? `showcase://deck/${encodeURIComponent(deck.path)}?v=${reload}` : null

  return (
    <div className="showcase-page">
      <aside className="showcase-side">
        <section className="card">
          <div className="card-title">{tr('showcasePanel.title')}</div>
          <p className="muted small">
            {tr('showcasePanel.intro')}
          </p>
          <label className="field">
            <span>{tr('showcasePanel.compareAgainst')}</span>
            <Select value={base} onChange={setBase} disabled={!branches.length} placeholder={tr('showcasePanel.notRepo')} aria-label={tr('showcasePanel.compareAgainst')} options={branches.map((b) => ({ value: b, label: b }))} />
          </label>
          <label className="field">
            <span>{tr('showcasePanel.notes')}</span>
            <textarea rows={3} placeholder={tr('showcasePanel.notesPlaceholder')} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <label className="setting-inline">
            <span className="grow small">{tr('showcasePanel.linkIt')}</span>
            <Toggle checked={linkIt} onChange={setLinkIt} />
          </label>
          <div className="row-actions">
            <span className="spacer" />
            {building ? (
              <button onClick={() => void window.glassbox.session.stopSide(tab.id, latestRun.id)}>
                <Icon name="debug-stop" /> {tr('showcasePanel.stop')}
              </button>
            ) : (
              <button className="primary" disabled={!canSend} onClick={() => void generate()}>
                <Icon name="preview" /> {deck ? tr('showcasePanel.regenerate') : tr('showcasePanel.generate')}
              </button>
            )}
          </div>
        </section>

        {latestRun && (
          <section className="card">
            <div className="card-title">
              {building ? (
                <>
                  <Icon name="loading" className="codicon-modifier-spin accent" /> {tr('showcasePanel.building')}
                </>
              ) : latestRun.status === 'done' ? (
                tr('showcasePanel.lastBuild')
              ) : latestRun.status === 'stopped' ? (
                tr('showcasePanel.buildStopped')
              ) : (
                tr('showcasePanel.buildFailed')
              )}
            </div>
            {building && <div className="muted small">{tr('showcasePanel.runningInBackground')}</div>}
            <SideTaskSteps task={latestRun} />
          </section>
        )}
      </aside>

      <div className="showcase-preview">
        {deck && src ? (
          <>
            <div className="work-bar">
              <Icon name="preview" className="muted" />
              <strong className="grow ellipsis">{deck.title}</strong>
              {deck.artifactUrl && (
                <>
                  <button className="chip-btn" onClick={() => void navigator.clipboard.writeText(deck.artifactUrl!)}>
                    <Icon name="copy" /> {tr('showcasePanel.copyLink')}
                  </button>
                  <IconButton icon="link-external" title={tr('showcasePanel.openArtifact')} onClick={() => void window.glassbox.openExternal(deck.artifactUrl!)} />
                </>
              )}
              <IconButton icon="go-to-file" title={tr('showcasePanel.openLocal')} onClick={() => void window.glassbox.openPath(deck.path)} />
              <IconButton icon="refresh" title={tr('showcasePanel.reload')} onClick={() => setReload((n) => n + 1)} />
            </div>
            {deck.artifactUrl ? (
              <div className="callout callout-info small">
                <Icon name="info" /> {tr('showcasePanel.publishedPrivately')}
              </div>
            ) : (
              <div className="callout callout-warn small">
                <Icon name="warning" /> {tr('showcasePanel.notPublished')}
              </div>
            )}
            <iframe className="showcase-frame" src={src} sandbox="allow-scripts" title={deck.title} />
          </>
        ) : (
          <Empty icon="preview" title={building ? tr('showcasePanel.buildingShowcase') : tr('showcasePanel.emptyTitle')}>
            {building ? tr('showcasePanel.previewSoon') : tr('showcasePanel.emptyBody')}
          </Empty>
        )}
      </div>
    </div>
  )
}
