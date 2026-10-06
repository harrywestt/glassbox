import { useSettledSession } from '../session'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '../views/SessionView'
import { dependentsOf, moduleOf } from '../../../shared/architecture'
import { useArchitecture, isEditTouch } from '../architecture'
import { Segmented } from '../components/ui'
import { tr } from '../../../shared/i18n'
import './RippleTab.css'

const CX = 320, CY = 230

/**
 * What depends on a module, as rings around it: one hop away, then two, then three. Anything the
 * change reaches stays amber unless the module has tests; the ripple plays each time you open it.
 */
export function RippleTab({ module, path, onPick }: { module?: string; path?: string; onPick: (id: string) => void }) {
  const { tab, s: session, composerRef } = useSession()
  const s = useSettledSession(session)
  const arch = useArchitecture(tab.cwd, 0)
  // The diagram scales to fit; its labels shouldn't. --rs is the drawn scale, so text stays 11px on screen.
  const svgRef = useRef<SVGSVGElement>(null)
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setScale(Math.max(0.3, Math.min(el.clientWidth / 800, el.clientHeight / 460)) || 1))
    ro.observe(el)
    return () => ro.disconnect()
  })

  // The modules Claude changed this session, most recent first, to pick from.
  const changed = useMemo(() => {
    if (!arch) return []
    const seen: string[] = []
    for (const f of [...s.files].reverse()) {
      if (!isEditTouch(f, s)) continue
      const m = moduleOf(arch, f.path)
      if (m && !seen.includes(m.id)) seen.push(m.id)
    }
    return seen
  }, [arch, s])

  // Opened on a module, on a file (Claude's show_impact), or on the latest change.
  const target = module ?? (path && arch ? moduleOf(arch, path)?.id : undefined) ?? changed[0]
  const graph = useMemo(() => {
    if (!arch || !target) return null
    const depth = dependentsOf(arch, target)
    const rings = new Map<number, string[]>()
    for (const [id, d] of depth) if (d > 0 && d <= 3) rings.set(d, [...(rings.get(d) ?? []), id])
    const pos = new Map<string, { x: number; y: number }>([[target, { x: CX, y: CY }]])
    for (const [d, ids] of rings) ids.forEach((id, i) => {
      const a = -Math.PI / 2 + ((i + 0.5) * 2 * Math.PI) / ids.length + d * 0.35
      pos.set(id, { x: CX + Math.cos(a) * d * 118 * 1.45, y: CY + Math.sin(a) * d * 118 * 0.72 })
    })
    const mod = (id: string) => arch.modules.find((m) => m.id === id)!
    const reached = [...pos.keys()].filter((id) => id !== target)
    const untested = reached.filter((id) => !mod(id).tests)
    return { depth, pos, mod, reached, untested }
  }, [arch, target])

  if (!arch) return <div className="ripple-empty">{tr('rippleTab.mapping')}</div>
  if (!target || !graph) return <div className="ripple-empty">{tr('rippleTab.empty')}</div>
  const t = graph.mod(target)

  return (
    <div className="ripple-view">
      <div className="ripple-canvas">
        <svg key={target} ref={svgRef} viewBox="-80 0 800 460" style={{ ['--rs' as string]: scale }} role="img" aria-label={tr('rippleTab.diagramLabel', { name: t.name })}>
          {[0, 1, 2].map((i) => <ellipse key={i} className="ripple-wave" cx={CX} cy={CY} rx={40} ry={26} style={{ animationDelay: `${i * 0.45}s` }} />)}
          {arch.edges.map((e) => {
            const a = graph.pos.get(e.from), b = graph.pos.get(e.to)
            if (!a || !b || graph.depth.get(e.from) !== (graph.depth.get(e.to) ?? -9) + 1) return null
            return <line key={`${e.from}>${e.to}`} className="ripple-edge" x1={a.x} y1={a.y} x2={b.x} y2={b.y} style={{ animationDelay: `${0.3 + (graph.depth.get(e.from)! - 1) * 0.6}s` }} />
          })}
          {[...graph.pos].map(([id, p]) => {
            const m = graph.mod(id), d = graph.depth.get(id)!
            const state = id === target ? 'changed' : m.tests ? 'covered' : 'untested'
            return (
              <g key={id} className={`ripple-node ${state}`} style={{ animationDelay: `${0.3 + (d - 1) * 0.6}s` }}>
                <circle cx={p.x} cy={p.y} r={id === target ? 17 : 12} />
                <text x={p.x} y={p.y + (id === target ? 33 : 28)} textAnchor="middle">
                  <tspan className="ripple-name">{m.name}</tspan>
                  {/* The path's offset is in ems, so the two lines never collide at any zoom. */}
                  <tspan className="ripple-path" x={p.x} dy="1.25em">{m.path || tr('rippleTab.root')}</tspan>
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      <aside className="ripple-aside">
        <h3 className="ripple-title">{tr('rippleTab.title', { name: t.name })}</h3>
        <dl className="ripple-counts">
          <dt><span className="ripple-key changed" />{tr('rippleTab.changed')}</dt><dd>1</dd>
          <dt><span className="ripple-key covered" />{tr('rippleTab.reachedTested')}</dt><dd>{graph.reached.length - graph.untested.length}</dd>
          <dt><span className="ripple-key untested" />{tr('rippleTab.reachedUntested')}</dt><dd>{graph.untested.length}</dd>
        </dl>
        {graph.reached.length === 0 && <p className="ripple-note">{tr('rippleTab.noDependents', { path: t.path || tr('rippleTab.thisModule') })}</p>}
        {graph.untested.length > 0 && (
          <>
            <ul className="ripple-list">
              {graph.untested.map((id) => <li key={id}><span className="mono">{graph.mod(id).path}</span></li>)}
            </ul>
            <button
              className="btn primary"
              onClick={() => composerRef.current?.insert(`Write tests covering how ${graph.untested.map((id) => graph.mod(id).path).join(', ')} use ${t.path} after this change.`)}
            >
              {tr('rippleTab.askCover', { n: graph.untested.length })}
            </button>
          </>
        )}
        {changed.length > 1 && (
          <div className="ripple-pick">
            <span className="ripple-pick-label">{tr('rippleTab.showDependenciesOf')}</span>
            <Segmented<string> value={target} onChange={onPick} options={changed.slice(0, 4).map((id) => ({ value: id, label: graph.mod(id)?.name ?? arch.modules.find((m) => m.id === id)?.name ?? id }))} />
          </div>
        )}
      </aside>
    </div>
  )
}
