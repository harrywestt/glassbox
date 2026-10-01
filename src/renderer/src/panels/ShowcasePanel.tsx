import { useEffect, useState } from 'react'
import { useSession } from '../views/SessionView'
import { sessionBrief } from '../side'
import { Empty, Icon, IconButton, Toggle } from '../components/ui'
import { Select } from '../components/Select'
import { SideTaskSteps } from '../session-ui/SideTasks'

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
          <div className="card-title">Showcase this work</div>
          <p className="muted small">
            A slide deck for teammates who weren’t here: an overview with the change stats, UI before and after, code highlights and the decisions made, with
            why. It’s published as a Claude Artifact you can share.
          </p>
          <label className="field">
            <span>Compare against</span>
            <Select value={base} onChange={setBase} disabled={!branches.length} placeholder="(not a git repo)" aria-label="Compare against" options={branches.map((b) => ({ value: b, label: b }))} />
          </label>
          <label className="field">
            <span>Notes (optional)</span>
            <textarea rows={3} placeholder="Audience, focus, anything to include or leave out" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <label className="setting-inline">
            <span className="grow small">Add the link to the PR description and the Jira ticket</span>
            <Toggle checked={linkIt} onChange={setLinkIt} />
          </label>
          <div className="row-actions">
            <span className="spacer" />
            {building ? (
              <button onClick={() => void window.glassbox.session.stopSide(tab.id, latestRun.id)}>
                <Icon name="debug-stop" /> Stop
              </button>
            ) : (
              <button className="primary" disabled={!canSend} onClick={() => void generate()}>
                <Icon name="preview" /> {deck ? 'Regenerate' : 'Generate showcase'}
              </button>
            )}
          </div>
        </section>

        {latestRun && (
          <section className="card">
            <div className="card-title">
              {building ? (
                <>
                  <Icon name="loading" className="codicon-modifier-spin accent" /> Building
                </>
              ) : latestRun.status === 'done' ? (
                'Last build'
              ) : latestRun.status === 'stopped' ? (
                'Build stopped'
              ) : (
                'Build failed'
              )}
            </div>
            {building && <div className="muted small">Running in the background; your main session carries on as normal.</div>}
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
                    <Icon name="copy" /> Copy link
                  </button>
                  <IconButton icon="link-external" title="Open the Artifact in claude.ai" onClick={() => void window.glassbox.openExternal(deck.artifactUrl!)} />
                </>
              )}
              <IconButton icon="go-to-file" title="Open the local HTML file in your browser" onClick={() => void window.glassbox.openPath(deck.path)} />
              <IconButton icon="refresh" title="Reload preview" onClick={() => setReload((n) => n + 1)} />
            </div>
            {deck.artifactUrl ? (
              <div className="callout callout-info small">
                <Icon name="info" /> Published privately. In claude.ai, open it, then Share → your org, so teammates can view it.
              </div>
            ) : (
              <div className="callout callout-warn small">
                <Icon name="warning" /> Not published as an Artifact, so this is only a local file. The build’s steps on the left say why.
              </div>
            )}
            <iframe className="showcase-frame" src={src} sandbox="allow-scripts" title={deck.title} />
          </>
        ) : (
          <Empty icon="preview" title={building ? 'Building the showcase…' : 'No showcase yet'}>
            {building ? 'It previews here as soon as it’s ready.' : 'Generate one on the left; it previews here once it’s built.'}
          </Empty>
        )}
      </div>
    </div>
  )
}
