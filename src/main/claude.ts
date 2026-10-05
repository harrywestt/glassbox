import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'

/**
 * The Claude Code program bundled with the SDK. In the installed app the code sits in one archive
 * (app.asar), which can't run programs, so the program is kept beside it in app.asar.unpacked.
 */
export function claudeExecutable(): string | undefined {
  const file = join(app.getAppPath(), 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude').replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked')
  return existsSync(file) ? file : undefined
}

/** Every Claude run's abort switch, so quitting stops them all (a leftover claude.exe would block an update). */
const runs = new Set<AbortController>()

/** The SDK's query, pointed at the bundled program when the app is installed. Use this instead of the SDK's own. */
export const query: typeof sdkQuery = (params) => {
  const exe = app.isPackaged ? claudeExecutable() : undefined
  const abortController = params.options?.abortController ?? new AbortController()
  runs.add(abortController)
  abortController.signal.addEventListener('abort', () => runs.delete(abortController), { once: true })
  return sdkQuery({ ...params, options: { ...(exe ? { pathToClaudeCodeExecutable: exe } : {}), ...params.options, abortController } })
}

/** Stop every Claude run still going: the sessions' side runs, quick answers, map questions… */
export function abortAllQueries() {
  for (const c of [...runs]) c.abort()
}

/** A file shipped with the app, as a path other programs (Claude Code) can read: outside the app.asar archive. */
export const unpackedPath = (p: string) => p.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked')
