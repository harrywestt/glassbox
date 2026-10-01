import { useEffect, useState } from 'react'
import { Icon } from '../components/ui'

type AdminState = { supported: boolean; elevated: boolean; runAsAdmin: boolean; asked: boolean; adminAccount: boolean }

let cached: AdminState | null = null
let open = false
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

function useStore() {
  const [, tick] = useState(0)
  useEffect(() => {
    const l = () => tick((n) => n + 1)
    listeners.add(l)
    if (!cached)
      void window.glassbox.admin.get().then((v) => {
        cached = v
        // First run in the installed app: ask once.
        if (v.supported && !v.asked) open = true
        notify()
      })
    return () => void listeners.delete(l)
  }, [])
}

/** Whether Glassbox (and so Claude's shell) is running with administrator rights. */
export function useAdmin(): AdminState | null {
  useStore()
  return cached
}

/** Opens the administrator dialog (from the dashboard chip or the header badge). */
export function openAdminPrompt() {
  open = true
  notify()
}

/** Small dashboard chip showing the current level; click to change it. */
export function AdminChip() {
  const s = useAdmin()
  if (!s?.supported) return null
  return (
    <button className={s.elevated ? 'admin-chip on' : 'admin-chip'} onClick={openAdminPrompt} title="Change whether Glassbox runs as administrator">
      <Icon name="shield" /> {s.elevated ? 'Administrator' : s.adminAccount ? 'Standard rights' : 'Admin per command'}
    </button>
  )
}

/**
 * The run-as-administrator question: asked once when Glassbox is first started, and whenever you
 * open it again. Elevated, everything Glassbox starts (Claude's shell, your services) has admin rights.
 */
export function AdminPrompt() {
  useStore()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const s = cached
  if (!open || !s) return null

  const close = async () => {
    if (!s.asked) await window.glassbox.admin.dismiss()
    cached = { ...s, asked: true }
    open = false
    setNote(null)
    notify()
  }

  const choose = async (on: boolean) => {
    if (on === s.elevated) return close()
    setBusy(true)
    setNote(null)
    try {
      const ok = await window.glassbox.admin.set(on)
      setNote(ok ? 'Restarting Glassbox…' : 'Windows didn’t grant administrator rights (the prompt was cancelled), so nothing changed.')
      if (ok) cached = { ...s, runAsAdmin: on, asked: true }
    } catch (e) {
      setNote(String(e).replace(/^Error:\s*(Error invoking remote method '[^']+':\s*)?(Error:\s*)?/, ''))
    } finally {
      setBusy(false)
    }
  }

  // A standard account can't elevate as itself: Windows would switch to the admin account, where
  // Claude, gh and git aren't signed in. So Claude asks for admin rights one command at a time.
  if (!s.adminAccount && !s.elevated)
    return (
      <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && void close()}>
        <div className="dialog admin-modal" role="dialog" aria-modal="true" aria-labelledby="admin-title">
          <div className="admin-modal-icon">
            <Icon name="shield" />
          </div>
          <h2 id="admin-title">Administrator commands</h2>
          <p>
            Your Windows account isn’t an administrator, so Glassbox runs as you, signed in to Claude, GitHub and git. When a command needs administrator rights, Claude runs just
            that command elevated: Windows asks for the administrator’s password, and the command runs as that account.
          </p>
          <p className="admin-warning">
            <Icon name="warning" />
            <span>Read each Windows prompt before approving it. An elevated command can change anything on this machine.</span>
          </p>
          <div className="dialog-actions">
            <button className="primary" onClick={() => void close()}>Got it</button>
          </div>
        </div>
      </div>
    )

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && void close()}>
      <div className="dialog admin-modal" role="dialog" aria-modal="true" aria-labelledby="admin-title">
        <div className="admin-modal-icon">
          <Icon name="shield" />
        </div>
        <h2 id="admin-title">{s.elevated ? 'Glassbox is running as administrator' : 'Run Glassbox as administrator?'}</h2>
        <p>
          With administrator rights, Claude’s commands and the services you start run elevated, like an elevated terminal. That lets it install tools, change system
          settings and work with protected folders.
        </p>
        <p className="admin-warning">
          <Icon name="warning" />
          <span>
            An elevated command can change anything on this machine. Guardrails still apply, but keep <strong>Ask</strong> or <strong>Auto-edit</strong> on for work you
            haven’t checked.
          </span>
        </p>
        <p className="muted small">Windows asks for permission each time Glassbox starts elevated. You can change this later from the dashboard.</p>
        {note && <div className="note">{note}</div>}
        <div className="dialog-actions">
          {s.elevated ? (
            <>
              <button disabled={busy} onClick={() => void choose(false)}>Restart with standard rights</button>
              <button className="primary" disabled={busy} onClick={() => void close()}>Keep administrator</button>
            </>
          ) : (
            <>
              <button disabled={busy} onClick={() => void close()}>Not now</button>
              <button className="primary" disabled={busy} onClick={() => void choose(true)}>
                <Icon name="shield" /> Run as administrator
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// Dev aid: lets the screenshot harness open the dialog (it only opens by itself in the installed app).
;(window as unknown as { __glassboxAdmin?: () => void }).__glassboxAdmin = openAdminPrompt
