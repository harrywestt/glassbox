import { useEffect, useState } from 'react'
import { useSession } from '../views/SessionView'
import { formatTokens, baseName } from '../lib'
import { Icon, Meter } from '../components/ui'
import { liveVerb, tallyOf } from '../tally'
import { ShareMenu } from './ShareMenu'
import { openAdminPrompt, useAdmin } from '../views/AdminCard'
import { BranchMenu } from './BranchMenu'
import { AccessToggle, loadAccess } from './AccessToggle'
import { money, useFx } from '../money'
import { ticketKeyFromBranch } from '../../../shared/ticket'
import { setPinned, usePinned } from '../pins'
import { tabTitle } from '../tabs'
import { tr } from '../../../shared/i18n'

export function SessionHeader({ active }: { active: boolean }) {
  const { tab, s, actions, showPanel, everyday } = useSession()

  // Keep the git branch fresh while the tab is open; the host also refreshes after edits.
  // Only for the session on screen, and only git: context and connectors refresh after each turn.
  const live = s.status !== 'new' && s.status !== 'stopped'
  useEffect(() => {
    if (!live || !active) return
    const t = setInterval(() => document.visibilityState === 'visible' && void window.glassbox.session.refresh(tab.id, true).catch(() => {}), 20000)
    return () => clearInterval(t)
  }, [tab.id, live, active])

  const changeFolder = async () => {
    const folder = await window.glassbox.pickFolder()
    if (folder) actions.retarget(tab.id, folder)
  }
  const ticket = ticketKeyFromBranch(s.git?.branch)

  return (
    <div className="session-header">
      <div className="sh-left">
        <button className="sh-folder" title={tr('sessionHeader.folderTitle', { path: tab.cwd })} onClick={changeFolder} disabled={s.timeline.length > 0}>
          {baseName(tab.cwd)}
        </button>
        {!everyday && <BranchMenu />}
        {ticket && !everyday && (
          <button className="sh-ticket" title={tr('sessionHeader.openTicket')} onClick={() => showPanel('ticket')}>
            {ticket}
          </button>
        )}
        <StatusPill />
      </div>
      <div className="sh-right">
        <ViewToggle />
        <AdminBadge />
        <AccessToggle />
        <PinButton />
        <ShareMenu />
        <Usage />
      </div>
    </div>
  )
}

/** Pin: keep this session for good, so Claude Code's clean-up of old sessions never removes it. */
function PinButton() {
  const { tab, s } = useSession()
  const pinned = usePinned()
  const [error, setError] = useState<string | null>(null)
  const id = s.sessionId ?? tab.resumeId
  if (!id) return null
  const on = pinned.has(id)
  const toggle = async () => {
    setError(null)
    const title = tabTitle(tab, s)
    const err = await setPinned({ sessionId: id, summary: title, customTitle: title, cwd: tab.cwd, gitBranch: s.git?.branch, lastModified: Date.now() }, !on)
    if (err) setError(err)
  }
  return (
    <button
      className={on ? 'icon-btn pin-btn on' : 'icon-btn pin-btn'}
      aria-pressed={on}
      title={error ?? (on ? tr('sessionHeader.pinnedTitle') : tr('sessionHeader.pinTitle'))}
      onClick={() => void toggle()}
    >
      <Icon name={on ? 'pinned' : 'pin'} />
    </button>
  )
}

