import { execFileSync } from 'node:child_process'

/**
 * An app opened from the Finder or the Dock gets launchd's bare PATH (/usr/bin:/bin:…), not your
 * shell's, so git, gh, node and anything from Homebrew would be "not found". Ask your login shell
 * for its PATH once at startup and use that. Windows apps already inherit the user's PATH.
 */
export function adoptLoginShellPath() {
  if (process.platform === 'win32') return
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  try {
    const out = execFileSync(shell, ['-ilc', 'printf "__GB_PATH__%s__GB_PATH__" "$PATH"'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
    const found = /__GB_PATH__(.*?)__GB_PATH__/s.exec(out)?.[1]?.trim()
    if (!found) return
    // The shell's entries first, then anything we already had that it doesn't list.
    const merged = [...found.split(':'), ...(process.env.PATH ?? '').split(':')].filter((p, i, all) => p && all.indexOf(p) === i)
    process.env.PATH = merged.join(':')
  } catch {
    /* keep the PATH we were started with */
  }
  // Common install places, in case the shell didn't mention them (Apple Silicon and Intel Homebrew).
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) if (!(process.env.PATH ?? '').split(':').includes(dir)) process.env.PATH = `${process.env.PATH}:${dir}`
}
