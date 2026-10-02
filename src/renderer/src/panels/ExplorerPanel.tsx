import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSession } from '../views/SessionView'
import { CHANGE_TOOLS, searchHits } from '../session'
import { relPath } from '../lib'
import { Empty, Icon, IconButton, PanelHeader } from '../components/ui'
import type { FileMark } from '../../../shared/events'
import { tr } from '../../../shared/i18n'

type Node = { name: string; path: string; children?: Map<string, Node> }

function buildTree(paths: string[]): Node {
  const root: Node = { name: '', path: '', children: new Map() }
  for (const p of paths) {
    const parts = p.split('/')
    let node = root
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1
      let child = node.children!.get(part)
      if (!child) {
        child = { name: part, path: parts.slice(0, i + 1).join('/'), children: isFile ? undefined : new Map() }
        node.children!.set(part, child)
      }
      node = child
    })
  }
  return root
}

const sorted = (m: Map<string, Node>) =>
  [...m.values()].sort((a, b) => (!!b.children === !!a.children ? a.name.localeCompare(b.name) : a.children ? -1 : 1))

type Heat = { reads: number; edits: number; searches: number; total: number }
type HeatKind = 'reads' | 'edits' | 'searches'

const HEAT_KEY = 'glassbox.explorerHeatmap'
function loadHeatPref(): boolean {
  try {
    return localStorage.getItem(HEAT_KEY) !== 'off'
  } catch {
    return true
  }
}
function saveHeatPref(on: boolean) {
  try {
    localStorage.setItem(HEAT_KEY, on ? 'on' : 'off')
  } catch {
    // Storage unavailable: the toggle still works until the panel closes.
  }
}

