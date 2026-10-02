import { useEffect, useState } from 'react'
import type { Architecture } from '../../shared/architecture'
import type { FileTouch, SessionState } from './session'
import { CHANGE_TOOLS, isClaudeOwnFile } from './session'
import { tr } from '../../shared/i18n'

// Kept across tab switches (the map tab unmounts): the last map per folder, and the file-count
// version it was last rebuilt for, so remounting never redraws and never forces a rebuild again.
const maps = new Map<string, Architecture>()
const builtFor = new Map<string, number>()
const key = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const same = (a: string, b: string) => key(a) === key(b)

/**
 * The project's module map. Shown straight from cache; rebuilt only when `version` goes up (Claude
 * created files) or when the main process says it redrew the map (a new session, or Claude finished
 * naming the categories).
 */
export function useArchitecture(cwd: string, version: number): Architecture | null {
  const [arch, setArch] = useState<Architecture | null>(() => maps.get(cwd) ?? null)
  const [bump, setBump] = useState(0)
  useEffect(() => window.glassbox.architecture.onChanged((root) => {
    const cur = maps.get(cwd)
    if (!cur || same(cur.root, root)) setBump((n) => n + 1)
  }), [cwd])
  useEffect(() => {
    let stale = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let tries = 0
    // The first time a folder is seen (e.g. a session resumed after a restart) the saved map is
    // taken as current; after that, new files Claude creates trigger a rebuild.
    if (!builtFor.has(cwd)) builtFor.set(cwd, version)
    const force = version > builtFor.get(cwd)!
    if (force) builtFor.set(cwd, version)
    const fetch = (force: boolean) =>
      window.glassbox.architecture
        .get(cwd, force)
        .then((a) => {
          if (stale) return
          maps.set(cwd, a)
          setArch(a)
          // Claude is still naming the categories: look again in a few seconds (for up to a minute).
          if (a.organising && tries++ < 12) timer = setTimeout(() => fetch(false), 5000)
        })
        .catch((e) => !stale && !maps.get(cwd) && setArch({ root: cwd, layers: [], modules: [], edges: [], source: 'detected', error: String(e) }))
    void fetch(force)
    return () => {
      stale = true
      if (timer) clearTimeout(timer)
    }
  }, [cwd, version, bump])
  return arch
}

/** How a tool touching a file reads on the map. */
export function touchVerb(tool: string): string {
  switch (tool) {
    case 'Read':
    case 'NotebookRead':
      return tr('architecture.reading')
    case 'Write':
      return tr('architecture.writing')
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return tr('architecture.editing')
    case 'ShellEdit':
      return tr('architecture.changing')
    case 'Grep':
    case 'Glob':
      return tr('architecture.searching')
    default:
      return tr('architecture.lookingAt')
  }
}

export const isEditTouch = (f: FileTouch, s: SessionState) => CHANGE_TOOLS.has(f.tool) && !isClaudeOwnFile(f.path) && s.toolCalls[f.toolId]?.status !== 'error'

/** Files Claude has created (not just edited) this session: first touched by Write. */
export function createdFiles(s: SessionState): Set<string> {
  const first = new Map<string, string>()
  for (const f of s.files) if (!first.has(f.path)) first.set(f.path, f.tool)
  return new Set([...first].filter(([, tool]) => tool === 'Write').map(([p]) => p))
}
