import { useEffect, useRef, type RefObject } from 'react'

/**
 * A row of tabs that can run past its edges: the mouse wheel scrolls it sideways (a trackpad
 * already does), the active tab is kept in view, and the strip says which sides have more tabs
 * (data-more="left right") so CSS can fade those edges.
 */
export function useScrollStrip<T extends HTMLElement>(active?: string | null): RefObject<T | null> {
  const ref = useRef<T>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const mark = () => {
      const more = [el.scrollLeft > 1 ? 'left' : '', el.scrollLeft + el.clientWidth < el.scrollWidth - 1 ? 'right' : ''].filter(Boolean).join(' ')
      if (more) el.dataset.more = more
      else delete el.dataset.more
    }
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return
      // A wheel turns vertically; a trackpad's sideways swipe already scrolls the strip.
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    mark()
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('scroll', mark, { passive: true })
    const ro = new ResizeObserver(mark)
    ro.observe(el)
    const mo = new MutationObserver(mark)
    mo.observe(el, { childList: true })
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('scroll', mark)
      ro.disconnect()
      mo.disconnect()
    }
  }, [])

  // The tab you pick (or that Claude opens) scrolls into view.
  useEffect(() => {
    const el = ref.current
    const tab = el?.querySelector<HTMLElement>('[aria-selected="true"]')
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [active])

  return ref
}
