import { useEffect, useRef, useState } from 'react'
import { useSession } from '../views/SessionView'
import { tabTitle } from '../tabs'
import { Icon } from '../components/ui'
import { sessionBrief } from '../side'

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
      title: `Status update to ${where}`,
      tools: [],
      prompt: `Post a short status update about the main session to ${where} using the right connector. Cover what's done, what's in progress, what's next, and any blockers or open questions, in under eight lines, written for teammates who haven't seen the session. Glassbox will ask the user to approve the post before it goes out.`
    })
    setTarget('')
    setOpen(false)
  }

  return (
    <div className="share" ref={ref}>
      <button className={link ? 'run-btn live' : 'run-btn ghost'} onClick={() => setOpen(!open)} title="Share this session">
        <Icon name={link ? 'broadcast' : 'live-share'} /> {link ? 'Live' : 'Share'}
      </button>
      {open && (
        <div className="popover share-pop">
          <div className="pop-section">
            <div className="pop-title">Hand it off</div>
            <p className="muted small">A short message for a teammate: the PR, what it does in three sentences at most, and the link. Copied as soon as it’s written.</p>
            {handoff?.error && <div className="note note-error">{handoff.error}</div>}
            {handoff?.text && (
              <>
                <textarea className="handoff-text" rows={5} value={handoff.text} onChange={(e) => setHandoff({ ...handoff, text: e.target.value })} />
                {!handoff.prUrl && <p className="muted small">No PR found for this branch, so there’s no link. Open one and write it again to include it.</p>}
              </>
            )}
            <div className="row-actions">
              <span className="spacer" />
              {handoff?.text && (
                <button onClick={() => copy(handoff.text)}>
                  <Icon name={copied ? 'check' : 'copy'} /> Copy
                </button>
              )}
              <button className="primary" disabled={writing} onClick={() => void writeHandoff()}>
                {writing ? <><Icon name="loading" className="codicon-modifier-spin" /> Writing…</> : handoffCopied ? <><Icon name="check" /> Copied</> : <><Icon name="copy" /> {handoff?.text ? 'Write again' : 'Copy a handoff message'}</>}
              </button>
            </div>
          </div>
          <div className="pop-section">
            <div className="pop-title">Live view</div>
            <p className="muted small">A read-only page anyone on your network can open to watch this session. It shows activity and decisions, never file contents.</p>
            {link ? (
              <>
                {[link.lanUrl, link.url].filter(Boolean).map((u) => (
                  <div key={u} className="link-row">
                    <span className="mono small ellipsis grow">{u}</span>
                    <button className="icon-btn" title="Copy" onClick={() => copy(u!)}><Icon name={copied ? 'check' : 'copy'} /></button>
                    <button className="icon-btn" title="Open" onClick={() => void window.glassbox.openExternal(u!)}><Icon name="link-external" /></button>
                  </div>
                ))}
                <div className="row-actions">
                  <span className="muted small">Windows may ask to allow Glassbox on private networks the first time.</span>
                  <span className="spacer" />
                  <button onClick={() => void stop()}>Stop sharing</button>
                </div>
              </>
            ) : (
              <button className="primary" onClick={() => void share()}><Icon name="broadcast" /> Start live view</button>
            )}
          </div>
          <div className="pop-section">
            <div className="pop-title">Post a status update</div>
            <p className="muted small">Claude writes it in the background, and you approve the post before it’s sent.</p>
            <div className="link-row">
              <input className="grow" placeholder="#team-channel in Slack, or a Jira ticket like NSD-1234" value={target} onChange={(e) => setTarget(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && target.trim() && canSend && post()} />
              <button className="primary" disabled={!target.trim() || !canSend} onClick={post}>Draft</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
