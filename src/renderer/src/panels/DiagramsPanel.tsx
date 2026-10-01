import { useEffect, useId, useState } from 'react'
import mermaid from 'mermaid'
import { useSession } from '../views/SessionView'
import { useThemeTokens } from '../App'
import type { Diagram } from '../session'
import { Empty, Icon, IconButton, PanelHeader } from '../components/ui'
import { PanZoom } from '../components/PanZoom'
import { READ_TOOLS } from '../side'
import { Select } from '../components/Select'

const PRESETS = [
  { label: 'Architecture of this work', prompt: 'the architecture of what we are building or changing in this session, and how it connects to the existing system' },
  { label: 'Request flow', prompt: 'a sequence diagram of the main request or data flow through the code we are working on' },
  { label: 'Modules in context', prompt: 'the modules and files currently in context and the dependencies between them' },
  { label: 'Data model', prompt: 'an entity-relationship diagram of the data model involved in this work' }
]

export function DiagramsPanel() {
  const { s, runSide } = useSession()
  const list = Object.values(s.diagrams).sort((a, b) => b.at - a.at)
  const [selected, setSelected] = useState<string | null>(null)
  const [ask, setAsk] = useState('')
  const current = (selected && s.diagrams[selected]) || list[0]
  const canSend = s.status !== 'new' && s.status !== 'stopped'

  const generate = (what: string, label: string) =>
    runSide({
      kind: 'diagram',
      title: `Diagram: ${label}`,
      prompt: `Use the show_diagram tool to draw ${what}. Base it on the actual code in this project (read what you need first), keep it readable, and give it a clear title.`,
      tools: READ_TOOLS
    })

  return (
    <div className="panel">
      <PanelHeader title="Diagrams" />
      <div className="panel-toolbar wrap">
        <div className="search grow">
          <Icon name="wand" />
          <input
            placeholder="Describe a diagram to generate…"
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ask.trim() && canSend) {
                generate(ask.trim(), ask.trim())
                setAsk('')
              }
            }}
          />
        </div>
        <button className="primary" disabled={!ask.trim() || !canSend} onClick={() => (generate(ask.trim(), ask.trim()), setAsk(''))}>
          Generate
        </button>
      </div>
      <div className="chips-row">
        {PRESETS.map((p) => (
          <button key={p.label} className="chip-btn" disabled={!canSend} onClick={() => generate(p.prompt, p.label)}>
            <Icon name="sparkle" /> {p.label}
          </button>
        ))}
      </div>
      {!current ? (
        <Empty icon="type-hierarchy-sub" title="No diagrams yet">
          Claude draws diagrams here whenever it designs or changes architecture. Generate one above at any time.
        </Empty>
      ) : (
        <>
          {list.length > 1 && (
            <div className="panel-toolbar">
              <Select className="grow" value={current.id} onChange={setSelected} aria-label="Diagram" options={list.map((d) => ({ value: d.id, label: d.title }))} />
              <span className="muted small">{list.length} diagrams</span>
            </div>
          )}
          <MermaidView diagram={current} />
        </>
      )}
    </div>
  )
}

function MermaidView({ diagram }: { diagram: Diagram }) {
  const theme = useThemeTokens()
  const baseId = useId().replace(/:/g, '')
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSource, setShowSource] = useState(false)
  const [full, setFull] = useState(false)

  useEffect(() => {
    let cancelled = false
    setError(null)
    mermaid.initialize({ startOnLoad: false, theme: theme.base === 'dark' ? 'dark' : 'default', securityLevel: 'strict', fontFamily: 'inherit' })
    mermaid
      .render(`m${baseId}${diagram.at}${theme.base}`, diagram.mermaid)
      // Render at natural size; PanZoom handles fitting and zooming.
      .then(({ svg }) => !cancelled && setSvg(svg.replace(/style="max-width:[^"]*"/, '').replace(/width="100%"/, '')))
      .catch((err) => !cancelled && setError(String(err)))
    return () => {
      cancelled = true
    }
  }, [diagram.mermaid, diagram.at, baseId, theme.base])

  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFull(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full])

  const canvas = svg && (
    <PanZoom
      contentKey={`${diagram.id}:${diagram.at}:${svg.length}:${theme.base}:${full}`}
      toolbar={
        <>
          <IconButton icon="code" title={showSource ? 'Hide Mermaid source' : 'Show Mermaid source'} onClick={() => setShowSource(!showSource)} active={showSource} />
          <IconButton icon="copy" title="Copy Mermaid source" onClick={() => void navigator.clipboard.writeText(diagram.mermaid)} />
          <IconButton icon={full ? 'screen-normal' : 'screen-full'} title={full ? 'Exit full screen (Esc)' : 'Full screen'} onClick={() => setFull(!full)} />
        </>
      }
    >
      <div dangerouslySetInnerHTML={{ __html: svg }} />
    </PanZoom>
  )

  const body = (
    <>
      <div className="preview-bar">
        <strong className="ellipsis grow">{diagram.title}</strong>
        <span className="muted small">Updated {new Date(diagram.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        {full && <IconButton icon="close" title="Close (Esc)" onClick={() => setFull(false)} />}
      </div>
      {error && <div className="note note-error">Mermaid couldn’t render this diagram: {error}</div>}
      <div className="diagram-canvas">{canvas}</div>
      {(showSource || error) && <pre className="diagram-source">{diagram.mermaid}</pre>}
    </>
  )

  return full ? (
    <>
      <div className="diagram" />
      <div className="diagram-full">{body}</div>
    </>
  ) : (
    <div className="diagram">{body}</div>
  )
}
