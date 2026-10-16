import { useState } from 'react'
import { useSession } from '../views/SessionView'
import { Icon } from '../components/ui'
import { tr } from '../../../shared/i18n'
import type { Effort } from '../../../shared/events'

const EFFORT_KEY = 'glassbox.effort'
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** The effort picked for every session (none: each model's default, as in the CLI). */
export function loadEffort(): Effort | null {
  try {
    const v = localStorage.getItem(EFFORT_KEY) as Effort | null
    return v && EFFORTS.includes(v) ? v : null
  } catch {
    return null
  }
}

/** Saves the effort new sessions start with (null: each model's default). */
export function saveEffort(level: Effort | null) {
  try {
    if (level) localStorage.setItem(EFFORT_KEY, level)
    else localStorage.removeItem(EFFORT_KEY)
  } catch {
    /* this session only */
  }
}

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
  const modelName = current?.displayName ?? (s.model ? s.model.replace(/^claude-/, '').replace(/\[1m\]/i, ' (1M)') : fallback ? fallback.description.split(' · ')[0] || fallback.displayName : tr('modelPicker.default'))
  const auto = s.autoModel?.on
  const tierName = s.autoModel?.tier ? tr(`modelPicker.tier.${s.autoModel.tier}`) : null
  const name = auto ? (tierName ? tr('modelPicker.autoWith', { model: tierName }) : tr('modelPicker.auto')) : modelName
  const title = auto ? (s.autoModel?.reason && tierName ? tr('modelPicker.autoTitleWhy', { model: tierName, reason: s.autoModel.reason }) : tr('modelPicker.autoTitle')) : tr('modelPicker.title', { model: name })
  const pick = async (value: string) => {
    setOpen(false)
    if (value === 'auto' ? auto : !auto && value === shown?.value) return
    setBusy(value)
    try {
      await window.glassbox.session.setModel(tab.id, value)
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="model-picker">
      <button className={open ? 'chip-btn on' : 'chip-btn'} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title={title}>
        <Icon name={busy ? 'loading' : 'sparkle'} className={busy ? 'codicon-modifier-spin' : undefined} /> {name}
 <Icon name="chevron-up" />
      </button>
      {open && (
        <>
          <div className="menu-scrim" onMouseDown={() => setOpen(false)} />
          <div className="menu model-menu" role="menu">
            <div className="menu-heading">{tr('modelPicker.heading')}</div>
            <button role="menuitemradio" aria-checked={!!auto} className={auto ? 'menu-item current' : 'menu-item'} onClick={() => void pick('auto')}>
              <span className="model-menu-label">
                {tr('modelPicker.auto')}
                {auto && <Icon name="check" />}
              </span>
              <span className="model-menu-note">{tr('modelPicker.autoNote')}</span>
            </button>
            {models.map((m) => (
              <button key={m.value} role="menuitemradio" aria-checked={!auto && m === shown} className={!auto && m === shown ? 'menu-item current' : 'menu-item'} onClick={() => void pick(m.value)}>
                <span className="model-menu-label">
                  {m.displayName}
                  {!auto && m === shown && <Icon name="check" />}
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

/**
 * How hard Claude thinks, beside the model: a level for this session (and new ones), or each
 * model's default as in the CLI. Higher levels think longer and use more tokens.
 */
export function EffortPicker() {
  const { tab, s } = useSession()
  const [open, setOpen] = useState(false)
  const effort = s.effort?.chosen ?? null
  const name = (l: Effort | null) => (l ? tr(`modelPicker.effort.${l}`) : tr('modelPicker.effort.default'))
  const pick = (level: Effort | null) => {
    setOpen(false)
    saveEffort(level)
    void window.glassbox.session.setEffort(tab.id, level)
  }
  const applied = s.effort?.applied
  const label = effort ? tr('modelPicker.effortChip', { level: tr(`modelPicker.effortName.${effort}`) }) : applied ? tr('modelPicker.effortChip', { level: tr(`modelPicker.effortName.${applied}`) }) : name(null)
  return (
    <div className="model-picker">
      <button className={open ? 'chip-btn on' : 'chip-btn'} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title={tr('modelPicker.effortTitle', { level: label })}>
        <Icon name="dashboard" /> {label} <Icon name="chevron-up" />
      </button>
      {open && (
        <>
          <div className="menu-scrim" onMouseDown={() => setOpen(false)} />
          <div className="menu model-menu effort-menu" role="menu">
            <div className="menu-heading">{tr('modelPicker.effortHeading')}</div>
            {([null, 'low', 'medium', 'high', 'xhigh', 'max'] as (Effort | null)[]).map((l) => (
              <button key={l ?? 'default'} role="menuitemradio" aria-checked={effort === l} className={effort === l ? 'menu-item current' : 'menu-item'} onClick={() => pick(l)}>
                <span className="model-menu-label">
                  {l ? tr(`modelPicker.effortName.${l}`) : tr('modelPicker.effortName.default')}
                  {effort === l && <Icon name="check" />}
                </span>
                <span className="model-menu-note">{l ? tr(`modelPicker.effortTip.${l}`) : tr('modelPicker.effortDefaultTip')}</span>
              </button>
            ))}
            <div className="model-menu-foot muted small">{tr('modelPicker.effortFoot')}</div>
          </div>
        </>
      )}
    </div>
  )
}
