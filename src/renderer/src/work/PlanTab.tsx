import { useEffect, useMemo, useRef, useState } from 'react'
import type { PermissionDecision } from '../../../shared/events'
import type { SessionState } from '../session'
import { useSession } from '../views/SessionView'
import { renderMarkdown } from '../lib'
import { Icon, IconButton } from '../components/ui'
import { tr } from '../../../shared/i18n'

export type PlanShown = { text: string; status?: NonNullable<SessionState['plan']>['status'] }

const STATUS = { approved: 'planTab.status.approved', proposed: 'planTab.status.proposed', 'changes-requested': 'planTab.status.changesRequested' } as const

/**
 * Claude's plan, as a view of its own: it opens when Claude presents one, and waits there while you
 * look at anything else (the map, the code, the browser). Approve it or ask for changes from here.
 * Once decided, or for an earlier plan picked from the conversation, it's there to read again.
 *
 * Laid out as a document: a bar with where it stands, the plan itself (with an outline of its
 * sections beside it when there's room), and the decision fixed at the bottom while it waits.
 */
export function PlanTab({ shown }: { shown: PlanShown | null }) {
  const { tab, s, actions, showMap } = useSession()
  const [feedback, setFeedback] = useState('')
  const [asking, setAsking] = useState(false)
  const request = s.permissions.find((p) => p.toolName === 'ExitPlanMode')
  // The waiting plan comes first; otherwise the one you opened, or the latest.
  const waiting = request && (!shown || shown.text === String(request.input.plan ?? ''))
  const text = waiting ? String(request.input.plan ?? '') : (shown?.text ?? s.plan?.text ?? '')
  const status = waiting ? 'proposed' : (shown ? shown.status : s.plan?.status)
  // The plan's shape, when Claude drew it on the map for this plan (since your last message).
  const since = [...s.timeline].reverse().find((i) => i.kind === 'user')?.at ?? 0
  const shape = waiting && s.planMap && s.planMap.at >= since ? s.planMap : undefined
  const html = useMemo(() => renderMarkdown(text), [text])
  const doc = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [outline, setOutline] = useState<{ id: string; text: string }[]>([])
  const [current, setCurrent] = useState<string | null>(null)

  // The plan's sections, for the outline: each heading gets an id to jump to.
  useEffect(() => {
    const heads = [...(doc.current?.querySelectorAll('h2') ?? [])]
    heads.forEach((h, i) => (h.id = `plan-${i}`))
    setOutline(heads.map((h) => ({ id: h.id, text: h.textContent ?? '' })))
  }, [html])

  // The section you're reading, marked in the outline.
  useEffect(() => {
    const box = scroller.current
    if (!box || outline.length < 3) return
    const onScroll = () => {
      // A section counts as being read once its heading is in the top third of the view.
      const r = box.getBoundingClientRect()
      const top = r.top + r.height / 3
      let at: string | null = null
      for (const o of outline) {
        const h = document.getElementById(o.id)
        if (h && h.getBoundingClientRect().top <= top) at = o.id
      }
      setCurrent(at)
    }
    onScroll()
    box.addEventListener('scroll', onScroll, { passive: true })
    return () => box.removeEventListener('scroll', onScroll)
  }, [outline])

  const respond = (decision: PermissionDecision, message?: string) => request && window.glassbox.session.respondPermission(tab.id, request.id, decision, message)
  const approve = () => {
    actions.planStatus(tab.id, 'approved')
    void respond('allow')
  }
  const sendFeedback = () => {
    if (!feedback.trim()) return
    actions.planStatus(tab.id, 'changes-requested')
    void respond('deny', `The user reviewed your plan and wants changes before you start:\n\n${feedback.trim()}\n\nRevise the plan and present it again.`)
    setAsking(false)
    setFeedback('')
  }

  if (!text)
    return (
      <div className="plan-tab">
        <div className="plan-tab-empty muted">{tr('planTab.empty')}</div>
      </div>
    )

  return (
    <div className="plan-tab">
      <div className="plan-bar">
        <Icon name="checklist" />
        <strong>{tr('planTab.title')}</strong>
        {status && <span className={`plan-status plan-status-${status}`}>{tr(STATUS[status])}</span>}
        {waiting && <span className="muted small ellipsis">{tr('planTab.nothingChangedYet')}</span>}
        <span className="grow" />
        {shape && (
          <button className="btn plan-map" onClick={showMap} title={shapeText(shape)}>
            <Icon name="type-hierarchy" /> {tr('planTab.seeOnMap')}
          </button>
        )}
        <IconButton icon="copy" title={tr('planTab.copy')} onClick={() => void navigator.clipboard.writeText(text)} />
      </div>
      <div className="plan-scroll" ref={scroller}>
        <div className={outline.length >= 3 ? 'plan-layout with-outline' : 'plan-layout'}>
          {outline.length >= 3 && (
            <nav className="plan-outline" aria-label={tr('planTab.outline')}>
              {outline.map((o) => (
                <button key={o.id} className={o.id === current ? 'on' : ''} onClick={() => document.getElementById(o.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                  {o.text}
                </button>
              ))}
            </nav>
          )}
          <article className="plan-doc markdown" ref={doc} dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </div>
      {waiting && (
        <div className="plan-decide">
          <div className="plan-decide-inner">
            {asking ? (
              <>
                <textarea
                  autoFocus
                  rows={3}
                  placeholder={tr('planTab.feedbackPlaceholder')}
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendFeedback()
                    else if (e.key === 'Escape') setAsking(false)
                  }}
                />
                <div className="plan-decide-row">
                  <span className="muted small">{tr('planTab.feedbackHint')}</span>
                  <span className="grow" />
                  <button onClick={() => setAsking(false)}>{tr('planTab.back')}</button>
                  <button className="primary" disabled={!feedback.trim()} onClick={sendFeedback}>
                    {tr('planTab.sendFeedback')}
                  </button>
                </div>
              </>
            ) : (
              <div className="plan-decide-row">
                <span className="muted small">{tr('planTab.approveHint')}</span>
                <span className="grow" />
                <button onClick={() => setAsking(true)}>{tr('planTab.requestChanges')}</button>
                <button className="primary" onClick={approve}>
                  {tr('planTab.approvePlan')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function shapeText(shape: NonNullable<SessionState['planMap']>): string {
  return (
    tr('planTab.shape.touchesModules', { count: shape.modules.length }) +
    (shape.modules.some((m) => m.change === 'new') ? tr('planTab.shape.newOfThem', { count: shape.modules.filter((m) => m.change === 'new').length }) : '') +
    (shape.connections.length ? tr('planTab.shape.changesConnections', { count: shape.connections.length }) : '') +
    tr('planTab.shape.end')
  )
}
