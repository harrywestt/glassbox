import { useRef, useEffect, useMemo, useState } from 'react'
import { useSession } from '../views/SessionView'
import { checkOf, checkpoints, sideEffectOf, type Check, type CheckKind } from '../review'
import { baseName, relPath, timeAgo } from '../lib'
import { Empty, Icon, PanelHeader, Section, Toggle } from '../components/ui'
import { CriteriaList, FindingCard } from '../session-ui/Signals'
import { BlastRadius } from '../components/BlastRadius'
import { CHANGE_TOOLS, isClaudeOwnFile } from '../session'
import { READ_TOOLS, SHELL_TOOLS } from '../side'
import type { DiffResult, ReviewModel, RewindResult } from '../../../shared/events'
import { Select } from '../components/Select'
import { TestsSummary } from '../session-ui/TestSignals'
import { RadarCard } from '../session-ui/RadarCard'
import { tr } from '../../../shared/i18n'

const CHECK_LABEL: Record<CheckKind, string> = { test: tr('reviewPanel.checkTests'), lint: tr('reviewPanel.checkLint'), build: tr('reviewPanel.checkBuild') }

/**
 * Everything a reviewer would ask, answered continuously while Claude works. `compact` is the version
 * under the Changes list: no changeset (the list above is the changeset) and no tests (Running has them).
 */
