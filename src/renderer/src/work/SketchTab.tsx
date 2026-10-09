import { useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '../views/SessionView'
import { useThemeTokens } from '../App'
import { THEMES, type ThemeTokens } from '../theme'
import { ACCENTS, accentFor, useAppearance } from '../appearance'
import { textOn } from '../colour'
import type { Sketch } from '../session'
import { Empty, Icon, IconButton } from '../components/ui'
import { PanZoom } from '../components/PanZoom'
import { Select } from '../components/Select'
import { tr } from '../../../shared/i18n'

/** Hand pans (a click still presses things in the page); Comment points at a part to say something about it; Use hands the page the mouse. */
type Mode = 'hand' | 'comment' | 'use'
type Pending = { kind: 'pick'; label: string } | { kind: 'comment'; what: { kind: string; text: string; pick: string; section: string } }
type FromPage = { glassboxSketch: true } & ({ type: 'size'; h: number } | { type: 'cursor'; pointer: boolean } | { type: 'pick'; label: string } | { type: 'comment'; what: Extract<Pending, { kind: 'comment' }>['what'] })

/**
 * The colours a sketch is drawn in: one of the app's schemes and accents when Claude picked them,
 * otherwise the user's own.
 */
function schemeFor(app: ThemeTokens, userAccent: string, scheme?: 'dark' | 'light', accent?: string): ThemeTokens {
  const base = scheme ?? app.base
  const tokens = base === app.base ? app : THEMES[`glassbox-${base}`]
  const preset = accent ? ACCENTS.find((a) => a.id === accent) : undefined
  if (!preset && base === app.base) return app
  const colour = preset ? preset[base] : accentFor({ accent: userAccent } as Parameters<typeof accentFor>[0], base)
  return { ...tokens, accent: colour, accentFg: preset ? tokens.accentFg : textOn(colour) }
}

/** Claude's sketches: rough pages to look at, choose between and comment on, panned and zoomed like a diagram. */
export function SketchTab() {
  const { s } = useSession()
  const list = Object.values(s.sketches ?? {}).sort((a, b) => b.at - a.at)
  const [selected, setSelected] = useState<string | null>(null)
  const current = (selected && s.sketches?.[selected]) || list[0]
  if (!current)
    return (
      <div className="work-page sketch-view">
        <Empty icon="edit" title={tr('sketchTab.emptyTitle')}>
          {tr('sketchTab.emptyBody')}
        </Empty>
      </div>
    )
  return (
    <div className="work-page sketch-view">
      <SketchView key={current.id} sketch={current} others={list} onSelect={setSelected} />
    </div>
  )
}

function SketchView({ sketch, others, onSelect }: { sketch: Sketch; others: Sketch[]; onSelect: (id: string) => void }) {
  const { s, send } = useSession()
  const app = useThemeTokens()
  const appearance = useAppearance()
  const count = sketch.versions.length
  const [index, setIndex] = useState(count - 1)
  // A new version from Claude comes to the front.
  useEffect(() => setIndex(count - 1), [count])
  const version = sketch.versions[Math.min(index, count - 1)]
  const theme = useMemo(() => schemeFor(app, appearance.accent, version.scheme, version.accent), [app, appearance.accent, version.scheme, version.accent])
  const [url, setUrl] = useState<string | null>(null)
  const [height, setHeight] = useState<number | null>(null)
  const [mode, setMode] = useState<Mode>('hand')
  const [pointer, setPointer] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const [note, setNote] = useState('')
  const frame = useRef<HTMLIFrameElement>(null)
  const noteBox = useRef<HTMLInputElement>(null)

  // The page is served from its own sandboxed address, in the app's colours.
  useEffect(() => {
    let live = true
    setHeight(null)
    const t = { base: theme.base, bg: theme.bg, surface: theme.surface, surface2: theme.surface2, elevated: theme.elevated, border: theme.border, fg: theme.fg, muted: theme.muted, subtle: theme.subtle, accent: theme.accent, accentFg: theme.accentFg, ok: theme.ok, warn: theme.warn, err: theme.err, info: theme.info }
    void window.glassbox.sketch.url(version.html).then((u) => live && setUrl(`${u}?t=${encodeURIComponent(JSON.stringify(t))}`))
    return () => {
      live = false
    }
  }, [version.html, theme])

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const m = e.data as FromPage
      if (!m || m.glassboxSketch !== true) return
      if (m.type === 'size') setHeight(Math.max(120, m.h))
      else if (m.type === 'cursor') setPointer(m.pointer)
      else if (m.type === 'pick') setPending({ kind: 'pick', label: m.label })
      else if (m.type === 'comment') setPending({ kind: 'comment', what: m.what })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(() => {
    if (pending) noteBox.current?.focus()
  }, [pending])

  const toPage = (m: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ glassboxSketch: true, ...m }, '*')
  const hoverAt = useRef<number | null>(null)
  const hover = (at: { x: number; y: number } | null) => {
    if (hoverAt.current) cancelAnimationFrame(hoverAt.current)
    hoverAt.current = requestAnimationFrame(() => toPage({ type: 'hover', x: at?.x ?? null, y: at?.y ?? null, mode }))
  }
  const cancel = () => {
    setPending(null)
    setNote('')
    toPage({ type: 'clear' })
  }
  const switchMode = (m: Mode) => {
    setMode(m)
    setPointer(false)
    toPage({ type: 'hover', x: null, y: null, mode: m })
  }

  const where = tr('sketchTab.where', { title: sketch.title, n: index + 1 })
  const subject = (w: Extract<Pending, { kind: 'comment' }>['what']) => {
    const what = w.text ? (w.kind ? tr('sketchTab.subjectKind', { kind: w.kind, text: w.text }) : `“${w.text}”`) : tr('sketchTab.subjectPart')
    return w.pick ? tr('sketchTab.subjectInOption', { what, option: w.pick }) : w.section ? tr('sketchTab.subjectInSection', { what, section: w.section }) : what
  }
  const message = !pending
    ? ''
    : pending.kind === 'pick'
      ? tr('sketchTab.pickMessage', { option: pending.label, where }) + (note.trim() ? ` ${note.trim()}` : '')
      : tr('sketchTab.commentMessage', { where, subject: subject(pending.what), note: note.trim() })
  const canSend = !!pending && (pending.kind === 'pick' || !!note.trim()) && s.status !== 'stopped'
  const submit = () => {
    if (!canSend) return
    void send(message)
    cancel()
  }

  const hint = mode === 'hand' ? tr('sketchTab.hintHand') : mode === 'comment' ? tr('sketchTab.hintComment') : tr('sketchTab.hintUse')
  return (
    <>
      <div className="preview-bar sketch-bar">
        {others.length > 1 ? (
          <Select className="sketch-pick" value={sketch.id} onChange={onSelect} aria-label={tr('sketchTab.sketch')} options={others.map((x) => ({ value: x.id, label: x.title }))} />
        ) : (
          <strong className="ellipsis">{sketch.title}</strong>
        )}
        {count > 1 && (
          <span className="sketch-versions">
            <IconButton icon="chevron-left" title={tr('sketchTab.older')} disabled={index === 0} onClick={() => (cancel(), setIndex(index - 1))} />
            <span className="num">{tr('sketchTab.version', { n: index + 1, total: count })}</span>
            <IconButton icon="chevron-right" title={tr('sketchTab.newer')} disabled={index >= count - 1} onClick={() => (cancel(), setIndex(index + 1))} />
          </span>
        )}
        <span className="muted small ellipsis grow">{version.note}</span>
        <span className="muted small">{new Date(version.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div
        className="sketch-canvas"
        onKeyDown={(e) => {
          if (e.target instanceof HTMLInputElement) return
          if (e.key === 'h') switchMode('hand')
          else if (e.key === 'c') switchMode('comment')
          else if (e.key === 'u') switchMode('use')
          else if (e.key === 'Escape' && pending) cancel()
        }}
      >
        {url && (
          <PanZoom
            contentKey={`${sketch.id}:${index}:${theme.base}:${height === null ? 0 : 1}`}
            size={{ w: version.width, h: height ?? 800 }}
            fitWidth
            className={`sketch-${mode}${pointer && mode !== 'use' ? ' over-target' : ''}`}
            hint={hint}
            onTap={mode === 'use' ? undefined : (x, y) => toPage({ type: 'tap', x, y, mode })}
            onHover={mode === 'use' ? undefined : hover}
            toolbar={
              <>
                <span className="panzoom-sep" />
                <IconButton icon="move" title={tr('sketchTab.modeHand')} active={mode === 'hand'} onClick={() => switchMode('hand')} />
                <IconButton icon="comment" title={tr('sketchTab.modeComment')} active={mode === 'comment'} onClick={() => switchMode('comment')} />
                <IconButton icon="inspect" title={tr('sketchTab.modeUse')} active={mode === 'use'} onClick={() => switchMode('use')} />
                <span className="panzoom-sep" />
                <IconButton icon="copy" title={tr('sketchTab.copyHtml')} onClick={() => void navigator.clipboard.writeText(version.html)} />
              </>
            }
          >
            <iframe
              ref={frame}
              className="sketch-frame"
              title={sketch.title}
              src={url}
              sandbox="allow-scripts"
              width={version.width}
              height={height ?? 800}
              style={{ pointerEvents: mode === 'use' ? 'auto' : 'none' }}
            />
          </PanZoom>
        )}
      </div>
      {pending && (
        <div className="sketch-reply">
          <Icon name={pending.kind === 'pick' ? 'pass' : 'comment'} />
          <span className="sketch-reply-what ellipsis">
            {pending.kind === 'pick' ? tr('sketchTab.picked', { option: pending.label }) : tr('sketchTab.commentOn', { subject: subject(pending.what) })}
          </span>
          <input
            ref={noteBox}
            className="grow"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              else if (e.key === 'Escape') cancel()
            }}
            placeholder={pending.kind === 'pick' ? tr('sketchTab.pickNote') : tr('sketchTab.commentNote')}
            aria-label={pending.kind === 'pick' ? tr('sketchTab.pickNote') : tr('sketchTab.commentNote')}
          />
          <button className="primary" disabled={!canSend} onClick={submit}>
            {tr('sketchTab.send')}
          </button>
          <IconButton icon="close" title={tr('sketchTab.cancel')} onClick={cancel} />
        </div>
      )}
    </>
  )
}
