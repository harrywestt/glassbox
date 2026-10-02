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

/** The SDK's query, pointed at the bundled program when the app is installed. Use this instead of the SDK's own. */
export const query: typeof sdkQuery = (params) => {
  const exe = app.isPackaged ? claudeExecutable() : undefined
  return sdkQuery(exe ? { ...params, options: { pathToClaudeCodeExecutable: exe, ...params.options } } : params)
}
