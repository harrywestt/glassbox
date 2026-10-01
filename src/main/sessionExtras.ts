import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * What a session did that its Claude transcript doesn't record, kept beside it so a resumed session
 * shows the same picture: files changed by shell commands (Glassbox sees those by snapshotting the
 * tree, not from the transcript) and the running cost (result messages aren't in the transcript).
 */
export type ShellEditRecord = { toolId: string; files: string[]; agentId: string | null; at: number }
export type SessionExtras = { costUsd: number; shellEdits: ShellEditRecord[] }

const dir = async () => join((await import('electron')).app.getPath('userData'), 'session-extras')
const fileFor = async (sessionId: string) => join(await dir(), `${sessionId.replace(/[^\w-]/g, '')}.json`)

export async function loadExtras(sessionId: string): Promise<SessionExtras | null> {
  try {
    return JSON.parse(await readFile(await fileFor(sessionId), 'utf8')) as SessionExtras
  } catch {
    return null
  }
}

// Writes are serialised per session so a fast run of edits can't interleave half-written files.
const pending = new Map<string, Promise<void>>()
export function saveExtras(sessionId: string, extras: SessionExtras): Promise<void> {
  const prev = pending.get(sessionId) ?? Promise.resolve()
  const next = prev
    .then(async () => {
      await mkdir(await dir(), { recursive: true })
      await writeFile(await fileFor(sessionId), JSON.stringify(extras))
    })
    .catch(() => {})
  pending.set(sessionId, next)
  return next
}
