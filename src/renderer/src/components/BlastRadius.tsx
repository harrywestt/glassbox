import { useEffect, useMemo, useRef, useState } from 'react'
import type { BlastRadiusResult } from '../../../main/deps'
import { baseName, relPath } from '../lib'
import { Icon, Section } from './ui'

type DepsApi = { find: (cwd: string, files: string[]) => Promise<BlastRadiusResult> }

const DEBOUNCE_MS = 800

const dirOf = (p: string) => {
  const parts = p.split('/')
  return parts.length > 1 ? parts.slice(0, -1).join('/') : ''
}

/** Files that import what Claude changed, per edited file. */
export function BlastRadius({ cwd, files, onOpen }: { cwd: string; files: string[]; onOpen: (path: string) => void }) {
  const [result, setResult] = useState<BlastRadiusResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const request = useRef(0)
  const api = (window.glassbox as unknown as { deps?: DepsApi }).deps

  // Stable key so a new array with the same files doesn't re-query.
  const key = useMemo(() => [...new Set(files)].sort().join('\n'), [files])

  const run = (list: string[]) => {
    if (!api) return
    const id = ++request.current
    setLoading(true)
    api.find(cwd, list).then(
      (r) => {
        if (id !== request.current) return
        setResult(r)
        setLoading(false)
      },
      (e) => {
        if (id !== request.current) return
        setResult({ files: [], error: String(e) })
        setLoading(false)
      }
    )
  }

  useEffect(() => {
    if (!key) {
      request.current++
      setResult(null)
      setLoading(false)
      return
    }
    const list = key.split('\n')
    const timer = setTimeout(() => run(list), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [key, cwd])

  const rows = useMemo(() => [...(result?.files ?? [])].sort((a, b) => b.dependents.length - a.dependents.length || a.path.localeCompare(b.path)), [result])
  const total = useMemo(() => new Set(rows.flatMap((f) => f.dependents.map((d) => d.path))).size, [rows])

  const toggle = (path: string) =>
    setOpen((o) => {
      const next = new Set(o)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  if (!api || !key) return null
  return (
    <Section
      id="blast-radius"
      className="br-section"
      title="Blast radius"
      meta={result && rows.length > 0 && <span className="count">{total} dependent file{total === 1 ? '' : 's'}</span>}
      actions={
        loading ? (
          <Icon name="loading" className="codicon-modifier-spin muted" title="Searching" />
        ) : (
          <button className="icon-btn br-refresh" title="Search again" aria-label="Search again" onClick={() => run(key.split('\n'))}>
            <Icon name="refresh" />
          </button>
        )
      }
    >

      {!api ? (
        <div className="muted small">Blast radius isn’t available in this build. It needs the dependency search from the main process.</div>
      ) : !key ? (
        <div className="muted small">Nothing edited yet. Once Claude changes a file, the files that import it show up here.</div>
      ) : !result ? (
        <div className="muted small">Looking for files that import the changes…</div>
      ) : (
        <>
          {result.error && <div className="br-error small">{result.error}</div>}
          {rows.length === 0 && !result.error && <div className="muted small">No edited files could be checked.</div>}
          {rows.length > 0 && total === 0 && (
            <div className="muted small br-none">
              Nothing in the project imports these files by name. Dynamic imports, config wiring and reflection aren’t detected, so a quick check is still worth it.
            </div>
          )}
          <div className="br-list">
            {rows.map((f) => {
              const expanded = open.has(f.path)
              const n = f.dependents.length
              const dir = dirOf(relPath(cwd, f.path))
              return (
                <div key={f.path} className="br-file">
                  <div
                    className={n ? 'list-row clickable br-file-row' : 'list-row br-file-row'}
                    onClick={() => n && toggle(f.path)}
                    title={f.path}
                    aria-expanded={n ? expanded : undefined}
                  >
                    <Icon name={n ? (expanded ? 'chevron-down' : 'chevron-right') : 'blank'} className="br-chevron" />
                    <span className="grow ellipsis">
                      <span className="mono">{baseName(f.path)}</span>
                      {dir && <span className="muted small br-dir">{dir}</span>}
                    </span>
                    <span className={n ? 'br-count' : 'br-count muted'}>
                      {n ? `${n}${f.truncated ? '+' : ''} dependent${n === 1 && !f.truncated ? '' : 's'}` : 'None found'}
                    </span>
                  </div>
                  {expanded && (
                    <div className="br-deps">
                      {f.dependents.map((d) => (
                        <button key={`${d.path}:${d.line}`} className="br-dep" onClick={() => onOpen(d.path)} title={`Open ${d.path}`}>
                          <span className="br-dep-path">
                            <span className="mono">{baseName(d.path)}</span>
                            <span className="muted small">:{d.line}</span>
                            <span className="muted small br-dir">{dirOf(relPath(cwd, d.path))}</span>
                          </span>
                          <code className="br-dep-code">{d.text}</code>
                        </button>
                      ))}
                      {f.truncated && <div className="muted small br-more">Showing the first {n}. More files reference it.</div>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </Section>
  )
}
