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

export function SessionHeader() {
  const { tab, s, actions, showPanel, everyday } = useSession()

  // Keep the git branch fresh while the tab is open; the host also refreshes after edits.
  useEffect(() => {
    if (s.status === 'new' || s.status === 'stopped') return
    const t = setInterval(() => void window.glassbox.session.refresh(tab.id).catch(() => {}), 20000)
    return () => clearInterval(t)
  }, [tab.id, s.status])

  const changeFolder = async () => {
    const folder = await window.glassbox.pickFolder()
    if (folder) actions.retarget(tab.id, folder)
  }
  const ticket = ticketKeyFromBranch(s.git?.branch)

  return (
    <div className="session-header">
      <div className="sh-left">
        <button className="sh-folder" title={`${tab.cwd}\nClick to change (only before the first message)`} onClick={changeFolder} disabled={s.timeline.length > 0}>
          {baseName(tab.cwd)}
        </button>
        {!everyday && <BranchMenu />}
        {ticket && !everyday && (
          <button className="sh-ticket" title="Open the ticket" onClick={() => showPanel('ticket')}>
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
      title={error ?? (on ? 'Pinned: kept for good. Click to unpin' : 'Pin this session to keep it for good (Claude Code clears old sessions after a while)')}
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
      <button className={open ? 'usage-btn open' : 'usage-btn'} onClick={() => setOpen(!open)} aria-expanded={open} title={`${(100 - usedPct).toFixed(0)}% of the context window left, ${cost.text} so far`}>
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
                  <dt>Model</dt>
                  <dd>{s.model}</dd>
                </>
              )}
              <dt>Context left</dt>
              <dd>
                <span className="num">{(100 - usedPct).toFixed(0)}%</span>
                <Meter value={usedPct} />
              </dd>
              <dt>Tokens</dt>
              <dd className="num">
                {formatTokens(used)} in, {formatTokens(s.usage.outputTokens)} out
              </dd>
              <dt>Cost</dt>
              <dd className="num" title={cost.title}>{cost.text}</dd>
            </dl>
            <button className="btn quiet" onClick={() => void window.glassbox.session.refresh(tab.id)} disabled={s.status === 'new' || s.status === 'stopped'}>
              <Icon name="refresh" /> Refresh context and connectors
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
      <button className="status-btn" title="Restart this session" onClick={() => void window.glassbox.session.open(tab.id, tab.cwd, s.sessionId ?? tab.resumeId, loadAccess())}>
        <span className="tally-lamp tally-err" aria-hidden /> Stopped. Restart
      </button>
    )
  return (
    <span className={`status tally-${tally}`}>
      <span className="tally-lamp" aria-hidden />
      {s.status === 'new' || s.status === 'starting' ? 'Starting' : liveVerb(s)}
      {tally === 'live' && s.busySince && <span className="muted num">{busy >= 60 ? `${Math.floor(busy / 60)}m ${busy % 60}s` : `${busy}s`}</span>}
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
      <button className={open ? 'btn quiet open' : 'btn quiet'} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title="Choose how much of the engineering side this session shows">
        <Icon name={everyday ? 'comment-discussion' : 'tools'} /> {everyday ? 'Everyday' : 'Engineering'} <Icon name="chevron-down" />
      </button>
      {open && (
        <>
          <div className="menu-scrim" onMouseDown={() => setOpen(false)} />
          <div className="menu view-menu" role="menu">
            <button role="menuitemradio" aria-checked={everyday} className={everyday ? 'menu-item current' : 'menu-item'} onClick={() => pick('everyday')}>
              <span className="view-menu-label">Everyday {everyday && <Icon name="check" />}</span>
              <span className="view-menu-note">The conversation, with diagrams, decisions and files. For work that isn’t code.</span>
            </button>
            <button role="menuitemradio" aria-checked={!everyday} className={!everyday ? 'menu-item current' : 'menu-item'} onClick={() => pick('engineering')}>
              <span className="view-menu-label">Engineering {!everyday && <Icon name="check" />}</span>
              <span className="view-menu-note">Adds the map, changes, git, services, tests and review.</span>
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
    <button className="admin-badge" onClick={openAdminPrompt} title="Glassbox is running as administrator, so Claude’s shell commands run elevated. Click to change.">
      <Icon name="shield" /> Admin
    </button>
  )
}
