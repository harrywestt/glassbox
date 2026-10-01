import { useCallback, useEffect, useState } from 'react'
import type { AccountItem, AccountsResult } from '../../../shared/events'
import { Icon } from '../components/ui'

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

  const load = useCallback((force = false) => {
    setChecking(true)
    window.glassbox.accounts
      .get(force)
      .then(setData)
      .catch(() => {})
      .finally(() => setChecking(false))
  }, [])

  useEffect(() => load(false), [load])
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
      <button className={open ? 'btn accounts-btn open' : 'btn accounts-btn'} onClick={() => setOpen(!open)} aria-expanded={open} title={waiting.length ? `${waiting.length} account${waiting.length > 1 ? 's' : ''} need${waiting.length > 1 ? '' : 's'} signing in` : 'Signed in everywhere Glassbox needs'}>
        {/* The lamp only lights when something needs signing in: amber is "needs you". */}
        {data && waiting.length > 0 && <span className="tally-lamp tally-wait" aria-hidden />}
        Accounts
      </button>
      {open && (
        <>
          <div className="menu-scrim" onMouseDown={() => setOpen(false)} />
          <div className="popover accounts-pop" role="dialog" aria-label="Accounts">
            {!data ? (
              <div className="accounts-row muted">Checking…</div>
            ) : (
              <>
                {core.map((a) => <Row key={a.id} a={a} />)}
                {others.length > 0 && (
                  <>
                    <div className="accounts-heading">Other connectors</div>
                    {connected.map((a) => <Row key={a.id} a={a} />)}
                    {available.length > 0 && !allConnectors && (
                      <button className="btn quiet accounts-more" onClick={() => setAllConnectors(true)}>
                        Show {available.length} not connected
                      </button>
                    )}
                    {allConnectors && available.map((a) => <Row key={a.id} a={a} quiet />)}
                  </>
                )}
              </>
            )}
            <div className="accounts-foot">
              <button className="btn quiet" onClick={() => load(true)} disabled={checking}>
                <Icon name={checking ? 'loading' : 'refresh'} className={checking ? 'codicon-modifier-spin' : ''} /> Check again
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Row({ a, quiet }: { a: AccountItem; quiet?: boolean }) {
  const action =
    a.status === 'ok' ? (a.kind === 'connector' ? 'Manage' : null) : a.status === 'missing' ? 'Install' : a.kind === 'connector' ? 'Connect' : 'Sign in'
  return (
    <div className="accounts-row">
      {/* A connector you've never used isn't a warning: just an empty lamp. */}
      {a.status === 'ok' ? <Icon name="check" className="accounts-ok" /> : <span className={`tally-lamp ${quiet ? '' : 'tally-wait'}`} aria-hidden />}
      <span className="accounts-name">
        <span>{a.name}</span>
        {a.detail && <span className="accounts-detail">{a.detail}</span>}
      </span>
      {action && (
        <button className={a.status === 'ok' || quiet ? 'btn quiet' : 'btn'} onClick={() => void window.glassbox.accounts.signIn(a.status === 'missing' ? 'github-install' : a.id)}>
          {action}
        </button>
      )}
    </div>
  )
}
