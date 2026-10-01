import { useEffect, useRef, useState } from 'react'
import { useSession } from '../views/SessionView'
import { CHANGE_TOOLS } from '../session'
import { checkOf } from '../review'
import { baseName } from '../lib'
import { Icon } from '../components/ui'

const AWAY_MS = 2 * 60_000
/** How long the digest stays before it goes by itself (held while the pointer is over it). */
const SHOW_MS = 10_000

/**
 * "While you were away": when you come back to a session after a couple of minutes, a digest of
 * what changed since you last looked. Tracks attention (tab visible and window focused), not clock time.
 */
export function AwayDigest({ active }: { active: boolean }) {
  const { s, showPanel, openFile } = useSession()
  const lastSeen = useRef(Date.now())
  const [since, setSince] = useState<number | null>(null)

  useEffect(() => {
    const watching = () => active && document.hasFocus() && document.visibilityState === 'visible'
    const tick = () => {
      if (watching()) lastSeen.current = Date.now()
    }
    const onReturn = () => {
      if (watching() && Date.now() - lastSeen.current > AWAY_MS) setSince(lastSeen.current)
      tick()
    }
    onReturn()
    const t = setInterval(tick, 5000)
    window.addEventListener('focus', onReturn)
    document.addEventListener('visibilitychange', onReturn)
    return () => {
      clearInterval(t)
      window.removeEventListener('focus', onReturn)
      document.removeEventListener('visibilitychange', onReturn)
    }
  }, [active])

  // It goes by itself after a few seconds, unless you're reading it (pointer over it).
  const [holding, setHolding] = useState(false)
  useEffect(() => {
    if (!since || holding) return
    const t = setTimeout(() => setSince(null), SHOW_MS)
    return () => clearTimeout(t)
  }, [since, holding])

  if (!since) return null
  const calls = Object.values(s.toolCalls).filter((c) => c.at > since)
  const edited = [...new Set(s.files.filter((f) => f.at > since && CHANGE_TOOLS.has(f.tool)).map((f) => f.path))]
  const decisions = s.decisions.filter((d) => d.at > since)
  const assumptions = decisions.filter((d) => d.kind === 'assumption').length
  const questions = decisions.filter((d) => d.kind === 'question').length
  const guards = s.guardHits.filter((h) => h.at > since).length
  const checks = calls.map(checkOf).filter((c) => c && c.passed !== null)
  const failed = checks.filter((c) => c && !c.passed).length
  const turnsDone = s.timeline.filter((i) => i.kind === 'result' && i.at > since).length
  if (!calls.length && !turnsDone) return null
  const mins = Math.round((Date.now() - since) / 60000)

  return (
    <div className="away" onMouseEnter={() => setHolding(true)} onMouseLeave={() => setHolding(false)}>
      <div className="away-head">
        <Icon name="history" />
        <strong>While you were away</strong>
        <span className="muted small">{mins} min</span>
        <span className="spacer" />
        <button className="icon-btn" title="Dismiss" onClick={() => setSince(null)}>
          <Icon name="close" />
        </button>
      </div>
      <ul className="away-list">
        <li>
          {calls.length} tool call{calls.length === 1 ? '' : 's'}
          {turnsDone ? `, ${turnsDone} turn${turnsDone > 1 ? 's' : ''} finished` : ''}
          {s.status === 'ready' ? '. Claude is waiting for you' : s.permissions.length ? '. Claude needs your approval' : ''}
        </li>
        {edited.length > 0 && (
          <li>
            Edited{' '}
            {edited.slice(0, 5).map((p, i) => (
              <span key={p}>
                {i > 0 && ', '}
                <button className="link" onClick={() => openFile(p)}>{baseName(p)}</button>
              </span>
            ))}
            {edited.length > 5 && ` and ${edited.length - 5} more`}
          </li>
        )}
        {decisions.length > 0 && (
          <li>
            <button className="link" onClick={() => showPanel('decisions')}>
              {decisions.length} logged
            </button>
            {assumptions ? `, ${assumptions} assumption${assumptions > 1 ? 's' : ''}` : ''}
            {questions ? `, ${questions} question${questions > 1 ? 's' : ''} for you` : ''}
          </li>
        )}
        {checks.length > 0 && <li className={failed ? 'err' : ''}>{failed ? `${failed} of ${checks.length} checks failed` : `${checks.length} check${checks.length > 1 ? 's' : ''} passed`}</li>}
        {guards > 0 && (
          <li className="warn">
            <button className="link" onClick={() => showPanel('guardrails')}>
              {guards} guardrail stop{guards > 1 ? 's' : ''}
            </button>
          </li>
        )}
      </ul>
    </div>
  )
}
