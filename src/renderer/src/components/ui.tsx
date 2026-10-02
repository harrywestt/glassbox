import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { tr } from '../../../shared/i18n'

/**
 * How a panel's header renders. On its own ('solo') the tab or work tab already names it, so only
 * its buttons show; stacked with others in one tab ('stacked') its title becomes the section heading.
 */
export const PanelActionsContext = createContext<'solo' | 'stacked'>('solo')

export function Icon({ name, className = '', title }: { name: string; className?: string; title?: string }) {
  return <i className={`codicon codicon-${name} ${className}`} title={title} aria-hidden={!title} />
}

export function IconButton({
  icon,
  title,
  onClick,
  active,
  disabled
}: {
  icon: string
  title: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
}) {
  return (
    <button className={active ? 'icon-btn active' : 'icon-btn'} title={title} aria-label={title} onClick={onClick} disabled={disabled}>
      <Icon name={icon} />
    </button>
  )
}

export function Meter({ value, tone }: { value: number; tone?: 'ok' | 'warn' | 'err' }) {
  const t = tone ?? (value >= 90 ? 'err' : value >= 70 ? 'warn' : 'ok')
  return (
    <div className="meter">
      <div className={`meter-fill meter-${t}`} style={{ transform: `scaleX(${Math.min(100, Math.max(0, value)) / 100})` }} />
    </div>
  )
}

/** Nothing to show yet: one plain line, and at most a short second line saying what will appear. */
export function Empty({ title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  )
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({ checked, onChange, title, disabled }: { checked: boolean; onChange: (v: boolean) => void; title?: string; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={checked} title={title} disabled={disabled} className={checked ? 'switch on' : 'switch'} onClick={() => onChange(!checked)}>
      <span />
    </button>
  )
}

/** Placeholder bars shown while content loads, shaped roughly like what will appear. */
export function Skeleton({ lines = 3, widths }: { lines?: number; widths?: string[] }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label={tr('ui.loading')}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton-bar" style={{ width: widths?.[i % widths.length] ?? `${92 - ((i * 17) % 35)}%` }} />
      ))}
    </div>
  )
}

/** Skeleton rows for lists: an icon-sized block, a line of text and a short meta block. */
export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label={tr('ui.loading')}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row">
          <span className="skeleton-bar sq" />
          <span className="skeleton-bar" style={{ width: `${70 - ((i * 13) % 30)}%` }} />
          <span className="skeleton-bar meta" />
        </div>
      ))}
    </div>
  )
}

export function PanelHeader({ title, children }: { title: string; children?: ReactNode }) {
  const mode = useContext(PanelActionsContext)
  const fold = useFoldPanel(title, mode === 'stacked')
  if (mode === 'solo') return children ? <div className="panel-header actions-only">{children}</div> : null
  return (
    <div className="panel-header" ref={fold.ref}>
      <button className="section-toggle panel-title" aria-expanded={!fold.folded} onClick={fold.toggle}>
        <Icon name="chevron-down" className="section-chevron" />
        {title}
      </button>
      <span className="spacer" />
      {children}
    </div>
  )
}

// ── Sections you can fold away (side panels) ──

const FOLDED_KEY = 'glassbox.folded'
const FOLDED_EVENT = 'glassbox:folded'
function loadFolded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}
/** Whether a section is folded, remembered across sessions and shared by every panel showing it. */
export function useFolded(id: string): [boolean, () => void] {
  const [folded, setFolded] = useState(() => loadFolded().has(id))
  useEffect(() => {
    const update = () => setFolded(loadFolded().has(id))
    window.addEventListener(FOLDED_EVENT, update)
    return () => window.removeEventListener(FOLDED_EVENT, update)
  }, [id])
  const toggle = () => {
    const all = loadFolded()
    if (all.has(id)) all.delete(id)
    else all.add(id)
    try {
      localStorage.setItem(FOLDED_KEY, JSON.stringify([...all]))
    } catch {
      /* folded for now only */
    }
    setFolded(all.has(id))
    window.dispatchEvent(new CustomEvent(FOLDED_EVENT))
  }
  return [folded, toggle]
}

/**
 * A side-panel section with a heading you click to fold it away. `meta` sits beside the title
 * (a count, a short note); `actions` sit at the right and stay clickable when folded.
 */
export function Section({ id, title, meta, actions, className = '', tip, children }: { id: string; title: ReactNode; meta?: ReactNode; actions?: ReactNode; className?: string; tip?: string; children?: ReactNode }) {
  const [folded, toggle] = useFolded(`section:${id}`)
  return (
    <section className={`card section${folded ? ' folded' : ''} ${className}`}>
      <div className="card-title section-head">
        <button className="section-toggle" aria-expanded={!folded} onClick={toggle} title={tip}>
          <Icon name="chevron-down" className="section-chevron" />
          <span className="section-title">{title}</span>
          {meta}
        </button>
        {actions && (
          <>
            <span className="spacer" />
            {actions}
          </>
        )}
      </div>
      {!folded && children}
    </section>
  )
}

/**
 * A stacked panel's heading (Services, Agents under Route) folds its panel too: the rest of the
 * panel hides while the heading and its buttons stay.
 */
function useFoldPanel(title: string, on: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  const [folded, toggle] = useFolded(`panel:${title}`)
  useLayoutEffect(() => {
    const panel = ref.current?.parentElement
    if (!panel || !on) return
    panel.classList.toggle('folded', folded)
    return () => panel.classList.remove('folded')
  }, [folded, on])
  return { ref, folded, toggle }
}
