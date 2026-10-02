import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import { tr } from '../shared/i18n'

/**
 * Pinned sessions: kept for good. Claude Code clears old transcripts on its own (after 30 days by
 * default), so a pinned one is copied into Glassbox's folder, kept up to date as you use it, and put
 * back where Claude Code expects it if it's gone when you open it. Its subagent transcripts (the
 * folder beside it) come along too.
 */

export type PinnedSession = SDKSessionInfo & { pinnedAt: number; /** Where Claude Code keeps it. */ transcript: string }

const projects = () => join(homedir(), '.claude', 'projects')
const store = () => join(app.getPath('userData'), 'pinned')
const indexFile = () => join(store(), 'index.json')

function load(): Record<string, PinnedSession> {
  try {
    return JSON.parse(readFileSync(indexFile(), 'utf8')) as Record<string, PinnedSession>
  } catch {
    return {}
  }
}
function save(all: Record<string, PinnedSession>) {
  mkdirSync(store(), { recursive: true })
  writeFileSync(indexFile(), JSON.stringify(all, null, 2))
}

/** The transcript Claude Code keeps for a session, wherever its project folder is. */
function findTranscript(id: string): string | undefined {
  try {
    for (const dir of readdirSync(projects())) {
      const p = join(projects(), dir, `${id}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {
    /* no projects folder yet */
  }
  return undefined
}

/** Copy the transcript (and its subagents folder) into the backup, if it has changed. */
function backUp(p: PinnedSession) {
  if (!existsSync(p.transcript)) return
  const copy = join(store(), `${p.sessionId}.jsonl`)
  if (existsSync(copy) && statSync(copy).mtimeMs >= statSync(p.transcript).mtimeMs) return
  mkdirSync(store(), { recursive: true })
  cpSync(p.transcript, copy)
  const side = p.transcript.replace(/\.jsonl$/, '')
  if (existsSync(side)) cpSync(side, join(store(), p.sessionId), { recursive: true })
}

export function pinnedSessions(): PinnedSession[] {
  return Object.values(load()).sort((a, b) => b.pinnedAt - a.pinnedAt)
}

export function pinSession(info: SDKSessionInfo): { ok: boolean; error?: string } {
  const transcript = findTranscript(info.sessionId)
  if (!transcript) return { ok: false, error: tr('mainPinned.noHistory') }
  const all = load()
  all[info.sessionId] = { ...info, pinnedAt: Date.now(), transcript }
  backUp(all[info.sessionId])
  save(all)
  return { ok: true }
}

export function unpinSession(id: string) {
  const all = load()
  if (!all[id]) return
  delete all[id]
  save(all)
  rmSync(join(store(), `${id}.jsonl`), { force: true })
  rmSync(join(store(), id), { recursive: true, force: true })
}

/** Bring each pinned backup up to date, and refresh what the list shows (title, last used). */
export function refreshPinned(live: SDKSessionInfo[]) {
  const all = load()
  if (!Object.keys(all).length) return
  const byId = new Map(live.map((s) => [s.sessionId, s]))
  for (const p of Object.values(all)) {
    const now = byId.get(p.sessionId)
    if (now) all[p.sessionId] = { ...p, ...now, pinnedAt: p.pinnedAt, transcript: p.transcript }
    try {
      backUp(all[p.sessionId])
    } catch {
      /* try again next time */
    }
  }
  save(all)
}

/** Before opening a pinned session: if Claude Code has cleared its transcript, put the backup back. */
export function restorePinned(id: string) {
  const p = load()[id]
  if (!p || existsSync(p.transcript)) return
  const copy = join(store(), `${id}.jsonl`)
  if (!existsSync(copy)) return
  mkdirSync(dirname(p.transcript), { recursive: true })
  cpSync(copy, p.transcript)
  const side = join(store(), id)
  if (existsSync(side)) cpSync(side, p.transcript.replace(/\.jsonl$/, ''), { recursive: true })
}
