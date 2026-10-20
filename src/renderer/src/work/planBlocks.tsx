import { useEffect, useRef, useState } from 'react'
import { useSession } from '../views/SessionView'
import { useSketchUrl } from './SketchTab'
import { Icon } from '../components/ui'
import { baseName } from '../lib'
import { tr } from '../../../shared/i18n'

/**
 * Glassbox plans: Markdown with a few blocks Claude can drop in (MDX-style tags on their own lines),
 * so a plan reads as a document you can review rather than a wall of text. Nothing in a plan runs:
 * the tags are parsed here and drawn by Glassbox.
 *
 *   <Sketch id="checkout-refunds" />            a sketch from the Sketches view, inline
 *   <Files> + path | why  ~ path | what  - path | why </Files>   the files it adds, changes, removes
 *   <Diff file="src/x.ts"> unified diff </Diff>  the key change, as code
 *   <Callout type="risk|decision|note"> … </Callout>
 *   <Questions> - question | recommended | other … </Questions>   open questions, answered in place
 *
 * Mermaid diagrams are ordinary ```mermaid fences.
 */

export type FileRow = { op: 'add' | 'change' | 'remove'; path: string; why: string }
export type Question = { text: string; options: string[] }
export type Segment =
  | { kind: 'md'; text: string }
  | { kind: 'sketch'; id: string; version?: number; caption?: string }
  | { kind: 'files'; rows: FileRow[] }
  | { kind: 'diff'; file?: string; body: string }
  | { kind: 'callout'; type: 'risk' | 'decision' | 'note'; body: string }
  | { kind: 'questions'; items: Question[] }

const TAGS = 'Sketch|Files|Diff|Callout|Questions'
const OPEN = new RegExp(`^\\s*<(${TAGS})\\b([^>]*?)(/?)>\\s*(.*)$`)
const attrs = (s: string) => Object.fromEntries([...s.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*"?([^}"]*)"?\s*\})/g)].map((m) => [m[1], m[2] ?? m[3] ?? m[4] ?? '']))

/** Splits a plan into Markdown and blocks. Tags inside code fences are left alone. */
export function parsePlan(text: string): Segment[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: Segment[] = []
  let md: string[] = []
  let fence: string | null = null
  const flush = () => {
    if (md.join('').trim()) out.push({ kind: 'md', text: md.join('\n') })
    md = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const f = /^\s*(```+|~~~+)/.exec(line)
    if (f) fence = fence === null ? f[1] : line.trim().startsWith(fence) ? null : fence
    const m = fence === null && !f ? OPEN.exec(line) : null
    if (!m) {
      md.push(line)
      continue
    }
    const [, tag, rawAttrs, selfClosing, rest] = m
    const a = attrs(rawAttrs)
    let body: string[] = []
    if (!selfClosing) {
      const close = new RegExp(`</${tag}>\\s*$`)
      if (close.test(rest)) body = [rest.replace(close, '')]
      else {
        if (rest.trim()) body.push(rest)
        let j = i + 1
        while (j < lines.length && !close.test(lines[j])) body.push(lines[j++])
        if (j < lines.length) body.push(lines[j].replace(close, ''))
        i = j
      }
    }
    flush()
    const content = body.join('\n').replace(/^\n+|\s+$/g, '')
    if (tag === 'Sketch') out.push({ kind: 'sketch', id: a.id ?? '', version: a.version ? Number(a.version) : undefined, caption: a.caption || content || undefined })
    else if (tag === 'Files') out.push({ kind: 'files', rows: fileRows(content) })
    else if (tag === 'Diff') out.push({ kind: 'diff', file: a.file, body: content.replace(/^```\w*\n?|\n?```$/g, '') })
    else if (tag === 'Callout') out.push({ kind: 'callout', type: a.type === 'risk' || a.type === 'decision' ? a.type : 'note', body: content })
    else if (tag === 'Questions') out.push({ kind: 'questions', items: questions(content) })
  }
  flush()
  return out
}

function fileRows(text: string): FileRow[] {
  return text
    .split('\n')
    .map((l) => /^\s*(?:[-*]\s+)?([+~-]|new|edit|change|remove|delete)\s*:?\s+`?([^|`]+?)`?\s*(?:\||—|–|:\s)\s*(.*)$/i.exec(l) ?? /^\s*([+~-])\s*`?([^\s`]+)`?\s*$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => {
      const op = m[1].toLowerCase()
      return { op: op === '+' || op === 'new' ? 'add' : op === '-' || op === 'remove' || op === 'delete' ? 'remove' : 'change', path: m[2].trim(), why: (m[3] ?? '').trim() } as FileRow
    })
}

function questions(text: string): Question[] {
  return text
    .split('\n')
    .map((l) => /^\s*(?:[-*]|\d+[.)])\s+(.+)$/.exec(l)?.[1])
    .filter((l): l is string => !!l)
    .map((l) => {
      const [q, ...opts] = l.split('|').map((x) => x.trim())
      return { text: q, options: opts.filter(Boolean) }
    })
}

/** The same plan as plain Markdown, for places that show it as text (the activity panel, a copy). */
export function planAsMarkdown(text: string): string {
  if (!new RegExp(`<(${TAGS})\\b`).test(text)) return text
  return parsePlan(text)
    .map((s) => {
      if (s.kind === 'md') return s.text
      if (s.kind === 'sketch') return `*${tr('planBlocks.sketchRef', { id: s.id })}${s.caption ? `: ${s.caption}` : ''}*`
      if (s.kind === 'files') return s.rows.map((r) => `- ${r.op === 'add' ? '➕' : r.op === 'remove' ? '➖' : '✏️'} \`${r.path}\`${r.why ? ` ${r.why}` : ''}`).join('\n')
      if (s.kind === 'diff') return `${s.file ? `\`${s.file}\`\n` : ''}\`\`\`diff\n${s.body}\n\`\`\``
      if (s.kind === 'callout') return `> [!${s.type === 'risk' ? 'WARNING' : s.type === 'decision' ? 'IMPORTANT' : 'NOTE'}]\n${s.body.split('\n').map((l) => `> ${l}`).join('\n')}`
      return s.items.map((q) => `- ${q.text}${q.options[0] ? ` (${tr('planBlocks.recommendedShort', { option: q.options[0] })})` : ''}`).join('\n')
    })
    .join('\n\n')
}

