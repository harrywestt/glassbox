import { useEffect, useState } from 'react'
import type { LibraryComponent, LibraryKind, LibraryScreen } from '../../shared/library'

/** The project's component library or screens (kept by Glassbox, outside the repo), kept fresh as they change. */
export function useLibrary<K extends LibraryKind>(cwd: string, kind: K): (K extends 'components' ? LibraryComponent : LibraryScreen)[] | null {
  const [list, setList] = useState<(K extends 'components' ? LibraryComponent : LibraryScreen)[] | null>(null)
  useEffect(() => {
    let live = true
    const load = () => void window.glassbox.library.list(cwd, kind).then((l) => live && setList(l), () => live && setList([]))
    load()
    const off = window.glassbox.library.onChanged((e) => e.kind === kind && load())
    return () => {
      live = false
      off()
    }
  }, [cwd, kind])
  return list
}

/** Components whose source file changed since they were saved (checked in code when the library changes, and every minute). */
export function useStaleComponents(cwd: string, components: LibraryComponent[] | null): Set<string> {
  const [stale, setStale] = useState<Set<string>>(new Set())
  useEffect(() => {
    let live = true
    const check = () => void window.glassbox.library.stale(cwd).then((ids) => live && setStale(new Set(ids)), () => {})
    check()
    const t = setInterval(check, 60_000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [cwd, components])
  return stale
}
