import { useEffect, useState } from 'react'
import { Icon, IconButton } from './ui'
import { PanZoom } from './PanZoom'
import { tr } from '../../../shared/i18n'

type Zoomed = { title: string; svg: string }

/** Opens a diagram drawn inside text (a message, a plan, a Markdown file) filling the window. */
export function zoomDiagram(title: string, svg: string) {
  window.dispatchEvent(new CustomEvent<Zoomed>('glassbox:zoom', { detail: { title, svg } }))
}

/**
 * The window-filling view for a diagram from inside text: the same hand, scroll-to-zoom and keys as
 * sketches and the Diagrams panel. Esc closes it.
 */
export function ZoomOverlay() {
  const [shown, setShown] = useState<Zoomed | null>(null)
  useEffect(() => {
    const onZoom = (e: Event) => setShown((e as CustomEvent<Zoomed>).detail)
    window.addEventListener('glassbox:zoom', onZoom)
    return () => window.removeEventListener('glassbox:zoom', onZoom)
  }, [])
  useEffect(() => {
    if (!shown) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setShown(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shown])
  if (!shown) return null
  return (
    <div className="diagram-full plan-sketch-zoom" role="dialog" aria-label={shown.title}>
      <div className="plan-sketch-zoom-bar">
        <Icon name="type-hierarchy" />
        <strong className="grow ellipsis">{shown.title}</strong>
        <IconButton icon="close" title={tr('zoomOverlay.close')} onClick={() => setShown(null)} />
      </div>
      <PanZoom contentKey={shown.svg.length + shown.title}>
        <div className="zoom-svg" dangerouslySetInnerHTML={{ __html: shown.svg }} />
      </PanZoom>
    </div>
  )
}
