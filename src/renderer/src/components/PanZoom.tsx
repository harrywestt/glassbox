import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, IconButton } from './ui'
import { tr } from '../../../shared/i18n'

type View = { x: number; y: number; k: number }
const MIN = 0.1
const MAX = 8

/**
 * Pan and zoom for large content (diagrams, sketches): drag to pan, wheel or pinch to zoom around
 * the pointer, double-click to zoom in, and keys: + / - / 0 (fit) / 1 (100%).
 *
 * An SVG is zoomed by resizing it; anything else gives its `size` and is scaled. `onTap` and
 * `onHover` get a click (a press that didn't drag) and the pointer in content coordinates, for
 * content under the panning surface (a sketch's page); double-click then doesn't zoom. With
 * `onDrag`, a drag goes to it (start, move, end, in content coordinates) instead of panning.
 */
export function PanZoom({
  children,
  contentKey,
  toolbar,
  size,
  fitWidth,
  onTap,
  onHover,
  onDrag,
  maxFit = MAX,
  className,
  hint
}: {
  children: ReactNode
  contentKey: string
  toolbar?: ReactNode
  size?: { w: number; h: number }
  /** Fit to the width and start at the top (a page), rather than fitting the whole thing (a diagram). */
  fitWidth?: boolean
  onTap?: (x: number, y: number) => void
  onHover?: (at: { x: number; y: number } | null) => void
  /** The most fitting may zoom in (1: a small picture isn't blown up past its own size). */
  maxFit?: number
  onDrag?: (phase: 'start' | 'move' | 'end', from: { x: number; y: number }, to: { x: number; y: number }) => void
  className?: string
  /** What the corner hint says, when it isn't the diagram one. */
  hint?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const viewRef = useRef(view)
  viewRef.current = view
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean; from: { x: number; y: number } } | null>(null)
  const sizeRef = useRef(size)
  sizeRef.current = size

  /** The content's natural size: given, or the SVG's viewBox. */
  const natural = () => {
    if (sizeRef.current) return { svg: null, ...sizeRef.current }
    const svg = content.current?.querySelector('svg')
    const vb = svg?.viewBox?.baseVal
    return svg && vb && vb.width && vb.height ? { svg, w: vb.width, h: vb.height } : null
  }

  // Zoom an SVG by resizing it, not with a CSS scale: the vector is redrawn at every level
  // and stays sharp (a scale transform stretches a bitmap and goes blurry).
  useLayoutEffect(() => {
    const n = natural()
    if (!n?.svg) return
    n.svg.setAttribute('width', String(n.w * view.k))
    n.svg.setAttribute('height', String(n.h * view.k))
  }, [view.k, contentKey])

  // A fit asked for while the view had no size yet (opened in a background tab, or still laying
  // out): done as soon as it has one, instead of zooming out to the 10% floor.
  const pendingFit = useRef(false)
  const fit = useCallback(() => {
    const b = box.current?.getBoundingClientRect()
    const n = natural()
    if (!b || !n || b.width < 80 || b.height < 60) return void (pendingFit.current = true)
    pendingFit.current = false
    const { w, h } = n
    if (fitWidth) {
      const k = Math.min(1, Math.max(MIN, (b.width - 48) / w))
      return setView({ k, x: (b.width - w * k) / 2, y: 24 })
    }
    const k = Math.min(maxFit, Math.max(MIN, Math.min((b.width - 48) / w, (b.height - 48) / h)))
    setView({ k, x: (b.width - w * k) / 2, y: (b.height - h * k) / 2 })
  }, [fitWidth, maxFit])

  // Fit when the diagram changes (after Mermaid has put the SVG in).
  useLayoutEffect(() => {
    const t = setTimeout(fit, 60)
    return () => clearTimeout(t)
  }, [contentKey])

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => pendingFit.current && fit())
    ro.observe(el)
    return () => ro.disconnect()
  }, [fit])

  const zoomAt = (factor: number, cx?: number, cy?: number) =>
    setView((v) => {
      const b = box.current!.getBoundingClientRect()
      const px = cx ?? b.width / 2
      const py = cy ?? b.height / 2
      const k = Math.min(MAX, Math.max(MIN, v.k * factor))
      const r = k / v.k
      return { k, x: px - (px - v.x) * r, y: py - (py - v.y) * r }
    })

  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const b = el.getBoundingClientRect()
      // Trackpad pinch arrives as ctrl+wheel; plain wheel zooms too, since panning is by drag.
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - b.left, e.clientY - b.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const set100 = () => {
    const b = box.current!.getBoundingClientRect()
    const n = natural()
    const w = n?.w ?? 0
    const h = n?.h ?? 0
    setView({ k: 1, x: (b.width - w) / 2, y: fitWidth ? 24 : Math.max(24, (b.height - h) / 2) })
  }

  /** Where the pointer is on the content, at its natural size. */
  const at = (e: { clientX: number; clientY: number }) => {
    const b = box.current!.getBoundingClientRect()
    const v = viewRef.current
    return { x: (e.clientX - b.left - v.x) / v.k, y: (e.clientY - b.top - v.y) / v.k }
  }

  return (
    <div className="panzoom-wrap">
      <div
        className={['panzoom', drag.current && 'dragging', className].filter(Boolean).join(' ')}
        ref={box}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === '+' || e.key === '=') zoomAt(1.25)
          else if (e.key === '-') zoomAt(0.8)
          else if (e.key === '0') fit()
          else if (e.key === '1') set100()
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          ;(e.target as Element).setPointerCapture?.(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, from: at(e) }
          box.current?.classList.add('dragging')
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return onHover?.(at(e))
          // A press that wanders a few pixels is still a click.
          if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return
          if (onDrag) {
            if (!d.moved) onDrag('start', d.from, d.from)
            d.moved = true
            return onDrag('move', d.from, at(e))
          }
          d.moved = true
          setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }))
        }}
        onPointerUp={(e) => {
          const d = drag.current
          drag.current = null
          box.current?.classList.remove('dragging')
          if (d?.moved && onDrag) onDrag('end', d.from, at(e))
          if (d && !d.moved && onTap) {
            const p = at(e)
            onTap(p.x, p.y)
          }
        }}
        onPointerLeave={() => onHover?.(null)}
        onDoubleClick={(e) => {
          if (onTap) return
          const b = box.current!.getBoundingClientRect()
          zoomAt(e.shiftKey ? 0.6 : 1.6, e.clientX - b.left, e.clientY - b.top)
        }}
      >
        <div className="panzoom-content" ref={content} style={{ transform: size ? `translate(${view.x}px, ${view.y}px) scale(${view.k})` : `translate(${view.x}px, ${view.y}px)` }}>
          {children}
        </div>
      </div>
      <div className="panzoom-controls">
        <IconButton icon="zoom-out" title={tr('panZoom.zoomOut')} onClick={() => zoomAt(0.8)} />
        <span className="panzoom-level num" title={tr('panZoom.zoomLevel')}>{tr('panZoom.level', { percent: Math.round(view.k * 100) })}</span>
        <IconButton icon="zoom-in" title={tr('panZoom.zoomIn')} onClick={() => zoomAt(1.25)} />
        <IconButton icon="screen-normal" title={tr('panZoom.fit')} onClick={fit} />
        <button className="chip-btn" title={tr('panZoom.actualSizeTip')} onClick={set100}>{tr('panZoom.actualSize')}</button>
        {toolbar}
      </div>
      <div className="panzoom-hint muted small">
        <Icon name="move" /> {hint ?? tr('panZoom.hint')}
      </div>
    </div>
  )
}