/** Context left and cost at a glance; the model, tokens and a refresh behind a click. */
function Usage() {
  const { tab, s } = useSession()
  const [open, setOpen] = useState(false)
  const fx = useFx()
  const cost = money(s.usage.costUsd, 'USD', fx)
  const ctx = s.context
  const max = ctx?.maxTokens ?? 1_000_000
  const used = ctx?.totalTokens ?? s.usage.contextTokens
  const usedPct = Math.min(100, (used / max) * 100)
  const tone = usedPct >= 90 ? 'err' : usedPct >= 70 ? 'warn' : 'ok'
  return (
    <div className="usage">
      <button className={open ? 'usage-btn open' : 'usage-btn'} onClick={() => setOpen(!open)} aria-expanded={open} title={tr('sessionHeader.usageTitle', { percent: (100 - usedPct).toFixed(0), cost: cost.text })}>
        <span className={`usage-ring ${tone}`} style={{ '--used': `${usedPct}%` } as React.CSSProperties} aria-hidden />
        <span className="num">{cost.text}</span>
      </button>
      {open && (
        <>
          <div className="menu-scrim" onMouseDown={() => setOpen(false)} />
          <div className="popover usage-pop">
            <dl className="usage-list">
              {s.model && (
                <>
                  <dt>{tr('sessionHeader.model')}</dt>
                  <dd>{s.model}</dd>
                </>
              )}
              <dt>{tr('sessionHeader.contextLeft')}</dt>
              <dd>
                <span className="num">{tr('sessionHeader.percent', { percent: (100 - usedPct).toFixed(0) })}</span>
                <Meter value={usedPct} />
              </dd>
              <dt>{tr('sessionHeader.tokens')}</dt>
              <dd className="num">
                {tr('sessionHeader.tokensInOut', { input: formatTokens(used), output: formatTokens(s.usage.outputTokens) })}
              </dd>
              <dt>{tr('sessionHeader.cost')}</dt>
              <dd className="num" title={cost.title}>{cost.text}</dd>
            </dl>
            <button className="btn quiet" onClick={() => void window.glassbox.session.refresh(tab.id)} disabled={s.status === 'new' || s.status === 'stopped'}>
              <Icon name="refresh" /> {tr('sessionHeader.refresh')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function StatusPill() {
  const { s, tab } = useSession()
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!s.busySince) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [s.busySince])

  const tally = tallyOf(s)
  const busy = s.busySince ? Math.round((now - s.busySince) / 1000) : 0
  if (s.status === 'stopped')
    return (
      <button className="status-btn" title={tr('sessionHeader.restartTitle')} onClick={() => void window.glassbox.session.open(tab.id, tab.cwd, s.sessionId ?? tab.resumeId, loadAccess(), tab.kind)}>
        <span className="tally-lamp tally-err" aria-hidden /> {tr('sessionHeader.stoppedRestart')}
      </button>
    )
  return (
    <span className={`status tally-${tally}`}>
      <span className="tally-lamp" aria-hidden />
      {s.status === 'new' || s.status === 'starting' ? tr('sessionHeader.starting') : liveVerb(s)}
      {tally === 'live' && s.busySince && <span className="muted num">{busy >= 60 ? tr('sessionHeader.minutesSeconds', { m: Math.floor(busy / 60), s: busy % 60 }) : tr('sessionHeader.seconds', { s: busy })}</span>}
    </span>
  )
}

/**
 * Everyday or Engineering. Everyday is the conversation with diagrams, decisions and files; it
 * leaves out the map, changes, git, services and tests, for work that isn't software.
 */
function ViewToggle() {
  const { tab, actions, everyday } = useSession()
  const [open, setOpen] = useState(false)
  const pick = (view: 'everyday' | 'engineering') => (actions.setView(tab.id, view), setOpen(false))
  return (
    <div className="view-toggle">
      <button className={open ? 'btn quiet open' : 'btn quiet'} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title={tr('sessionHeader.viewTitle')}>
        <Icon name={everyday ? 'comment-discussion' : 'tools'} /> {everyday ? tr('sessionHeader.everyday') : tr('sessionHeader.engineering')} <Icon name="chevron-down" />
      </button>
      {open && (
        <>
          <div className="menu-scrim" onMouseDown={() => setOpen(false)} />
          <div className="menu view-menu" role="menu">
            <button role="menuitemradio" aria-checked={everyday} className={everyday ? 'menu-item current' : 'menu-item'} onClick={() => pick('everyday')}>
              <span className="view-menu-label">{tr('sessionHeader.everyday')} {everyday && <Icon name="check" />}</span>
              <span className="view-menu-note">{tr('sessionHeader.everydayNote')}</span>
            </button>
            <button role="menuitemradio" aria-checked={!everyday} className={!everyday ? 'menu-item current' : 'menu-item'} onClick={() => pick('engineering')}>
              <span className="view-menu-label">{tr('sessionHeader.engineering')} {!everyday && <Icon name="check" />}</span>
              <span className="view-menu-note">{tr('sessionHeader.engineeringNote')}</span>
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** Shown while Glassbox runs as administrator: Claude's commands have admin rights. */
function AdminBadge() {
  const admin = useAdmin()
  if (!admin?.elevated) return null
  return (
    <button className="admin-badge" onClick={openAdminPrompt} title={tr('sessionHeader.adminTitle')}>
      <Icon name="shield" /> {tr('sessionHeader.admin')}
    </button>
  )
}