/** A sketch, inline in the plan at the column's width; click it to open it in Sketches (to pick or comment). */
export function SketchBlock({ id, version, caption }: { id: string; version?: number; caption?: string }) {
  const { s, showPanel } = useSession()
  const sketch = s.sketches?.[id]
  if (!sketch) return <div className="plan-block plan-missing muted small">{tr('planBlocks.noSketch', { id })}</div>
  const v = sketch.versions[Math.min(sketch.versions.length, Math.max(1, version ?? sketch.versions.length)) - 1]
  return (
    <figure className="plan-block plan-sketch">
      <SketchFrame version={v} />
      <figcaption>
        <Icon name="edit" />
        <span className="grow">
          <strong>{sketch.title}</strong>
          {caption && <span className="muted"> {caption}</span>}
        </span>
        <button className="link small" onClick={() => showPanel('sketches')}>
          {tr('planBlocks.openSketch')}
        </button>
      </figcaption>
    </figure>
  )
}

function SketchFrame({ version }: { version: Parameters<typeof useSketchUrl>[0] }) {
  const { url } = useSketchUrl(version)
  const box = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const [width, setWidth] = useState(0)
  const [height, setHeight] = useState(480)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return
      const m = e.data as { glassboxSketch?: boolean; type?: string; h?: number }
      if (m?.glassboxSketch && m.type === 'size' && m.h) setHeight(Math.max(120, Math.min(4000, m.h)))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])
  // Drawn at its own width and scaled to the column, so a 1200px layout reads as it would on screen.
  const scale = width ? Math.min(1, width / version.width) : 1
  return (
    <div className="plan-sketch-frame" ref={box} style={{ height: height * scale }}>
      {url && <iframe ref={frame} src={url} title={tr('planBlocks.sketch')} sandbox="allow-scripts" tabIndex={-1} style={{ width: version.width, height, transform: `scale(${scale})` }} />}
    </div>
  )
}

const OP_LABEL = { add: 'planBlocks.opAdd', change: 'planBlocks.opChange', remove: 'planBlocks.opRemove' } as const

