import { useEffect, useRef, useState } from 'react'

type Tip = { text: string; x: number; y: number; place: 'above' | 'below' | 'left' }

const DELAY_MS = 380
const GAP = 8

/**
 * App-wide tooltips. Any element with a `title` gets this instead of the native tooltip: the title
 * is moved to `data-tip` on first hover (so the browser never shows its own), then shown styled.
 */
export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const current = useRef<Element | null>(null)
  const box = useRef<HTMLDivElement>(null)

  // Any title attribute (including one React re-applies while you hover) becomes data-tip straight away.
  useEffect(() => {
    const convert = (el: Element) => {
      const t = el.getAttribute('title')
      if (t === null) return
      el.setAttribute('data-tip', t)
      el.removeAttribute('title')
    }
    document.querySelectorAll('[title]').forEach(convert)
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes' && r.target instanceof Element) convert(r.target)
        else r.addedNodes.forEach((n) => { if (n instanceof Element) { convert(n); n.querySelectorAll('[title]').forEach(convert) } })
      }
    })
    obs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] })
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    const hide = () => {
      window.clearTimeout(timer.current)
      current.current = null
      setTip(null)
    }
    const onOver = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.('[title], [data-tip]')
      if (!el || el === current.current) return
      const title = el.getAttribute('title')
      if (title !== null) {
        el.setAttribute('data-tip', title)
        el.removeAttribute('title')
      }
      const text = el.getAttribute('data-tip')
      window.clearTimeout(timer.current)
      current.current = el
      setTip(null)
      if (!text?.trim()) return
      timer.current = window.setTimeout(() => {
        if (current.current !== el || !el.isConnected) return
        const r = el.getBoundingClientRect()
        // Things hugging the right edge (the panel rail) get their tip beside them, not squeezed above.
        if (r.right > window.innerWidth - 64) return setTip({ text, x: r.left - GAP, y: r.top + r.height / 2, place: 'left' })
        const place = r.top > 72 ? 'above' : 'below'
        setTip({ text, x: r.left + r.width / 2, y: place === 'above' ? r.top - GAP : r.bottom + GAP, place })
      }, DELAY_MS)
    }
    const onOut = (e: MouseEvent) => {
      const to = e.relatedTarget as Node | null
      if (current.current && (!to || !current.current.contains(to))) hide()
    }
    document.addEventListener('mouseover', onOver, true)
    document.addEventListener('mouseout', onOut, true)
    window.addEventListener('mousedown', hide, true)
    window.addEventListener('keydown', hide, true)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      document.removeEventListener('mouseover', onOver, true)
      document.removeEventListener('mouseout', onOut, true)
      window.removeEventListener('mousedown', hide, true)
      window.removeEventListener('keydown', hide, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [])

  // Keep the tooltip inside the window horizontally once its width is known.
  const [shift, setShift] = useState(0)
  useEffect(() => {
    const el = box.current
    if (!el || !tip || tip.place === 'left') return setShift(0)
    const r = el.getBoundingClientRect()
    const margin = 8
    setShift(r.left < margin ? margin - r.left : r.right > window.innerWidth - margin ? window.innerWidth - margin - r.right : 0)
  }, [tip])

  if (!tip) return null
  const [first, ...rest] = tip.text.split('\n')
  return (
    <div
      ref={box}
      className={`tooltip tooltip-${tip.place}`}
      role="tooltip"
      style={{ left: tip.x + shift, top: tip.y, transform: tip.place === 'left' ? 'translate(-100%, -50%)' : `translate(-50%, ${tip.place === 'above' ? '-100%' : '0'})` }}
    >
      <div className="tooltip-main">{first}</div>
      {rest.length > 0 && <div className="tooltip-rest">{rest.join('\n')}</div>}
    </div>
  )
}
