import { useEffect, useRef, useSyncExternalStore } from 'react'
import { Icon } from './ui'
import { tr } from '../../../shared/i18n'

/**
 * Glassbox's own "are you sure?", in place of the system's confirm box: the same dialog as the rest
 * of the app. `confirm()` resolves true or false; Enter confirms, Esc or a click outside cancels.
 */

type Ask = { title: string; body?: string; confirm?: string; danger?: boolean; resolve: (ok: boolean) => void }
let current: Ask | null = null
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((l) => l())

export function confirm(ask: Omit<Ask, 'resolve'>): Promise<boolean> {
  current?.resolve(false)
  return new Promise((resolve) => {
    current = { ...ask, resolve }
    changed()
  })
}

/** Shown once, at the top of the app. */
export function ConfirmHost() {
  const ask = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current
  )
  const yes = useRef<HTMLButtonElement>(null)
  useEffect(() => yes.current?.focus(), [ask])
  if (!ask) return null
  const answer = (ok: boolean) => {
    current = null
    changed()
    ask.resolve(ok)
  }
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && answer(false)} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), answer(false))}>
      <div className="dialog confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <div className="dialog-title" id="confirm-title">
          <Icon name={ask.danger ? 'warning' : 'question'} className={ask.danger ? 'confirm-danger-icon' : undefined} />
          {ask.title}
        </div>
        {ask.body && <p className="muted confirm-body">{ask.body}</p>}
        <div className="dialog-actions">
          <span className="grow" />
          <button className="btn" onClick={() => answer(false)}>
            {tr('confirmDialog.cancel')}
          </button>
          <button ref={yes} className={ask.danger ? 'btn danger-fill' : 'primary'} onClick={() => answer(true)}>
            {ask.confirm ?? tr('confirmDialog.ok')}
          </button>
        </div>
      </div>
    </div>
  )
}