/** The files the plan touches, by folder: what's added, changed and removed, and why. */
export function FilesBlock({ rows }: { rows: FileRow[] }) {
  const { tab, openFile } = useSession()
  const dirs = new Map<string, FileRow[]>()
  for (const r of rows) {
    const dir = r.path.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
    dirs.set(dir, [...(dirs.get(dir) ?? []), r])
  }
  const counts = { add: rows.filter((r) => r.op === 'add').length, change: rows.filter((r) => r.op === 'change').length, remove: rows.filter((r) => r.op === 'remove').length }
  return (
    <div className="plan-block plan-files">
      <div className="plan-block-head">
        <Icon name="files" />
        <span className="grow">{tr('planBlocks.files', { count: rows.length })}</span>
        {(['add', 'change', 'remove'] as const).filter((k) => counts[k]).map((k) => (
          <span key={k} className={`plan-op op-${k}`}>{tr(`planBlocks.count.${k}`, { count: counts[k] })}</span>
        ))}
      </div>
      {[...dirs].map(([dir, list]) => (
        <div key={dir} className="plan-files-dir">
          {dir && <div className="plan-files-dirname">{dir}/</div>}
          {list.map((r) => (
            <div key={r.path} className={`plan-file op-${r.op}`}>
              <span className={`plan-op op-${r.op}`} title={tr(OP_LABEL[r.op])}>{r.op === 'add' ? '+' : r.op === 'remove' ? '−' : '~'}</span>
              {r.op === 'add' ? (
                <span className="plan-file-name">{baseName(r.path)}</span>
              ) : (
                <button className="plan-file-name link" onClick={() => openFile(`${tab.cwd.replace(/[\\/]+$/, '')}/${r.path.replace(/^\.?\//, '')}`)} title={r.path}>
                  {baseName(r.path)}
                </button>
              )}
              {r.why && <span className="plan-file-why">{r.why}</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/** The key change as a diff: added and removed lines coloured; a long one folds after 24 lines. */
export function DiffBlock({ file, body }: { file?: string; body: string }) {
  const lines = body.split('\n')
  const [open, setOpen] = useState(lines.length <= 24)
  const shown = open ? lines : lines.slice(0, 16)
  return (
    <div className="plan-block plan-diff">
      {file && (
        <div className="plan-block-head">
          <Icon name="diff" />
          <span className="grow mono">{file}</span>
          <span className="small">
            <span className="ok">+{lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length}</span> <span className="err">−{lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length}</span>
          </span>
        </div>
      )}
      <pre>
        {shown.map((l, i) => (
          <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}>
            {l || ' '}
          </div>
        ))}
      </pre>
      {lines.length > 24 && (
        <button className="plan-more" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name={open ? 'chevron-up' : 'chevron-down'} /> {open ? tr('planBlocks.showLess') : tr('planBlocks.showAllLines', { count: lines.length })}
        </button>
      )}
    </div>
  )
}

const CALLOUT = { risk: { icon: 'warning', cls: 'md-alert-warning' }, decision: { icon: 'pass', cls: 'md-alert-important' }, note: { icon: 'info', cls: 'md-alert-note' } } as const

export function CalloutBlock({ type, html }: { type: 'risk' | 'decision' | 'note'; html: string }) {
  const c = CALLOUT[type]
  return (
    <div className={`plan-block md-alert ${c.cls}`}>
      <div className="md-alert-title">
        <Icon name={c.icon} /> {tr(`planBlocks.callout.${type}`)}
      </div>
      <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}

export type Answers = Record<string, string>

/** Open questions, each with Claude's recommendation picked to start with; your answers go with your decision. */
export function QuestionsBlock({ items, answers, onAnswer, editable }: { items: Question[]; answers: Answers; onAnswer: (q: string, a: string) => void; editable: boolean }) {
  return (
    <div className="plan-block plan-questions">
      <div className="plan-block-head">
        <Icon name="question" />
        <span className="grow">{tr('planBlocks.questions', { count: items.length })}</span>
        {editable && <span className="muted small">{tr('planBlocks.questionsHint')}</span>}
      </div>
      {items.map((q, qi) => {
        const chosen = answers[q.text] ?? q.options[0] ?? ''
        const custom = !!chosen && !q.options.includes(chosen)
        return (
          <div key={qi} className="plan-question">
            <div className="plan-question-text">{q.text}</div>
            <div className="plan-options" role="radiogroup" aria-label={q.text}>
              {q.options.map((o, oi) => (
                <button key={oi} role="radio" aria-checked={chosen === o} disabled={!editable} className={chosen === o ? 'plan-option on' : 'plan-option'} onClick={() => onAnswer(q.text, o)}>
                  {o}
                  {oi === 0 && <span className="plan-recommended">{tr('planBlocks.recommended')}</span>}
                </button>
              ))}
              {editable && (
                <input
                  className={custom ? 'plan-option-own on' : 'plan-option-own'}
                  placeholder={q.options.length ? tr('planBlocks.somethingElse') : tr('planBlocks.yourAnswer')}
                  value={custom ? chosen : ''}
                  onChange={(e) => onAnswer(q.text, e.target.value)}
                />
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Your answers, as text for Claude: only where you chose something other than its recommendation. */
export function answersText(segments: Segment[], answers: Answers): string {
  const lines: string[] = []
  for (const s of segments) {
    if (s.kind !== 'questions') continue
    for (const q of s.items) {
      const a = answers[q.text]?.trim()
      if (a && a !== q.options[0]) lines.push(`- ${q.text} → ${a}`)
      else if (q.options[0]) lines.push(`- ${q.text} → ${q.options[0]} (your recommendation)`)
    }
  }
  return lines.length ? `Answers to the plan's open questions:\n${lines.join('\n')}` : ''
}
