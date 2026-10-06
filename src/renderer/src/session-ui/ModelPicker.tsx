import { useState } from 'react'
import { useSession } from '../views/SessionView'
import { Icon } from '../components/ui'
import { tr } from '../../../shared/i18n'

/** "claude-opus-5-5[1m]" → "opus-5-5": the part to compare, without the date, the 1M marker or the family prefix. */
const core = (id: string) => id.toLowerCase().replace(/\[.*?\]/g, '').replace(/^claude-/, '').replace(/-\d{8}$/, '')

/**
 * Which model this session is on, always in view by the message box, and a menu to switch. A
 * switch applies from your next message (and sticks if the session restarts).
 */
export function ModelPicker() {
  const { tab, s } = useSession()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const models = s.models ?? []
  if (!s.model && !models.length) return null
  // The row for the model in use: an exact id first; else the same model, preferring a named model
  // over "default" and the matching context size (1M or not).
  const wide = /\[1m\]/i.test(s.model ?? '')
  const score = (m: (typeof models)[number]) =>
    !s.model ? 0 : m.value === s.model ? 100 : (m.resolvedModel && core(m.resolvedModel) === core(s.model)) || core(m.value) === core(s.model) ? 10 + (m.value === 'default' ? 0 : 5) + (/\[1m\]/i.test(m.value) === wide ? 2 : 0) : 0
  const current = models.map((m) => [m, score(m)] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])[0]?.[0]
  // Before the first message the session hasn't said its model: show what the default is.
  const fallback = models.find((m) => m.value === 'default')
  const shown = current ?? (!s.model ? fallback : undefined)
  const name = current?.displayName ?? (s.model ? s.model.replace(/^claude-/, '').replace(/\[1m\]/i, ' (1M)') : fallback ? fallback.description.split(' · ')[0] || fallback.displayName : tr('modelPicker.default'))
  const pick = async (value: string) => {
    setOpen(false)
    if (value === shown?.value) return
    setBusy(value)
    try {
      await window.glassbox.session.setModel(tab.id, value)
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="model-picker">
      <button className={open ? 'chip-btn on' : 'chip-btn'} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title={tr('modelPicker.title', { model: name })}>
        <Icon name={busy ? 'loading' : 'sparkle'} className={busy ? 'codicon-modifier-spin' : undefined} /> {name} <Icon name="chevron-up" />
      </button>
      {open && (
        <>
          <div className="menu-scrim" onMouseDown={() => setOpen(false)} />
          <div className="menu model-menu" role="menu">
            <div className="menu-heading">{tr('modelPicker.heading')}</div>
            {models.map((m) => (
              <button key={m.value} role="menuitemradio" aria-checked={m === shown} className={m === shown ? 'menu-item current' : 'menu-item'} onClick={() => void pick(m.value)}>
                <span className="model-menu-label">
                  {m.displayName}
                  {m === shown && <Icon name="check" />}
                </span>
                {m.description && <span className="model-menu-note">{m.description}</span>}
              </button>
            ))}
            <div className="model-menu-foot muted small">{tr('modelPicker.foot')}</div>
          </div>
        </>
      )}
    </div>
  )
}
