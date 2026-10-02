import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '../views/SessionView'
import type { Erd, ErdEntity, ErdRelation } from '../../../shared/erd'
import { Empty, Icon, IconButton, Toggle } from '../components/ui'
import './ErdTab.css'

const BOX_W = 236
const HEAD_H = 42
const ROW_H = 19
const MAX_ROWS = 8
const GAP_X = 96
const GAP_Y = 26
const COL_MAX = 7

type Box = { e: ErdEntity; x: number; y: number; h: number; rows: ErdEntity['columns']; more: number; context: boolean }

// The last schema read per project, so switching tabs doesn't re-read it.
const loaded = new Map<string, Erd>()

/** Words in a question, for the instant match before Claude answers ("controls v2" → controls, v2). */
const words = (q: string) => q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !['the', 'and', 'for', 'with', 'show', 'me', 'look', 'at', 'area', 'tables', 'table', 'entities'].includes(w))

/**
 * The database as the code defines it: tables and how they connect. With nothing picked it shows
 * the modules; ask for an area ("controls v2") and it narrows to those tables, first by name, then
 * as Claude works out from the code which tables that area really uses.
 */
export function ErdTab({ entities: initial, query: initialQuery }: { entities?: string[]; query?: string }) {
  const { tab, composerRef, openFile } = useSession()
  const [erd, setErd] = useState<Erd | null>(() => loaded.get(tab.cwd) ?? null)
  const [q, setQ] = useState(initialQuery ?? '')
  const [focus, setFocus] = useState<Set<string> | null>(initial?.length ? new Set(initial) : null)
  const [focusLabel, setFocusLabel] = useState<string | null>(initialQuery ?? null)
  const [asking, setAsking] = useState<string | null>(null)
  const [why, setWhy] = useState<string | null>(null)
  const [askError, setAskError] = useState<string | null>(null)
  const [neighbours, setNeighbours] = useState(true)
  const [inferred, setInferred] = useState(true)
  const [sel, setSel] = useState<string | null>(null)
  const askSeq = useRef(0)

  useEffect(() => {
    let live = true
    void window.glassbox.erd.get(tab.cwd).then((e) => {
      if (!live) return
      loaded.set(tab.cwd, e)
      setErd(e)
    })
    return () => {
      live = false
    }
  }, [tab.cwd])

  const byId = useMemo(() => new Map((erd?.entities ?? []).map((e) => [e.id, e])), [erd])
  // Tables nearly everything points at (Tenant, via a TenantId on every table) would bury the
  // links that matter: their inferred links are left out unless you picked that table itself.
  const hubs = useMemo(() => {
    const n = new Map<string, number>()
    for (const r of erd?.relations ?? []) if (r.inferred) n.set(r.to, (n.get(r.to) ?? 0) + 1)
    return new Set([...n].filter(([, c]) => c >= 12).map(([id]) => id))
  }, [erd])
  const relations = useMemo(() => (erd?.relations ?? []).filter((r) => (inferred || !r.inferred) && !(r.inferred && hubs.has(r.to) && !focus?.has(r.to))), [erd, inferred, hubs, focus])

  // Instant match by name, table, schema or module, then Claude's answer from the code replaces it.
  const ask = (question: string) => {
    const text = question.trim()
    if (!text || !erd) return
    const ws = words(text)
    const hits = erd.entities.filter((e) => {
      const hay = `${e.name} ${e.table ?? ''} ${e.schema ?? ''} ${e.group}`.toLowerCase()
      return ws.length > 0 && ws.every((w) => hay.includes(w) || (/^v\d+$/.test(w) && true))
    })
    if (hits.length) setFocus(new Set(hits.map((e) => e.id)))
    setFocusLabel(text)
    setWhy(null)
    setAskError(null)
    setSel(null)
    const seq = ++askSeq.current
    setAsking(text)
    void window.glassbox.erd
      .focus(tab.cwd, text)
      .then((r) => {
        if (seq !== askSeq.current) return
        if (r.entities.length) setFocus(new Set(r.entities))
        setWhy(r.why ?? null)
        if (r.error) setAskError(hits.length ? `${r.error} Showing the tables whose names match.` : r.error)
      })
      .catch((e) => seq === askSeq.current && setAskError(String(e)))
      .finally(() => seq === askSeq.current && setAsking(null))
  }
  // Claude (show_database) may name tables by short name or table name: match them to entities.
  useEffect(() => {
    if (!erd) return
    if (initial?.length) {
      const want = initial.map((x) => x.toLowerCase())
      const ids = erd.entities.filter((e) => want.includes(e.id.toLowerCase()) || want.includes(e.name.toLowerCase()) || (e.table && want.includes(e.table.toLowerCase()))).map((e) => e.id)
      if (ids.length) setFocus(new Set(ids))
    } else if (initialQuery) ask(initialQuery)
  }, [erd])

  const clear = () => {
    askSeq.current++
    setFocus(null)
    setFocusLabel(null)
    setWhy(null)
    setAskError(null)
    setAsking(null)
    setSel(null)
    setQ('')
  }

  // What's drawn: the focus, plus (faded) the tables they connect to.
  const shown = useMemo(() => {
    if (!focus) return null
    const ids = new Set(focus)
    const context = new Set<string>()
    if (neighbours)
      for (const r of relations) {
        if (focus.has(r.from) && !focus.has(r.to)) context.add(r.to)
        if (focus.has(r.to) && !focus.has(r.from) && !r.inferred) context.add(r.from)
      }
    for (const c of context) ids.add(c)
    return { ids, context }
  }, [focus, neighbours, relations])

  const selected = sel ? byId.get(sel) : undefined

  const body = (() => {
    if (!erd) return <div className="erd-empty muted">Reading the database schema from the code…</div>
    if (erd.error) return <div className="erd-empty">Couldn’t read the schema: {erd.error}</div>
    if (!erd.entities.length)
      return (
        <Empty icon="database" title="No database schema found">
          Glassbox reads EF Core model snapshots, Prisma schemas and SQL migrations (CREATE TABLE). None were found in this project.
        </Empty>
      )
    if (!shown) return <Overview erd={erd} onPick={(g) => (setFocus(new Set(erd.entities.filter((e) => e.group === g).map((e) => e.id))), setFocusLabel(g), setWhy(null), setSel(null))} />
    return <Diagram erd={erd} ids={shown.ids} context={shown.context} relations={relations} sel={sel} onSel={setSel} />
  })()

  return (
    <div className="erd-tab">
      <form
        className="erd-ask"
        onSubmit={(e) => {
          e.preventDefault()
          ask(q)
        }}
      >
        <Icon name="sparkle" className="erd-ask-icon" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask for an area of the database, e.g. controls v2, or how evidence links to controls" aria-label="Ask for an area of the database" />
        {asking ? (
          <span className="erd-ask-state small">
            <Icon name="loading" className="codicon-modifier-spin" /> Claude is reading the code (up to a minute)
          </span>
        ) : null}
        <button className="btn primary" type="submit" disabled={!q.trim() || !erd?.entities.length}>
          Show
        </button>
      </form>
      {erd && erd.entities.length > 0 && (
        <div className="erd-bar small">
          {focusLabel ? (
            <>
              <span className="erd-bar-what">
                <strong>{focusLabel}</strong>
                <span className="muted">
                  {' '}
                  {focus?.size ?? 0} table{focus?.size === 1 ? '' : 's'}
                  {shown && shown.context.size ? `, ${shown.context.size} connected` : ''}
                  {hubs.size ? `, ${[...hubs].map((h) => byId.get(h)?.name ?? h).join(', ')} links hidden` : ''}
                </span>
              </span>
              <button className="link small erd-all" onClick={clear} title={hubs.size ? `Links to ${[...hubs].map((h) => byId.get(h)?.name ?? h).join(', ')} are hidden because almost every table has one.` : undefined}>
                All modules
              </button>
            </>
          ) : (
            <span className="muted">
              {erd.entities.length} {erd.entities.length === 1 ? 'table' : 'tables'} in {((n) => `${n} ${n === 1 ? 'module' : 'modules'}`)(new Set(erd.entities.map((e) => e.group)).size)}, from {erd.source === 'ef' ? 'the EF Core model' : erd.source === 'prisma' ? 'the Prisma schema' : 'the SQL migrations'}. Pick a module or ask for an area.
            </span>
          )}
          <span className="spacer" />
          <label className="erd-toggle" title="Show the tables the ones you picked connect to, faded">
            Connected tables <Toggle checked={neighbours} onChange={setNeighbours} />
          </label>
          <label className="erd-toggle" title="Links not declared in the model, only a column named after a table in another module (e.g. FrameworkId). Drawn dashed.">
            Links across modules <Toggle checked={inferred} onChange={setInferred} />
          </label>
        </div>
      )}
      {(why || askError) && <div className={askError ? 'erd-why err small' : 'erd-why small'}>{askError ?? why}</div>}
      <div className={selected ? 'erd-body inspecting' : 'erd-body'}>
        {body}
        {selected && erd && (
          <EntityPanel
            e={selected}
            erd={erd}
            relations={relations}
            onClose={() => setSel(null)}
            onPick={(id) => {
              setSel(id)
              if (focus && !focus.has(id)) setFocus(new Set([...focus, id]))
            }}
            onOpen={selected.file ? () => openFile(`${erd.root}/${selected.file}`) : undefined}
            onAsk={() => composerRef.current?.insert(`About the ${selected.table ?? selected.name} table (${selected.id}): `)}
          />
        )}
      </div>
    </div>
  )
}

