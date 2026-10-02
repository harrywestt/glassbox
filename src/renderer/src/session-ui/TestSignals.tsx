import { useMemo, useState } from 'react'
import { useSession } from '../views/SessionView'
import { baseName } from '../lib'
import type { ToolCall } from '../session'
import { runSummary, testRuns, untestedEdits, type TestRun } from '../tests'
import { Icon } from '../components/ui'
import { tr } from '../../../shared/i18n'

function useRuns() {
  const { s } = useSession()
  return useMemo(() => testRuns(s), [s.toolCalls, s.files])
}

/** A test run in the conversation: green or red, what failed, and whether an edit just broke it. */
export function TestCard({ call }: { call: ToolCall }) {
  const runs = useRuns()
  const [open, setOpen] = useState(false)
  const i = runs.findIndex((r) => r.toolId === call.id)
  const run = runs[i]
  if (call.status === 'running')
    return (
      <div className="test-card running">
        <Icon name="loading" className="codicon-modifier-spin accent" /> <span>{tr('testSignals.running')}</span>
        <span className="muted small mono ellipsis">{String(call.input.command ?? '')}</span>
      </div>
    )
  if (!run) return null
  const prev = runs[i - 1]
  const broke = prev?.ok && !run.ok
  const fixed = prev && !prev.ok && run.ok
  return (
    <div className={run.ok ? 'test-card ok' : 'test-card bad'}>
      <button className="test-head" onClick={() => setOpen(!open)} title={run.command}>
        <Icon name={run.ok ? 'pass-filled' : 'error'} className={run.ok ? 'ok' : 'err'} />
        <strong>{run.ok ? tr('testSignals.passed') : tr('testSignals.failed')}</strong>
        <span className="muted small">{runSummary(run)}</span>
        {broke && run.editsSince.length > 0 && <span className="tag warn-tag">{tr('testSignals.wentRedAfterEditing', { files: run.editsSince.slice(0, 2).map(baseName).join(', ') })}</span>}
        {fixed && <span className="tag accent">{tr('testSignals.fixed')}</span>}
        <span className="spacer" />
        {run.failures.length > 0 && <Icon name={open ? 'chevron-up' : 'chevron-down'} className="muted" />}
      </button>
      {(open || !run.ok) && run.failures.length > 0 && (
        <ul className="test-failures">
          {run.failures.slice(0, open ? 12 : 3).map((f) => (
            <li key={f} className="mono small">{f}</li>
          ))}
          {!open && run.failures.length > 3 && <li className="muted small">{tr('testSignals.andMore', { count: run.failures.length - 3 })}</li>}
        </ul>
      )}
    </div>
  )
}

/** Latest test status, a trend of recent runs, and edits the tests haven't seen yet. */
export function TestsSummary({ compact }: { compact?: boolean }) {
  const { s, tab, send } = useSession()
  const runs = useRuns()
  const last = runs.at(-1)
  const untested = useMemo(() => untestedEdits(s, runs), [s.files, runs])
  const canSend = s.status === 'ready' || s.status === 'running'
  if (!last) {
    if (compact) return null
    return <div className="muted small">{tr('testSignals.noRuns')}</div>
  }
  const firstRed = [...runs].reverse().find((r, i, arr) => !r.ok && (arr[i + 1]?.ok ?? true))
  return (
    <div className="tests-summary">
      <div className="tests-line">
        <Icon name={last.ok ? 'pass-filled' : 'error'} className={last.ok ? 'ok' : 'err'} />
        <strong className="small">{last.ok ? tr('testSignals.passing') : tr('testSignals.failing')}</strong>
        <span className="muted small">{runSummary(last)}</span>
        <span className="spacer" />
        <Trend runs={runs} />
      </div>
      {!last.ok && firstRed?.editsSince.length ? (
        <div className="small muted tests-cause">
          {tr('testSignals.wentRedAfterEdits', { files: firstRed.editsSince.slice(0, 3).map(baseName).join(', ') })}
          {last.failures.length > 0 && tr('testSignals.failuresSuffix', { failures: last.failures.slice(0, 2).join(', ') })}
        </div>
      ) : null}
      {untested.length > 0 && (
        <div className="tests-stale small">
          <Icon name="warning" className="warn" /> {tr('testSignals.filesChanged', { count: untested.length })}
          {!compact && (
            <button className="link small" disabled={!canSend} onClick={() => void send('Run the relevant tests now and tell me the result.', tr('testSignals.runTestsDisplay'))}>
              {tr('testSignals.askToRun')}
            </button>
          )}
        </div>
      )}
      <span hidden>{tab.id}</span>
    </div>
  )
}

function Trend({ runs }: { runs: TestRun[] }) {
  return (
    <span className="test-trend" aria-label={tr('testSignals.recentRuns')}>
      {runs.slice(-16).map((r) => (
        <span key={r.toolId} className={r.ok ? 'tr ok' : 'tr bad'} title={tr('testSignals.runTitle', { time: new Date(r.at).toLocaleTimeString(), summary: runSummary(r) })} />
      ))}
    </span>
  )
}
