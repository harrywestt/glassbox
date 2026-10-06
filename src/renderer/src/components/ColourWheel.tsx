import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { hexToHsl, hslToHex } from '../colour'
import { tr } from '../../../shared/i18n'

const SIZE = 168

/**
 * Pick any colour: hue round the wheel, strength out from the centre. Lightness is left to the
 * theme, which keeps the accent readable on dark and light backgrounds. Arrow keys move the
 * marker (left/right: hue; up/down: strength), and the hex field takes a colour typed or pasted.
 */
export function ColourWheel({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const [h, s] = hexToHsl(value)
  const [hex, setHex] = useState(value)
  const wheel = useRef<HTMLDivElement>(null)
  useEffect(() => setHex(value), [value])

  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const r = wheel.current!.getBoundingClientRect()
    const x = e.clientX - r.left - r.width / 2
    const y = e.clientY - r.top - r.height / 2
    const hue = (Math.atan2(y, x) * 180) / Math.PI + 90
    const sat = Math.min(1, Math.hypot(x, y) / (r.width / 2))
    onChange(hslToHex((hue + 360) % 360, sat, 0.6))
  }
  const key = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 15 : 5
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, 0.05], ArrowDown: [0, -0.05] }
    const m = moves[e.key]
    if (!m) return
    e.preventDefault()
    onChange(hslToHex((h + m[0] + 360) % 360, Math.min(1, Math.max(0, s + m[1])), 0.6))
  }
  // The marker: the angle is the hue (red at the top), the distance the strength.
  const rad = ((h - 90) * Math.PI) / 180
  const mx = SIZE / 2 + Math.cos(rad) * s * (SIZE / 2)
  const my = SIZE / 2 + Math.sin(rad) * s * (SIZE / 2)

  return (
    <div className="colour-wheel">
      <div
        ref={wheel}
        className="colour-wheel-disc"
        role="slider"
        tabIndex={0}
        aria-label={tr('colourWheel.label')}
        aria-valuetext={value}
        aria-valuenow={Math.round(h)}
        aria-valuemin={0}
        aria-valuemax={359}
        style={{ width: SIZE, height: SIZE }}
        onPointerDown={(e) => (e.currentTarget.setPointerCapture(e.pointerId), pick(e))}
        onPointerMove={(e) => e.buttons === 1 && pick(e)}
        onKeyDown={key}
      >
        <span className="colour-wheel-marker" style={{ left: mx, top: my, background: value }} />
      </div>
      <label className="colour-wheel-hex">
        <span>{tr('colourWheel.hex')}</span>
        <input
          value={hex}
          spellCheck={false}
          onChange={(e) => {
            const v = e.target.value.trim()
            setHex(v)
            const full = /^#?[0-9a-f]{6}$/i.test(v) ? (v.startsWith('#') ? v : `#${v}`) : null
            if (full) onChange(full.toLowerCase())
          }}
        />
      </label>
    </div>
  )
}
