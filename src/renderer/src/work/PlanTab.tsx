import { useState } from 'react'
import type { PermissionDecision } from '../../../shared/events'
import type { SessionState } from '../session'
import { useSession } from '../views/SessionView'
import { renderMarkdown } from '../lib'
import { Icon } from '../components/ui'
import { tr } from '../../../shared/i18n'

export type PlanShown = { text: string; status?: NonNullable<SessionState['plan']>['status'] }

const STATUS = { approved: 'planTab.status.approved', proposed: 'planTab.status.proposed', 'changes-requested': 'planTab.status.changesRequested' } as const

/**
 * Claude's plan, as a view of its own: it opens when Claude presents one, and waits there while you
 * look at anything else (the map, the code, the browser). Approve it or ask for changes from here.
 * Once decided, or for an earlier plan picked from the conversation, it's there to read again.
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

  const respond = (decision: PermissionDecision, message?: string) => request && window.glassbox.session.respondPermission(tab.id, request.id, decision, message)
  const approve = () => {
    actions.planStatus(tab.id, 'approved')
    void respond('allow')
  }

  if (!text)
    return (
      <div className="plan-tab">
        <div className="plan-tab-empty muted">{tr('planTab.empty')}</div>
      </div>
    )

  return (
    <div className="plan-tab">
      <div className="plan-tab-head">
        <Icon name="checklist" className={waiting ? 'accent' : 'muted'} />
        <strong>{tr('planTab.title')}</strong>
        {status && <span className={status === 'approved' ? 'tag accent' : 'tag'}>{tr(STATUS[status])}</span>}
        <span className="spacer" />
        {waiting && <span className="muted small">{tr('planTab.nothingChangedYet')}</span>}
      </div>
      {shape && (
        <div className="plan-shape">
          <span className="plan-shape-key" aria-hidden />
          <span className="grow">
            {tr('planTab.shape.touchesModules', { count: shape.modules.length })}
            {shape.modules.some((m) => m.change === 'new') ? tr('planTab.shape.newOfThem', { count: shape.modules.filter((m) => m.change === 'new').length }) : ''}
            {shape.connections.length ? tr('planTab.shape.changesConnections', { count: shape.connections.length }) : ''}
            {tr('planTab.shape.end')}
          </span>
          <button onClick={showMap}>{tr('planTab.seeOnMap')}</button>
        </div>
      )}
      <div className="plan-tab-body markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
      {waiting && (
        <div className="plan-tab-actions">
          {asking && (
            <textarea autoFocus rows={3} placeholder={tr('planTab.feedbackPlaceholder')} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
          )}
          <div className="dialog-actions">
            <span className="muted small">{tr('planTab.approveHint')}</span>
            <span className="spacer" />
            {asking ? (
              <>
                <button onClick={() => setAsking(false)}>{tr('planTab.back')}</button>
                <button
                  className="primary"
                  disabled={!feedback.trim()}
                  onClick={() => {
                    actions.planStatus(tab.id, 'changes-requested')
                    void respond('deny', `The user reviewed your plan and wants changes before you start:\n\n${feedback.trim()}\n\nRevise the plan and present it again.`)
                    setAsking(false)
                    setFeedback('')
                  }}
                >
                  {tr('planTab.sendFeedback')}
                </button>
              </>
            ) : (
              <>
                <button onClick={() => setAsking(true)}>{tr('planTab.requestChanges')}</button>
                <button className="primary" onClick={approve}>
                  {tr('planTab.approvePlan')}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
