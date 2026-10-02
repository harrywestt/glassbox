import { useSyncExternalStore } from 'react'
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import { tr } from '../../shared/i18n'

/** Which sessions are pinned (kept for good), shared by the session header and History. */

let ids = new Set<string>()
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((l) => l())

let loaded = false
function load() {
  if (loaded) return
  loaded = true
  void window.glassbox.history.pinnedIds().then((list) => {
    ids = new Set(list)
    changed()
  }, () => {})
}

export function usePinned(): Set<string> {
  load()
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => ids
  )
}

/** Pin or unpin; resolves with an error to show if pinning wasn't possible. */
export async function setPinned(info: SDKSessionInfo, pin: boolean): Promise<string | undefined> {
  if (pin) {
    const r = await window.glassbox.history.pin(info)
    if (!r.ok) return r.error ?? tr('pins.couldNotPin')
    ids = new Set([...ids, info.sessionId])
  } else {
    await window.glassbox.history.unpin(info.sessionId)
    ids = new Set([...ids].filter((x) => x !== info.sessionId))
  }
  changed()
  return undefined
}