/** Every module as a card: its tables, and how many links it has to other modules. */
function Overview({ erd, onPick }: { erd: Erd; onPick: (group: string) => void }) {
  const groups = useMemo(() => {
    const by = new Map<string, { name: string; entities: ErdEntity[]; out: Map<string, number> }>()
    const groupOf = new Map(erd.entities.map((e) => [e.id, e.group]))
    for (const e of erd.entities) {
      let g = by.get(e.group)
      if (!g) by.set(e.group, (g = { name: e.group, entities: [], out: new Map() }))
      g.entities.push(e)
    }
    for (const r of erd.relations) {
      const a = groupOf.get(r.from), b = groupOf.get(r.to)
      if (a && b && a !== b) by.get(a)!.out.set(b, (by.get(a)!.out.get(b) ?? 0) + 1)
    }
    return [...by.values()].sort((a, b) => b.entities.length - a.entities.length || a.name.localeCompare(b.name))
  }, [erd])
  return (
    <div className="erd-overview">
      {groups.map((g) => (
        <button key={g.name} className="erd-group" onClick={() => onPick(g.name)}>
          <span className="erd-group-head">
            <strong>{g.name}</strong>
            <span className="muted small">{g.entities.length} table{g.entities.length === 1 ? '' : 's'}</span>
          </span>
          <span className="erd-group-tables small">{g.entities.slice(0, 6).map((e) => e.name).join(', ')}{g.entities.length > 6 ? `, and ${g.entities.length - 6} more` : ''}</span>
          {g.out.size > 0 && (
            <span className="erd-group-links small">
              Uses {[...g.out].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n).join(', ')}
              {g.out.size > 3 ? ` +${g.out.size - 3}` : ''}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

/** Rows shown in a box: keys and foreign keys first, then the rest up to a few. */
function rowsOf(e: ErdEntity) {
  const first = e.columns.filter((c) => c.key || c.fk)
  const rest = e.columns.filter((c) => !c.key && !c.fk)
  const rows = [...first, ...rest].slice(0, Math.max(MAX_ROWS, first.length))
  return { rows, more: e.columns.length - rows.length }
}

/**
 * Layered: a table sits to the right of the tables it points at (parents left, children right),
 * each column ordered to sit near what it connects to. Pan by dragging, zoom with the wheel.
 */
function Diagram({ erd, ids, context, relations, sel, onSel }: { erd: Erd; ids: Set<string>; context: Set<string>; relations: ErdRelation[]; sel: string | null; onSel: (id: string | null) => void }) {
  const wrap = useRef<HTMLDivElement>(null)
  const edges = useMemo(() => relations.filter((r) => ids.has(r.from) && ids.has(r.to) && r.from !== r.to), [relations, ids])
  const boxes = useMemo(() => {
    const list = erd.entities.filter((e) => ids.has(e.id))
    const out = new Map<string, string[]>()
    for (const r of edges) out.set(r.from, [...(out.get(r.from) ?? []), r.to])
    const rank = new Map<string, number>()
    const visit = (id: string, stack: Set<string>): number => {
      if (rank.has(id)) return rank.get(id)!
      if (stack.has(id)) return 0
      stack.add(id)
      const r = Math.max(-1, ...(out.get(id) ?? []).map((t) => visit(t, stack))) + 1
      stack.delete(id)
      rank.set(id, r)
      return r
    }
    for (const e of list) visit(e.id, new Set())
    // Columns by rank, split when tall; order within each by where their links sit in the previous column.
    const ranks = [...new Set(list.map((e) => rank.get(e.id)!))].sort((a, b) => a - b)
    const columns: ErdEntity[][] = []
    for (const r of ranks) {
      const col = list.filter((e) => rank.get(e.id) === r).sort((a, b) => Number(context.has(a.id)) - Number(context.has(b.id)) || a.name.localeCompare(b.name))
      for (let i = 0; i < col.length; i += COL_MAX) columns.push(col.slice(i, i + COL_MAX))
    }
    const pos = new Map<string, number>()
    columns.forEach((col, ci) => {
      if (ci > 0) {
        const score = (e: ErdEntity) => {
          const ns = edges.filter((r) => r.from === e.id || r.to === e.id).map((r) => pos.get(r.from === e.id ? r.to : r.from)).filter((x): x is number => x !== undefined)
          return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 99
        }
        col.sort((a, b) => score(a) - score(b))
      }
      col.forEach((e, i) => pos.set(e.id, i))
    })
    const bx: Record<string, Box> = {}
    columns.forEach((col, ci) => {
      let y = 0
      for (const e of col) {
        const c = context.has(e.id)
        const { rows, more } = c ? { rows: e.columns.filter((x) => x.key), more: 0 } : rowsOf(e)
        const h = HEAD_H + rows.length * ROW_H + (more ? ROW_H : 0) + 8
        bx[e.id] = { e, x: ci * (BOX_W + GAP_X), y, h, rows, more, context: c }
        y += h + GAP_Y
      }
    })
    return bx
  }, [erd, ids, edges, context])

  // Pan and zoom, fitted to the space when the set changes.
  const [view, setView] = useState({ x: 20, y: 20, k: 1 })
  const size = useMemo(() => {
    const all = Object.values(boxes)
    return { w: Math.max(0, ...all.map((b) => b.x + BOX_W)), h: Math.max(0, ...all.map((b) => b.y + b.h)) }
  }, [boxes])
  const fit = () => {
    const el = wrap.current
    if (!el || !size.w) return
    // Fit, but never so small the names can't be read: past that, it starts at the top left to pan from.
    const k = Math.min(1, (el.clientWidth - 40) / size.w, (el.clientHeight - 40) / size.h)
    setView({ k: Math.max(0.6, k), x: 20, y: 20 })
  }
  useLayoutEffect(fit, [size.w, size.h])
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)

  const rowY = (b: Box, column?: string) => {
    const i = column ? b.rows.findIndex((r) => r.name === column) : -1
    return i >= 0 ? b.y + HEAD_H + i * ROW_H + ROW_H / 2 : b.y + HEAD_H / 2
  }
  const hot = sel ? new Set(edges.filter((r) => r.from === sel || r.to === sel).flatMap((r) => [r.from, r.to])) : null

  return (
    <div
      className="erd-canvas"
      ref={wrap}
      onWheel={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        const px = e.clientX - r.left, py = e.clientY - r.top
        const k = Math.min(2, Math.max(0.25, view.k * (e.deltaY < 0 ? 1.1 : 0.9)))
        setView({ k, x: px - ((px - view.x) * k) / view.k, y: py - ((py - view.y) * k) / view.k })
      }}
      onPointerDown={(e) => {
        if ((e.target as Element).closest('.erd-box')) return
        drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => drag.current && setView((v) => ({ ...v, x: drag.current!.vx + e.clientX - drag.current!.x, y: drag.current!.vy + e.clientY - drag.current!.y }))}
      onPointerUp={(e) => {
        if (drag.current && Math.abs(e.clientX - drag.current.x) + Math.abs(e.clientY - drag.current.y) < 4) onSel(null)
        drag.current = null
      }}
    >
      <div className="erd-zoom">
        <IconButton icon="zoom-in" title="Zoom in" onClick={() => setView((v) => ({ ...v, k: Math.min(2, v.k * 1.2) }))} />
        <IconButton icon="zoom-out" title="Zoom out" onClick={() => setView((v) => ({ ...v, k: Math.max(0.25, v.k / 1.2) }))} />
        <IconButton icon="screen-full" title="Fit to the view" onClick={fit} />
      </div>
      <svg className="erd-svg" width="100%" height="100%">
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {edges.map((r, i) => {
            const a = boxes[r.from], b = boxes[r.to]
            if (!a || !b) return null
            // From the foreign key's row on the child to the parent's header, leaving from the facing sides.
            const leftToRight = a.x > b.x
            const x1 = leftToRight ? a.x : a.x + BOX_W
            const x2 = leftToRight ? b.x + BOX_W : b.x
            const y1 = rowY(a, r.column)
            const y2 = rowY(b)
            const dx = Math.max(40, Math.abs(x1 - x2) / 2)
            const d = a.x === b.x ? `M ${a.x + BOX_W} ${y1} C ${a.x + BOX_W + 60} ${y1}, ${b.x + BOX_W + 60} ${y2}, ${b.x + BOX_W} ${y2}` : `M ${x1} ${y1} C ${x1 + (leftToRight ? -dx : dx)} ${y1}, ${x2 + (leftToRight ? dx : -dx)} ${y2}, ${x2} ${y2}`
            const on = !hot || (hot.has(r.from) && hot.has(r.to) && (r.from === sel || r.to === sel))
            const dir = a.x === b.x ? 1 : leftToRight ? -1 : 1
            return (
              <g key={i} className={`erd-edge${r.inferred ? ' inferred' : ''}${on ? '' : ' dim'}`}>
                <path d={d} />
                {/* Crow's foot at the many end (the child), a bar at the one end (the parent). */}
                {r.many && (
                  <path className="erd-foot" d={`M ${x1 + dir * 10} ${y1} L ${x1} ${y1 - 5} M ${x1 + dir * 10} ${y1} L ${x1} ${y1 + 5} M ${x1 + dir * 10} ${y1} L ${x1} ${y1}`} />
                )}
                <path className="erd-foot" d={`M ${x2 + (a.x === b.x ? 8 : leftToRight ? 8 : -8)} ${y2 - 5} L ${x2 + (a.x === b.x ? 8 : leftToRight ? 8 : -8)} ${y2 + 5}`} />
                <title>{`${a.e.name}.${r.column ?? '?'} → ${b.e.name}${r.inferred ? ' (inferred from the column name, not declared)' : ''}`}</title>
              </g>
            )
          })}
          {Object.values(boxes).map((b) => (
            <g
              key={b.e.id}
              className={`erd-box${b.context ? ' context' : ''}${sel === b.e.id ? ' sel' : ''}${hot && !hot.has(b.e.id) && sel !== b.e.id ? ' dim' : ''}`}
              onClick={() => onSel(sel === b.e.id ? null : b.e.id)}
              role="button"
              tabIndex={0}
              aria-label={`${b.e.name}, table ${b.e.table ?? b.e.name}`}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSel(b.e.id))}
            >
              <rect className="erd-box-bg" x={b.x} y={b.y} width={BOX_W} height={b.h} rx={8} />
              <line className="erd-box-rule" x1={b.x} x2={b.x + BOX_W} y1={b.y + HEAD_H - 4} y2={b.y + HEAD_H - 4} />
              <text className="erd-box-name" x={b.x + 12} y={b.y + 18}>{clip(b.e.name, BOX_W - 24, 7.4)}</text>
              <text className="erd-box-table" x={b.x + 12} y={b.y + 32}>{clip(`${b.e.schema ? `${b.e.schema}.` : ''}${b.e.table ?? ''}  ${b.e.group}`, BOX_W - 24, 6.2)}</text>
              {b.rows.map((c, i) => (
                <g key={c.name}>
                  <text className={`erd-col${c.key ? ' key' : ''}${c.fk ? ' fk' : ''}`} x={b.x + 12} y={b.y + HEAD_H + i * ROW_H + 13}>
                    {c.key ? 'PK ' : c.fk ? 'FK ' : ''}
                    {clip(c.name, 140, 6.6)}
                  </text>
                  <text className="erd-col-type" x={b.x + BOX_W - 12} y={b.y + HEAD_H + i * ROW_H + 13} textAnchor="end">
                    {clip(c.type.replace(/^character varying/, 'varchar').replace(/^timestamp with time zone/, 'timestamptz'), 90, 6)}
                    {c.required ? '' : '?'}
                  </text>
                </g>
              ))}
              {b.more > 0 && (
                <text className="erd-col-more" x={b.x + 12} y={b.y + HEAD_H + b.rows.length * ROW_H + 13}>
                  and {b.more} more column{b.more === 1 ? '' : 's'}
                </text>
              )}
            </g>
          ))}
        </g>
      </svg>
    </div>
  )
}

/** One table in full: every column, what it points at and what points at it. */
function EntityPanel({ e, erd, relations, onClose, onPick, onOpen, onAsk }: { e: ErdEntity; erd: Erd; relations: ErdRelation[]; onClose: () => void; onPick: (id: string) => void; onOpen?: () => void; onAsk: () => void }) {
  const name = (id: string) => erd.entities.find((x) => x.id === id)
  const out = relations.filter((r) => r.from === e.id)
  const inn = relations.filter((r) => r.to === e.id)
  return (
    <aside className="erd-panel" role="dialog" aria-label={e.name}>
      <div className="erd-panel-head">
        <div className="grow">
          <strong>{e.name}</strong>
          <div className="mono small muted">
            {e.schema ? `${e.schema}.` : ''}
            {e.table ?? e.name}
          </div>
          <div className="small muted">{e.group}</div>
        </div>
        <IconButton icon="close" title="Close" onClick={onClose} />
      </div>
      <div className="erd-panel-actions">
        <button className="btn primary" onClick={onAsk}>
          Ask Claude about it
        </button>
        {onOpen && (
          <button className="btn" onClick={onOpen}>
            Open the entity
          </button>
        )}
      </div>
      {out.length > 0 && (
        <section>
          <div className="erd-panel-label">Points at</div>
          {out.map((r, i) => (
            <button key={i} className="erd-rel" onClick={() => onPick(r.to)}>
              <span className="mono">{r.column ?? r.nav}</span> → <strong>{name(r.to)?.name ?? r.to}</strong>
              {r.inferred && <span className="muted"> (inferred)</span>}
            </button>
          ))}
        </section>
      )}
      {inn.length > 0 && (
        <section>
          <div className="erd-panel-label">Pointed at by</div>
          {inn.slice(0, 40).map((r, i) => (
            <button key={i} className="erd-rel" onClick={() => onPick(r.from)}>
              <strong>{name(r.from)?.name ?? r.from}</strong>
              <span className="muted">
                .{r.column ?? '?'}
                {r.inferred ? ' (inferred)' : ''}
              </span>
            </button>
          ))}
          {inn.length > 40 && <div className="small muted">and {inn.length - 40} more</div>}
        </section>
      )}
      <section>
        <div className="erd-panel-label">Columns</div>
        <table className="erd-cols">
          <tbody>
            {e.columns.map((c) => (
              <tr key={c.name}>
                <td className="mono">
                  {c.name}
                  {c.key && <span className="erd-mark"> PK</span>}
                  {c.fk && <span className="erd-mark"> FK</span>}
                </td>
                <td className="mono muted">
                  {c.type}
                  {c.required ? '' : ', optional'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </aside>
  )
}

function clip(s: string, w: number, charW: number): string {
  const max = Math.floor(w / charW)
  return s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s
}
