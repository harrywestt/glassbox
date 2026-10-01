import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { gitListFiles } from './git'

// Big enough for large generated files (20k+ lines); beyond this Monaco itself struggles.
const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_FILES = 20000
const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'out', 'dist', 'build', '.next', '.venv', '__pycache__', '.terraform'])

/** Project file list relative to cwd, forward slashes. Uses git (respecting .gitignore) when available. */
export async function listProjectFiles(cwd: string): Promise<string[]> {
  const fromGit = await gitListFiles(cwd)
  if (fromGit) return fromGit.slice(0, MAX_FILES)
  const files: string[] = []
  const walk = async (dir: string) => {
    if (files.length >= MAX_FILES) return
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name))
      } else {
        files.push(relative(cwd, join(dir, entry.name)).split('\\').join('/'))
      }
    }
  }
  await walk(cwd)
  return files
}

export async function readProjectFile(cwd: string, path: string) {
  const full = isAbsolute(path) ? path : resolve(cwd, path)
  const info = await stat(full)
  if (info.size > MAX_FILE_BYTES) return { path: full, error: `File is ${info.size.toLocaleString()} bytes; too large to preview.` }
  return { path: full, content: await readFile(full, 'utf8') }
}
