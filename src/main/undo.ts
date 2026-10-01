import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

type EditInput = { file_path?: string; old_string?: string; new_string?: string; replace_all?: boolean; edits?: { old_string: string; new_string: string; replace_all?: boolean }[]; content?: string }

const count = (hay: string, needle: string) => (needle ? hay.split(needle).length - 1 : 0)

/**
 * Reverses one of Claude's edits in the file as it is now: puts old_string back where new_string
 * is. Refuses (rather than guessing) when the edited text can't be found exactly, e.g. because the
 * file has changed since. A Write can only be undone when it created the file (it's deleted).
 */
export function undoEdit(cwd: string, tool: string, input: EditInput, createdFile: boolean): { deleted?: boolean } {
  const path = resolve(cwd, String(input.file_path ?? ''))
  const rel = relative(resolve(cwd), path)
  if (!input.file_path || rel.startsWith('..') || isAbsolute(rel)) throw new Error('That file is outside the project, so Glassbox won’t change it.')
  if (!existsSync(path)) throw new Error('The file no longer exists.')

  if (tool === 'Write') {
    if (!createdFile) throw new Error('This edit rewrote an existing file, so there’s nothing safe to restore it to. Ask Claude to put it back instead.')
    rmSync(path)
    return { deleted: true }
  }

  const steps = tool === 'MultiEdit' && Array.isArray(input.edits) ? [...input.edits].reverse() : [{ old_string: input.old_string ?? '', new_string: input.new_string ?? '', replace_all: input.replace_all }]
  let text = readFileSync(path, 'utf8')
  for (const e of steps) {
    const n = count(text, e.new_string)
    if (n === 0) throw new Error('The edited text isn’t in the file any more (it has changed since), so it can’t be undone automatically.')
    if (n > 1 && !e.replace_all) throw new Error('The edited text now appears more than once in the file, so Glassbox can’t tell which one to undo.')
    text = e.replace_all ? text.split(e.new_string).join(e.old_string) : text.replace(e.new_string, () => e.old_string)
  }
  writeFileSync(path, text)
  return {}
}
