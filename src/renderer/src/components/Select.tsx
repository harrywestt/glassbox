import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './ui'
import { tr } from '../../../shared/i18n'

export type SelectOption<T extends string> = { value: T; label: string; hint?: string }

type Props<T extends string> = {
  value: T
  options: SelectOption<T>[]
  onChange: (v: T) => void
  disabled?: boolean
  placeholder?: string
  title?: string
  className?: string
  'aria-label'?: string
}

const SEARCH_FROM = 10

/**
 * A themed dropdown in place of the native <select>, whose popup Windows draws in its own style.
 * The list stays inside the window (flipping above the button when there's no room below) and gets
 * a filter box when there are many options.
 */
export function Select<T extends string>({ value, options, onChange, disabled, placeholder, title, className, ...rest }: Props<T>) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const current = options.find((o) => o.value === value)

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`select-btn${open ? ' open' : ''}${className ? ` ${className}` : ''}`}
        disabled={disabled}
        title={title ?? current?.label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={rest['aria-label']}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span className="select-value">{current?.label ?? placeholder ?? ''}</span>
        <Icon name="chevron-down" className="select-caret" />
      </button>
      {open &&
        button.current &&
        createPortal(
          <SelectList
            anchor={button.current}
            options={options}
            value={value}
            onPick={(v) => {
              setOpen(false)
              if (v !== value) onChange(v)
              button.current?.focus()
            }}
            onClose={() => setOpen(false)}
          />,
          document.body
        )}
    </>
  )
}

function SelectList<T extends string>({ anchor, options, value, onPick, onClose }: { anchor: HTMLElement; options: SelectOption<T>[]; value: T; onPick: (v: T) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [q, setQ] = useState('')
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number } | null>(null)
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase()
    return n ? options.filter((o) => o.label.toLowerCase().includes(n)) : options
  }, [options, q])
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)))

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect()
    const margin = 8
    const below = window.innerHeight - r.bottom - margin
    const above = r.top - margin
    const width = Math.min(Math.max(r.width, 200), window.innerWidth - margin * 2)
    const left = Math.max(margin, Math.min(r.left, window.innerWidth - width - margin))
    const flip = below < 220 && above > below
    setPos(flip ? { left, bottom: window.innerHeight - r.top + 4, width, maxHeight: Math.min(360, above - 4) } : { left, top: r.bottom + 4, width, maxHeight: Math.min(360, below - 4) })
  }, [anchor])

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose()
    }
    const blur = () => onClose()
    window.addEventListener('mousedown', down, true)
    window.addEventListener('blur', blur)
    window.addEventListener('resize', blur)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('blur', blur)
      window.removeEventListener('resize', blur)
    }
  }, [anchor, onClose])

  // Keep the highlighted option in view.
  useEffect(() => {
    box.current?.querySelector('.select-option.active')?.scrollIntoView({ block: 'nearest' })
  }, [active, pos])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') return e.preventDefault(), onClose()
    if (e.key === 'ArrowDown') return e.preventDefault(), setActive((a) => Math.min(shown.length - 1, a + 1))
    if (e.key === 'ArrowUp') return e.preventDefault(), setActive((a) => Math.max(0, a - 1))
    if (e.key === 'Enter' && shown[active]) return e.preventDefault(), onPick(shown[active].value)
  }

  if (!pos) return null
  return (
    <div
      ref={box}
      className="select-pop"
      role="listbox"
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxHeight }}
      onKeyDown={onKey}
    >
      {options.length >= SEARCH_FROM && (
        <div className="search select-search">
          <Icon name="search" />
          <input
            autoFocus
            placeholder={tr('select.filter')}
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setActive(0)
            }}
          />
        </div>
      )}
      <div className="select-options">
        {shown.map((o, i) => (
          <div
            key={o.value}
            role="option"
            aria-selected={o.value === value}
            className={`select-option${i === active ? ' active' : ''}${o.value === value ? ' selected' : ''}`}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(o.value)}
          >
            <Icon name="check" className="select-check" />
            {/* A short hint (a status) sits on the right; a longer one is a description, under the name. */}
            {o.hint && o.hint.length > 24 ? (
              <span className="grow select-text">
                <span className="select-text-label">{o.label}</span>
                <span className="muted small">{o.hint}</span>
              </span>
            ) : (
              <>
                <span className="grow ellipsis">{o.label}</span>
                {o.hint && <span className="muted small">{o.hint}</span>}
              </>
            )}
          </div>
        ))}
        {shown.length === 0 && <div className="muted small pad">{tr('select.noMatches')}</div>}
      </div>
      {options.length < SEARCH_FROM && <FocusOnMount target={box} />}
    </div>
  )
}

/** Moves keyboard focus into the list when it has no filter box, so arrow keys work straight away. */
function FocusOnMount({ target }: { target: React.RefObject<HTMLDivElement | null> }) {
  useEffect(() => target.current?.focus(), [target])
  return null
}
