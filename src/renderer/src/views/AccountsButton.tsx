import { useCallback, useEffect, useState } from 'react'
import type { AccountItem, AccountsResult, SignInState } from '../../../shared/events'
import { Icon } from '../components/ui'
import { tr } from '../../../shared/i18n'

const needsYou = (a: AccountItem) => a.status !== 'ok'

/**
 * Everything Glassbox needs you signed in to, behind one button: Claude, GitHub and the claude.ai
 * connectors (Jira first). An amber lamp on the button means something needs signing in.
 */
export function AccountsButton() {
  const [data, setData] = useState<AccountsResult | null>(null)
  const [open, setOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const [allConnectors, setAllConnectors] = useState(false)
  // Sign-ins running in Glassbox, by account.
  const [signing, setSigning] = useState<Record<string, SignInState>>({})

  const load = useCallback((force = false) => {
    setChecking(true)
    window.glassbox.accounts
      .get(force)
      .then(setData)
      .catch(() => {})
      .finally(() => setChecking(false))
  }, [])

  useEffect(() => load(false), [load])
  useEffect(
    () =>
      window.glassbox.accounts.onSignIn((st) => {
        setSigning((prev) => ({ ...prev, [st.id]: st }))
        // Signed in: look again, and put the finished sign-in away after a moment.
        if (st.status === 'done') {
          load(true)
          setTimeout(() => setSigning((prev) => (prev[st.id]?.status === 'done' ? (({ [st.id]: _, ...rest }) => rest)(prev) : prev)), 2500)
        }
      }),
    [load]
  )
  const close = (id: string) => {
    void window.glassbox.accounts.signInCancel(id)
    setSigning(({ [id]: _, ...rest }) => rest)
  }
  // Coming back from a sign-in (a terminal or claude.ai), look again.
  useEffect(() => {
    const onFocus = () => load(true)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])

  const items = data?.items ?? []
  // What Glassbox relies on: Claude, GitHub and Jira. Only these light the warning.
  const core = items.filter((a) => a.kind !== 'connector' || /jira/i.test(a.name))
  const waiting = core.filter(needsYou)
  const others = items.filter((a) => a.kind === 'connector' && !/jira/i.test(a.name))
  const connected = others.filter((a) => !needsYou(a))
  const available = others.filter(needsYou)

  return (
    <div className="accounts">
      <button className={open ? 'btn accounts-btn open' : 'btn accounts-btn'} onClick={() => setOpen(!open)} aria-expanded={open} title={waiting.length ? tr('accountsButton.needSigningIn', { count: waiting.length }) : tr('accountsButton.signedInEverywhere')}>
        {/* The lamp only lights when something needs signing in: amber is "needs you". */}
        {data && waiting.length > 0 && <span className="tally-lamp tally-wait" aria-hidden />}
        {tr('accountsButton.accounts')}
      </button>
      {open && (
        <>
          <div className="menu-scrim" onMouseDown={() => setOpen(false)} />
          <div className="popover accounts-pop" role="dialog" aria-label={tr('accountsButton.accounts')}>
            {!data ? (
              <div className="accounts-row muted">{tr('accountsButton.checking')}</div>
            ) : (
              <>
                {core.map((a) => <Row key={a.id} a={a} signing={signing[a.id]} onClose={() => close(a.id)} />)}
                {others.length > 0 && (
                  <>
                    <div className="accounts-heading">{tr('accountsButton.otherConnectors')}</div>
                    {connected.map((a) => <Row key={a.id} a={a} />)}
                    {available.length > 0 && !allConnectors && (
                      <button className="btn quiet accounts-more" onClick={() => setAllConnectors(true)}>
                        {tr('accountsButton.showNotConnected', { count: available.length })}
                      </button>
                    )}
                    {allConnectors && available.map((a) => <Row key={a.id} a={a} quiet />)}
                  </>
                )}
              </>
            )}
            <div className="accounts-foot">
              <button className="btn quiet" onClick={() => load(true)} disabled={checking}>
                <Icon name={checking ? 'loading' : 'refresh'} className={checking ? 'codicon-modifier-spin' : ''} /> {tr('accountsButton.checkAgain')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Row({ a, quiet, signing, onClose }: { a: AccountItem; quiet?: boolean; signing?: SignInState; onClose?: () => void }) {
  const action =
    a.status === 'ok' ? (a.kind === 'connector' ? tr('accountsButton.manage') : null) : a.status === 'missing' ? tr('accountsButton.install') : a.kind === 'connector' ? tr('accountsButton.connect') : tr('accountsButton.signIn')
  return (
    <>
    <div className="accounts-row">
      {/* A connector you've never used isn't a warning: just an empty lamp. */}
      {a.status === 'ok' ? <Icon name="check" className="accounts-ok" /> : <span className={`tally-lamp ${quiet ? '' : 'tally-wait'}`} aria-hidden />}
      <span className="accounts-name">
        <span>{a.name}</span>
        {a.detail && <span className="accounts-detail">{a.detail}</span>}
      </span>
      {action && (
        <button className={a.status === 'ok' || quiet ? 'btn quiet' : 'btn'} disabled={signing?.status === 'running'} onClick={() => void window.glassbox.accounts.signIn(a.status === 'missing' ? 'github-install' : a.id)}>
          {action}
        </button>
      )}
    </div>
    {signing && onClose && <SignIn s={signing} onClose={onClose} />}
    </>
  )
}

/** A sign-in happening here: the page to open, the code to give it, and a box for a code it hands back. */
function SignIn({ s, onClose }: { s: SignInState; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const [reply, setReply] = useState('')
  const [sent, setSent] = useState(false)
  const openPage = () => {
    if (s.code) {
      void navigator.clipboard.writeText(s.code)
      setCopied(true)
    }
    if (s.url) window.open(s.url, '_blank')
  }
  const send = () => {
    if (!reply.trim()) return
    void window.glassbox.accounts.signInInput(s.id, reply)
    setReply('')
    setSent(true)
  }
  if (s.status === 'done')
    return (
      <div className="signin done" role="status">
        <Icon name="pass-filled" className="ok" /> {tr('accountsButton.signedIn')}
      </div>
    )
  if (s.status === 'failed')
    return (
      <div className="signin failed" role="alert">
        <div className="signin-line">
          <Icon name="error" className="err" />
          <span className="grow">{s.error || tr('accountsButton.signInFailed')}</span>
          <button className="btn quiet" onClick={onClose}>{tr('accountsButton.dismiss')}</button>
        </div>
      </div>
    )
  return (
    <div className="signin" role="group" aria-label={tr('accountsButton.signingIn')}>
      {s.code ? (
        <>
          <div className="signin-step">{tr('accountsButton.enterCode')}</div>
          <div className="signin-code num">{s.code}</div>
          <button className="btn primary signin-go" onClick={openPage} disabled={!s.url}>
            <Icon name={copied ? 'check' : 'link-external'} /> {copied ? tr('accountsButton.codeCopied') : tr('accountsButton.copyAndOpen')}
          </button>
        </>
      ) : s.url ? (
        <>
          <div className="signin-step">{tr('accountsButton.finishInBrowser')}</div>
          <button className="btn signin-go" onClick={openPage}>
            <Icon name="link-external" /> {tr('accountsButton.openPage')}
          </button>
        </>
      ) : (
        <div className="signin-step muted">
          <Icon name="loading" className="codicon-modifier-spin" /> {tr('accountsButton.starting')}
        </div>
      )}
      {s.asksForCode && (
        <div className="signin-reply">
          <input value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} placeholder={tr('accountsButton.pasteCode')} aria-label={tr('accountsButton.pasteCode')} />
          <button className="btn" disabled={!reply.trim()} onClick={send}>{sent ? tr('accountsButton.sendAgain') : tr('accountsButton.send')}</button>
        </div>
      )}
      <div className="signin-foot">
        <span className="muted small grow">
          <Icon name="loading" className="codicon-modifier-spin" /> {tr('accountsButton.waiting')}
        </span>
        <button className="link small" onClick={onClose}>{tr('accountsButton.cancel')}</button>
      </div>
    </div>
  )
}
