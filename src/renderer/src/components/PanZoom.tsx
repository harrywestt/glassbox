import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, IconButton } from './ui'
import { tr } from '../../../shared/i18n'

type View = { x: number; y: number; k: number }
const MIN = 0.1
const MAX = 8

/**
 * Pan and zoom for large content (diagrams): drag to pan, wheel or pinch to zoom around the
 * pointer, double-click to zoom in, and keys: + / - / 0 (fit) / 1 (100%).
 */
export function PanZoom({ children, contentKey, toolbar }: { children: ReactNode; contentKey: string; toolbar?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)

  /** The SVG's natural size, from its viewBox. */
  const natural = () => {
    const svg = content.current?.querySelector('svg')
    const vb = svg?.viewBox?.baseVal
    return svg && vb && vb.width && vb.height ? { svg, w: vb.width, h: vb.height } : null
  }

  // Zoom by resizing the SVG itself, not with a CSS scale: the vector is redrawn at every level
  // and stays sharp (a scale transform stretches a bitmap and goes blurry).
  useLayoutEffect(() => {
    const n = natural()
    if (!n) return
    n.svg.setAttribute('width', String(n.w * view.k))
    n.svg.setAttribute('height', String(n.h * view.k))
  }, [view.k, contentKey])

  const fit = useCallback(() => {
    const b = box.current?.getBoundingClientRect()
    const n = natural()
    if (!b || !n) return
    const { w, h } = n
    const k = Math.min(MAX, Math.max(MIN, Math.min((b.width - 48) / w, (b.height - 48) / h)))
    setView({ k, x: (b.width - w * k) / 2, y: (b.height - h * k) / 2 })
  }, [])

  // Fit when the diagram changes (after Mermaid has put the SVG in).
  useLayoutEffect(() => {
    const t = setTimeout(fit, 60)
    return () => clearTimeout(t)
  }, [contentKey])

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
    setView({ k: 1, x: (b.width - w) / 2, y: Math.max(24, (b.height - h) / 2) })
  }

  return (
    <div className="panzoom-wrap">
      <div
        className={drag.current ? 'panzoom dragging' : 'panzoom'}
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
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
          box.current?.classList.add('dragging')
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }))
        }}
        onPointerUp={() => {
          drag.current = null
          box.current?.classList.remove('dragging')
        }}
        onDoubleClick={(e) => {
          const b = box.current!.getBoundingClientRect()
          zoomAt(e.shiftKey ? 0.6 : 1.6, e.clientX - b.left, e.clientY - b.top)
        }}
      >
        <div className="panzoom-content" ref={content} style={{ transform: `translate(${view.x}px, ${view.y}px)` }}>
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
        <Icon name="move" /> {tr('panZoom.hint')}
      </div>
    </div>
  )
}
