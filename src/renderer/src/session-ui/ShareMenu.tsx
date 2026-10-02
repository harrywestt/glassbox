import { useEffect, useRef, useState } from 'react'
import { useSession } from '../views/SessionView'
import { tabTitle } from '../tabs'
import { Icon } from '../components/ui'
import { sessionBrief } from '../side'
import { tr } from '../../../shared/i18n'

/** Let other people see what this session is doing: a live read-only link, or a status post. */
export function ShareMenu() {
  const { tab, s, runSide } = useSession()
  const [open, setOpen] = useState(false)
  const [link, setLink] = useState<{ url: string; lanUrl: string | null } | null>(null)
  const [target, setTarget] = useState('')
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const canSend = s.status !== 'new' && s.status !== 'stopped'
  const [handoff, setHandoff] = useState<{ text: string; prUrl?: string; error?: string } | null>(null)
  const [writing, setWriting] = useState(false)
  const [handoffCopied, setHandoffCopied] = useState(false)

  const writeHandoff = async () => {
    setWriting(true)
    setHandoff(null)
    try {
      const h = await window.glassbox.handoff(tab.cwd, sessionBrief(s, tab.cwd))
      setHandoff(h)
      if (h.text) {
        await navigator.clipboard.writeText(h.text)
        setHandoffCopied(true)
        setTimeout(() => setHandoffCopied(false), 2000)
      }
    } finally {
      setWriting(false)
    }
  }

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const share = async () => setLink(await window.glassbox.watch.share(tab.id, tabTitle(tab, s), tab.cwd))
  const stop = async () => {
    await window.glassbox.watch.unshare(tab.id)
    setLink(null)
  }
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  const post = () => {
    const where = target.trim()
    runSide({
      kind: 'status',
      title: tr('shareMenu.statusTaskTitle', { where }),
      tools: [],
      prompt: `Post a short status update about the main session to ${where} using the right connector. Cover what's done, what's in progress, what's next, and any blockers or open questions, in under eight lines, written for teammates who haven't seen the session. Glassbox will ask the user to approve the post before it goes out.`
    })
    setTarget('')
    setOpen(false)
  }

  return (
    <div className="share" ref={ref}>
      <button className={link ? 'run-btn live' : 'run-btn ghost'} onClick={() => setOpen(!open)} title={tr('shareMenu.shareTitle')}>
        <Icon name={link ? 'broadcast' : 'live-share'} /> {link ? tr('shareMenu.live') : tr('shareMenu.share')}
      </button>
      {open && (
        <div className="popover share-pop">
          <div className="pop-section">
            <div className="pop-title">{tr('shareMenu.handoffTitle')}</div>
            <p className="muted small">{tr('shareMenu.handoffNote')}</p>
            {handoff?.error && <div className="note note-error">{handoff.error}</div>}
            {handoff?.text && (
              <>
                <textarea className="handoff-text" rows={5} value={handoff.text} onChange={(e) => setHandoff({ ...handoff, text: e.target.value })} />
                {!handoff.prUrl && <p className="muted small">{tr('shareMenu.noPr')}</p>}
              </>
            )}
            <div className="row-actions">
              <span className="spacer" />
              {handoff?.text && (
                <button onClick={() => copy(handoff.text)}>
                  <Icon name={copied ? 'check' : 'copy'} /> {tr('shareMenu.copy')}
                </button>
              )}
              <button className="primary" disabled={writing} onClick={() => void writeHandoff()}>
                {writing ? <><Icon name="loading" className="codicon-modifier-spin" /> {tr('shareMenu.writing')}</> : handoffCopied ? <><Icon name="check" /> {tr('shareMenu.copied')}</> : <><Icon name="copy" /> {handoff?.text ? tr('shareMenu.writeAgain') : tr('shareMenu.copyHandoff')}</>}
              </button>
            </div>
          </div>
          <div className="pop-section">
            <div className="pop-title">{tr('shareMenu.liveViewTitle')}</div>
            <p className="muted small">{tr('shareMenu.liveViewNote')}</p>
            {link ? (
              <>
                {[link.lanUrl, link.url].filter(Boolean).map((u) => (
                  <div key={u} className="link-row">
                    <span className="mono small ellipsis grow">{u}</span>
                    <button className="icon-btn" title={tr('shareMenu.copy')} onClick={() => copy(u!)}><Icon name={copied ? 'check' : 'copy'} /></button>
                    <button className="icon-btn" title={tr('shareMenu.open')} onClick={() => void window.glassbox.openExternal(u!)}><Icon name="link-external" /></button>
                  </div>
                ))}
                <div className="row-actions">
                  <span className="muted small">{tr('shareMenu.firewallNote')}</span>
                  <span className="spacer" />
                  <button onClick={() => void stop()}>{tr('shareMenu.stopSharing')}</button>
                </div>
              </>
            ) : (
              <button className="primary" onClick={() => void share()}><Icon name="broadcast" /> {tr('shareMenu.startLiveView')}</button>
            )}
          </div>
          <div className="pop-section">
            <div className="pop-title">{tr('shareMenu.statusTitle')}</div>
            <p className="muted small">{tr('shareMenu.statusNote')}</p>
            <div className="link-row">
              <input className="grow" placeholder={tr('shareMenu.statusPlaceholder')} value={target} onChange={(e) => setTarget(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && target.trim() && canSend && post()} />
              <button className="primary" disabled={!target.trim() || !canSend} onClick={post}>{tr('shareMenu.draft')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