function heatLabel(h: Heat, folder: boolean): string {
  const parts = [h.reads && tr('explorerPanel.readTimes', { count: h.reads }), h.edits && tr('explorerPanel.editedTimes', { count: h.edits }), h.searches && tr('explorerPanel.searchedTimes', { count: h.searches })].filter(Boolean) as string[]
  const text = folder ? tr('explorerPanel.filesInHere', { list: parts.join(', ') }) : parts.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const MARKS: { mark: FileMark; icon: string; label: string }[] = [
  { mark: 'read', icon: 'eye', label: tr('explorerPanel.mustRead') },
  { mark: 'edit', icon: 'edit', label: tr('explorerPanel.mustEdit') },
  { mark: 'avoid', icon: 'lock', label: tr('explorerPanel.dontTouch') }
]

export function ExplorerPanel() {
  const { tab, s, workPath: selectedFile, markFile, updateRequirements, openFile } = useSession()
  const [files, setFiles] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [heatOn, setHeatOn] = useState(loadHeatPref)
  const toggleHeat = () => {
    setHeatOn(!heatOn)
    saveHeatPref(!heatOn)
  }

  const load = useCallback(() => {
    setError(null)
    window.glassbox.fs.list(tab.cwd).then(setFiles, (e) => setError(String(e)))
  }, [tab.cwd])
  useEffect(load, [load])

  const selectedRel = selectedFile ? relPath(tab.cwd, selectedFile) : null
  // Reveal the open file in the tree.
  useEffect(() => {
    if (!selectedRel) return
    const parts = selectedRel.split('/')
    setExpanded((e) => new Set([...e, ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))]))
  }, [selectedRel])

  const marks = useMemo(() => new Map(s.requirements.files.map((f) => [relPath(tab.cwd, f.path), f.mark])), [s.requirements.files, tab.cwd])
  const touched = useMemo(() => {
    const m = new Map<string, 'read' | 'edit'>()
    for (const f of s.files) {
      const r = relPath(tab.cwd, f.path)
      if (CHANGE_TOOLS.has(f.tool)) m.set(r, 'edit')
      else if (!m.has(r)) m.set(r, 'read')
    }
    return m
  }, [s.files, tab.cwd])

  // How much attention Claude gave each path this session: reads and edits (s.files), plus Grep/Glob by their `path` input.
  // Folders get the aggregate of everything under them.
  const heat = useMemo(() => {
    const byFile = new Map<string, Heat>()
    const byFolder = new Map<string, Heat>()
    const bump = (m: Map<string, Heat>, k: string, kind: HeatKind) => {
      const h = m.get(k) ?? { reads: 0, edits: 0, searches: 0, total: 0 }
      h[kind]++
      h.total++
      m.set(k, h)
    }
    const add = (path: string, kind: HeatKind) => {
      const k = relPath(tab.cwd, path).replace(/^\.\//, '').replace(/\/+$/, '')
      if (!k || k === '.' || /^([a-z]:)?\//i.test(k)) return // outside the project
      bump(byFile, k, kind)
      const parts = k.split('/')
      // A searched path may itself be a folder, so it counts towards the folder of the same name too.
      for (let i = 1; i <= parts.length; i++) bump(byFolder, parts.slice(0, i).join('/'), kind)
    }
    for (const f of s.files) {
      if (s.toolCalls[f.toolId]?.status === 'error') continue
      add(f.path, CHANGE_TOOLS.has(f.tool) ? 'edits' : 'reads')
    }
    for (const c of Object.values(s.toolCalls)) {
      if ((c.name === 'Grep' || c.name === 'Glob') && typeof c.input.path === 'string' && c.status !== 'error') add(c.input.path, 'searches')
      // Every file a search turned up.
      for (const h of searchHits(c)) add(h, 'searches')
    }
    const known = new Set(files ?? [])
    const max = (entries: [string, Heat][]) => Math.max(1, ...entries.map(([, h]) => h.total))
    return {
      byFile,
      byFolder,
      maxFile: max([...byFile].filter(([k]) => known.has(k))),
      maxFolder: max([...byFolder].filter(([k]) => !known.has(k)))
    }
  }, [s.files, s.toolCalls, tab.cwd, files])

  const fileSet = useMemo(() => (files ? new Set(files) : null), [files])
  const hot = useMemo(
    () => [...heat.byFile].filter(([k]) => !fileSet || fileSet.has(k)).sort((a, b) => b[1].total - a[1].total).slice(0, 8),
    [heat, fileSet]
  )

  const heatProps = (h: Heat | undefined, max: number, folder: boolean) => {
    if (!heatOn || !h) return { className: '', style: {} }
    const level = Math.max(0.12, h.total / max)
    return {
      className: ` heat-row${h.edits ? ' heat-edit' : ''}${folder ? ' heat-folder' : ''}`,
      style: { '--heat': level.toFixed(3) } as React.CSSProperties
    }
  }

  const visibleFiles = useMemo(() => {
    if (!files) return []
    const q = filter.trim().toLowerCase()
    return q ? files.filter((f) => f.toLowerCase().includes(q)) : files
  }, [files, filter])
  const tree = useMemo(() => buildTree(visibleFiles), [visibleFiles])
  const forceOpen = filter.trim().length > 0 && visibleFiles.length < 400

  const toggle = (path: string) =>
    setExpanded((e) => {
      const next = new Set(e)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const renderNode = (node: Node, depth: number): React.ReactNode => {
    if (node.children) {
      const open = forceOpen || expanded.has(node.path)
      const h = heat.byFolder.get(node.path)
      const hp = heatProps(h, heat.maxFolder, true)
      return (
        <div key={node.path}>
          <div
            className={`tree-row${hp.className}`}
            style={{ paddingLeft: 8 + depth * 12, ...hp.style }}
            onClick={() => toggle(node.path)}
            title={heatOn && h ? `${node.path}\n${heatLabel(h, true)}` : undefined}
          >
            <Icon name={open ? 'chevron-down' : 'chevron-right'} className="tree-chevron" />
            <Icon name={open ? 'folder-opened' : 'folder'} className="tree-folder" />
            <span className="tree-name">{node.name}</span>
            {heatOn && h && <span className="heat-count">{h.total}</span>}
          </div>
          {open && sorted(node.children).map((c) => renderNode(c, depth + 1))}
        </div>
      )
    }
    const mark = marks.get(node.path)
    const touch = touched.get(node.path)
    const h = heat.byFile.get(node.path)
    const hp = heatProps(h, heat.maxFile, false)
    return (
      <div
        key={node.path}
        className={`tree-row file${selectedRel === node.path ? ' selected' : ''}${hp.className}`}
        style={{ paddingLeft: 22 + depth * 12, ...hp.style }}
        onClick={() => openFile(node.path)}
        title={heatOn && h ? `${node.path}\n${heatLabel(h, false)}` : node.path}
      >
        <Icon name="file" className="tree-file" />
        <span className={`tree-name${touch ? ` touched-${touch}` : ''}`}>{node.name}</span>
        {heatOn && h && <span className="heat-count">{h.total}</span>}
        {touch && <span className={`touch-dot touch-${touch}`} title={touch === 'edit' ? tr('explorerPanel.editedByClaude') : tr('explorerPanel.readByClaude')} />}
        <span className="tree-actions">
          {MARKS.map((m) => (
            <button
              key={m.mark}
              className={mark === m.mark ? `mark-btn on mark-${m.mark}` : 'mark-btn'}
              title={mark === m.mark ? tr('explorerPanel.removeMark', { label: m.label }) : m.label}
              onClick={(e) => {
                e.stopPropagation()
                markFile(node.path, mark === m.mark ? null : m.mark)
              }}
            >
              <Icon name={m.icon} />
            </button>
          ))}
        </span>
      </div>
    )
  }

  return (
    <div className="panel">
      <PanelHeader title={tr('explorerPanel.title')}>
        {/* Stacked, the heading row is shown, so the clear link sits on it; the toolbar keeps search and icons. */}
        {s.requirements.files.length > 0 && (
          <button className="link small" onClick={() => updateRequirements((r) => ({ ...r, files: [] }))}>
            {tr('explorerPanel.clearMarks', { count: s.requirements.files.length })}
          </button>
        )}
      </PanelHeader>
      <div className="panel-toolbar">
        <div className="search">
          <Icon name="search" />
          <input placeholder={tr('explorerPanel.filterFiles')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <IconButton icon="flame" title={heatOn ? tr('explorerPanel.hideHeatmap') : tr('explorerPanel.showHeatmap')} active={heatOn} onClick={toggleHeat} />
        <IconButton icon="refresh" title={tr('explorerPanel.reload')} onClick={load} />
      </div>
      <div className="hint small muted">
        {tr('explorerPanel.hintBefore')} <Icon name="eye" /> {tr('explorerPanel.hintRead')} <Icon name="edit" /> {tr('explorerPanel.hintEdit')} <Icon name="lock" /> {tr('explorerPanel.hintAfter')}
        {heatOn && heat.byFile.size > 0 && ` ${tr('explorerPanel.hintShading')}`}
      </div>
      {heatOn && hot.length > 0 && (
        <div className="hot-list">
          <div className="hot-title small muted">{tr('explorerPanel.mostAttention')}</div>
          {hot.map(([path, h]) => (
            <div key={path} className="hot-row" onClick={() => openFile(path)} title={`${path}\n${heatLabel(h, false)}`}>
              <Icon name={h.edits ? 'edit' : h.reads ? 'eye' : 'search'} className={h.edits ? 'warn' : 'accent'} />
              <span className="grow ellipsis">
                {path.split('/').pop()} <span className="muted small">{path.split('/').slice(0, -1).join('/')}</span>
              </span>
              <span className="hot-bar" aria-hidden><span style={{ width: `${(h.total / hot[0][1].total) * 100}%` }} /></span>
              <span className="heat-count">{h.total}</span>
            </div>
          ))}
        </div>
      )}
      <div className="split-v single">
        <div className="tree">
          {error && <div className="note note-error">{error}</div>}
          {!files && !error && <div className="muted pad">{tr('explorerPanel.loadingFiles')}</div>}
          {files && visibleFiles.length === 0 && <Empty icon="search" title={tr('explorerPanel.noMatching')} />}
          {sorted(tree.children!).map((n) => renderNode(n, 0))}
        </div>
      </div>
    </div>
  )
}