export function ReviewPanel({ compact }: { compact?: boolean } = {}) {
  const { tab, s, showPanel, runSide, checkpoint, setCheckpoint, openFile, openDiff } = useSession()
  const editedKey = [...new Set(s.files.filter((f) => CHANGE_TOOLS.has(f.tool) && s.toolCalls[f.toolId]?.status !== 'error' && !isClaudeOwnFile(f.path)).map((f) => f.path))].sort().join('|')
  const edited = useMemo(() => (editedKey ? editedKey.split('|') : []), [editedKey])
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [base, setBase] = useState<string | null>(null)
  const canSend = s.status !== 'new' && s.status !== 'stopped'

  useEffect(() => {
    if (!s.git?.isRepo) return
    window.glassbox.git.branches(tab.cwd).then(({ defaultBase }) => setBase(defaultBase))
  }, [tab.cwd, s.git?.isRepo])

  // Waits for Claude's edits to settle, so a burst of them runs one diff rather than one each.
  const diffLoaded = useRef(false)
  diffLoaded.current = diff !== null
  useEffect(() => {
    if (!base) return
    let live = true
    const t = setTimeout(() => window.glassbox.git.diff(tab.cwd, base, 'merge-base').then((d) => live && setDiff(d), () => live && setDiff(null)), diffLoaded.current ? 700 : 0)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [tab.cwd, base, s.git?.dirty, s.git?.head])

  const checks = useMemo(() => Object.values(s.toolCalls).map(checkOf).filter((c): c is Check => !!c), [s.toolCalls])
  const latest = (kind: CheckKind) => [...checks].reverse().find((c) => c.kind === kind)
  const risky = useMemo(() => Object.values(s.toolCalls).map((c) => sideEffectOf(c, tab.cwd)).filter((e) => e && e.risk === 'high'), [s.toolCalls, tab.cwd])
  const openAssumptions = s.decisions.filter((d) => d.kind !== 'decision' && !d.challenged)
  // A branch file Claude also edited this session opens with its change-by-change view available.
  const openChanged = (rel: string) => {
    const mine = edited.find((e) => e.replace(/\\/g, '/').endsWith(`/${rel}`))
    openDiff({ path: mine ?? `${s.git?.root ?? tab.cwd}/${rel}`, base, diffMode: 'merge-base', source: mine ? 'session' : 'branch' })
  }
  // Untracked files Claude didn't touch are leftovers in the folder, not part of this branch's changes.
  const isMine = (rel: string) => edited.some((e) => e.replace(/\\/g, '/').endsWith(`/${rel}`))
  const files = (diff?.files ?? []).filter((f) => f.status !== '?' || isMine(f.path))
  const strays = (diff?.files.length ?? 0) - files.length
  const adds = diff?.files.reduce((n, f) => n + (f.additions ?? 0), 0) ?? 0
  const dels = diff?.files.reduce((n, f) => n + (f.deletions ?? 0), 0) ?? 0

  return (
    <div className="panel">
      {!compact && <PanelHeader title={tr('reviewPanel.title')} />}
      <div className="panel-scroll">
        {/* Sections only show when they have something in them; each folds away. */}
        {(openAssumptions.length > 0 || risky.length > 0 || s.guardHits.length > 0) && (
          <Section id="needs-a-look" title={tr('reviewPanel.needsALook')}>
            {openAssumptions.length > 0 && (
              <Attention icon="warning" tone="warn" onClick={() => showPanel('decisions')}>
                {tr('reviewPanel.assumptionsNotReviewed', { count: openAssumptions.length })}
              </Attention>
            )}
            {(risky.length > 0 || s.guardHits.length > 0) && (
              <Attention icon="shield" tone="warn" onClick={() => showPanel('guardrails')}>
                {tr('reviewPanel.riskSummary', { actions: tr('reviewPanel.highRiskActions', { count: risky.length }), stops: tr('reviewPanel.guardrailStops', { count: s.guardHits.length }) })}
              </Attention>
            )}
          </Section>
        )}
        <CriteriaList />
        <Findings />
        {!compact && s.git?.isRepo && (!diff || files.length > 0) && <Section id="changeset" title={tr('reviewPanel.changeset')} meta={base && <span className="muted small">{tr('reviewPanel.against', { base })}</span>}>
          {!s.git?.isRepo ? (
            <div className="muted small">{tr('reviewPanel.notRepo')}</div>
          ) : !diff ? (
            <div className="muted small">{tr('reviewPanel.comparing')}</div>
          ) : (
            <>
              <div className="review-stats">
                <div><span className="big">{files.length}</span><span className="muted small">{tr('reviewPanel.statFiles')}</span></div>
                <div><span className="big ok">+{adds}</span><span className="muted small">{tr('reviewPanel.statAdded')}</span></div>
                <div><span className="big err">−{dels}</span><span className="muted small">{tr('reviewPanel.statRemoved')}</span></div>
              </div>
              {files.slice(0, 8).map((f) => (
                <div key={f.path} className="list-row clickable" onClick={() => openChanged(f.path)} title={`${f.path}\n${tr('reviewPanel.openDiff')}`}>
                  <span className="status-letter muted">{f.status === '?' ? 'U' : f.status}</span>
                  <span className="grow ellipsis">{baseName(f.path)} <span className="muted small">{f.path.split('/').slice(0, -1).join('/')}</span></span>
                  {f.additions !== undefined && <span className="small"><span className="ok">+{f.additions}</span> <span className="err">−{f.deletions}</span></span>}
                </div>
              ))}
              {files.length > 8 && <button className="link small" onClick={() => showPanel('changes')}>{tr('reviewPanel.allFiles', { n: files.length })}</button>}
              {strays > 0 && <div className="muted small changes-untracked">{tr('reviewPanel.untrackedNotCounted', { count: strays })}</div>}
            </>
          )}
        </Section>}

        <RadarCard />

        <BlastRadius cwd={tab.cwd} files={edited} onOpen={openFile} />

        {!compact && latest('test') && (
          <Section id="review-tests" title={tr('reviewPanel.tests')}>
            <TestsSummary />
          </Section>
        )}

        {(latest('lint') || latest('build')) && (
        <Section id="lint-build" title={tr('reviewPanel.lintAndBuild')}>
          {(['lint', 'build'] as CheckKind[]).filter((kind) => latest(kind)).map((kind) => {
            const c = latest(kind)
            return (
              <div key={kind} className="check-row">
                <Icon name={!c ? 'circle-large-outline' : c.passed === null ? 'loading' : c.passed ? 'pass-filled' : 'error'} className={!c ? 'muted' : c.passed === null ? 'codicon-modifier-spin accent' : c.passed ? 'ok' : 'err'} />
                <div className="grow">
                  <div>{CHECK_LABEL[kind]} {c && <span className="muted small">{timeAgo(c.call.at)}</span>}</div>
                  <div className={c ? 'muted small ellipsis mono' : 'muted small'} title={c?.call.input.command as string | undefined}>{c ? c.summary || String(c.call.input.command) : tr('reviewPanel.notRun')}</div>
                </div>
              </div>
            )
          })}
        </Section>
        )}

        {checkpoints(s).some((c) => c.uuid) && (
          <Section id="checkpoints" title={tr('reviewPanel.checkpoints')} tip={tr('reviewPanel.checkpointsTip')}>
            <Checkpoints selected={checkpoint} onSelect={setCheckpoint} />
          </Section>
        )}

        {/* Always on hand, whatever has run so far. */}
        <div className="row-actions review-checks">
          <button className="chip-btn" disabled={!canSend} onClick={() => runSide({ kind: 'checks', title: tr('reviewPanel.runChecks'), prompt: "Run this project's tests, lint or typecheck, and build, and report each result with the failures that matter. Don't change any files.", tools: [...READ_TOOLS, ...SHELL_TOOLS] })}>
            <Icon name="play" /> {tr('reviewPanel.runChecks')}
          </button>
        </div>
      </div>
    </div>
  )
}

const REVIEW_MODEL_KEY = 'glassbox.reviewModel'
const REVIEW_MODELS: { value: ReviewModel; label: string }[] = [
  { value: 'haiku', label: 'Haiku' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' }
]
function loadReviewModel(): ReviewModel {
  try {
    const m = localStorage.getItem(REVIEW_MODEL_KEY)
    if (m === 'sonnet' || m === 'opus') return m
  } catch {
    /* default */
  }
  return 'haiku'
}

function Findings() {
  const { tab, s, runSide } = useSession()
  const open = s.findings.filter((f) => f.status !== 'dismissed')
  const canSend = s.status === 'ready' || s.status === 'running'
  const r = s.reviewer
  const [model, setModel] = useState<ReviewModel>(loadReviewModel)
  const pickModel = (m: ReviewModel) => {
    setModel(m)
    try {
      localStorage.setItem(REVIEW_MODEL_KEY, m)
    } catch {
      /* not saved; fine */
    }
  }
  // Nothing to show until there are edits to review or something was found.
  if (!open.length && !r.pending && !r.busy && !r.error && !r.reviewedEdits) return null
  return (
    <Section id="findings" title={tr('reviewPanel.findings')} meta={open.length > 0 && <span className="count">{open.length}</span>} actions={r.reviewedEdits > 0 && <span className="small muted">{tr('reviewPanel.editsReviewed', { n: r.reviewedEdits })}</span>}>
      <div className="review-run">
        <Select<ReviewModel> value={model} onChange={pickModel} aria-label={tr('reviewPanel.reviewModel')} title={tr('reviewPanel.reviewModelTitle')} options={REVIEW_MODELS} />
        <button
          className="primary"
          disabled={r.busy || r.pending === 0}
          onClick={() => void window.glassbox.session.review(tab.id, model)}
          title={r.pending ? tr('reviewPanel.reviewTitle', { count: r.pending }) : tr('reviewPanel.noNewEdits')}
        >
          {r.busy ? <><Icon name="loading" className="codicon-modifier-spin" /> {tr('reviewPanel.reviewing')}</> : <><Icon name="checklist" /> {r.pending ? tr('reviewPanel.reviewNewEdits', { count: r.pending }) : tr('reviewPanel.reviewEdits')}</>}
        </button>
      </div>
      {r.error && <div className="note note-error">{r.error}</div>}
      {open.length === 0 ? (
        <div className="muted small">{r.reviewedEdits ? tr('reviewPanel.nothingFlagged') : tr('reviewPanel.notReviewed')}</div>
      ) : (
        <div className="findings">{[...open].reverse().map((f) => <FindingCard key={f.id} f={f} />)}</div>
      )}
      {tab.kind === 'review' && s.findings.some((f) => f.source === 'claude') && (
        <div className="row-actions">
          <button
            className="chip-btn"
            disabled={!canSend}
            onClick={() =>
              runSide({
                kind: 'review',
                title: tr('reviewPanel.draftReview'),
                tools: [...READ_TOOLS, ...SHELL_TOOLS],
                prompt: `Draft a GitHub review for ${tab.title.replace(/^Review /, 'PR ')} from these findings: a short summary, then each finding as an inline comment on its file and line. Return the draft as your final message. Don't post anything.\n\n${open
                  .filter((f) => f.source === 'claude')
                  .map((f) => `- [${f.severity}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}${f.detail ? `: ${f.detail}` : ''}${f.suggestion ? ` Suggestion: ${f.suggestion}` : ''}`)
                  .join('\n')}`
              })
            }
          >
            <Icon name="github" /> {tr('reviewPanel.draftReview')}
          </button>
        </div>
      )}
    </Section>
  )
}

function Attention({ icon, tone, children, onClick }: { icon: string; tone: 'ok' | 'warn'; children: React.ReactNode; onClick: () => void }) {
  return (
    <div className="list-row clickable attention" onClick={onClick}>
      <Icon name={tone === 'ok' ? 'pass' : icon} className={tone === 'ok' ? 'ok' : 'warn'} />
      <span className="grow">{children}</span>
      <Icon name="chevron-right" className="muted" />
    </div>
  )
}

function Checkpoints({ selected, onSelect }: { selected: string | null; onSelect: (uuid: string | null) => void }) {
  const { tab, s } = useSession()
  const [preview, setPreview] = useState<{ uuid: string; result?: RewindResult; error?: string; done?: boolean } | null>(null)
  const list = checkpoints(s).filter((c) => c.uuid).reverse()

  const dryRun = async (uuid: string) => {
    onSelect(uuid)
    setPreview({ uuid })
    try {
      setPreview({ uuid, result: await window.glassbox.session.rewind(tab.id, uuid, true) })
    } catch (err) {
      setPreview({ uuid, error: String(err) })
    }
  }
  useEffect(() => {
    if (selected && selected !== preview?.uuid) void dryRun(selected)
  }, [selected])

  const rewind = async (uuid: string) => {
    try {
      const result = await window.glassbox.session.rewind(tab.id, uuid, false)
      setPreview({ uuid, result, done: true })
    } catch (err) {
      setPreview({ uuid, error: String(err) })
    }
  }

  if (!list.length) return <Empty icon="discard" title={tr('reviewPanel.noCheckpoints')}>{tr('reviewPanel.noCheckpointsBody')}</Empty>

  return (
    <div className="checkpoints">
      {list.map((c) => (
        <div key={c.uuid} className={selected === c.uuid ? 'checkpoint selected' : 'checkpoint'}>
          <div className="list-row clickable" onClick={() => void dryRun(c.uuid!)}>
            <Icon name="discard" />
            <span className="grow ellipsis">{c.text}</span>
            <span className="muted small">{c.files.length ? tr('reviewPanel.checkpointFiles', { count: c.files.length }) : tr('reviewPanel.noEdits')}</span>
          </div>
          {preview && preview.uuid === c.uuid && (
            <div className="checkpoint-detail small">
              {preview.error ? (
                <div className="err">{preview.error}</div>
              ) : !preview.result ? (
                <div className="muted">{tr('reviewPanel.checkingChanges')}</div>
              ) : preview.result.canRewind && !preview.done && !preview.result.filesChanged?.length ? (
                <div className="muted">{tr('reviewPanel.nothingToRestore')}</div>
              ) : !preview.result.canRewind ? (
                <div className="muted">{preview.result.error ?? tr('reviewPanel.nothingToRewind')}</div>
              ) : preview.done ? (
                <div className="ok"><Icon name="pass" /> {tr('reviewPanel.restored', { n: preview.result.filesChanged?.length ?? 0 })}</div>
              ) : (
                <>
                  <div>
                    {tr('reviewPanel.rewindingRestores')} <strong>{tr('reviewPanel.rewindFiles', { n: preview.result.filesChanged?.length ?? 0 })}</strong> (<span className="ok">+{preview.result.insertions ?? 0}</span> <span className="err">−{preview.result.deletions ?? 0}</span>)
                  </div>
                  <div className="muted mono ellipsis">{preview.result.filesChanged?.map((f) => relPath(tab.cwd, f)).join(', ')}</div>
                  <div className="row-actions">
                    <button onClick={() => (setPreview(null), onSelect(null))}>{tr('reviewPanel.cancel')}</button>
                    <button className="danger" onClick={() => void rewind(c.uuid!)}>{tr('reviewPanel.rewindFilesButton')}</button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

