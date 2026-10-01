import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectDecision } from '../shared/events'

/**
 * Decisions and assumptions Claude logged in a project, kept across sessions so a new session
 * starts from what's already been settled instead of arguing it again. Stored per repo (the git
 * root, so worktrees and subfolders share them) in Glassbox's data folder.
 */

const MAX = 200
/** How many of the latest go into a new session's instructions. */
const IN_PROMPT = 30

const rootOf = (cwd: string) =>
  new Promise<string>((done) =>
    execFile('git', ['rev-parse', '--show-toplevel'], { cwd, windowsHide: true, timeout: 5000 }, (err, out) => done((err ? cwd : out.trim() || cwd).replace(/\\/g, '/').replace(/\/+$/, '')))
  )

const fileFor = async (cwd: string) =>
  join((await import('electron')).app.getPath('userData'), 'decisions', createHash('sha1').update((await rootOf(cwd)).toLowerCase()).digest('hex').slice(0, 16) + '.json')

export async function listDecisions(cwd: string): Promise<ProjectDecision[]> {
  try {
    const list = JSON.parse(await readFile(await fileFor(cwd), 'utf8')) as ProjectDecision[]
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

// One write at a time per project, so decisions logged in quick succession all land.
let chain: Promise<unknown> = Promise.resolve()
function update(cwd: string, fn: (list: ProjectDecision[]) => ProjectDecision[]): Promise<ProjectDecision[]> {
  const next = chain.then(async () => {
    const file = await fileFor(cwd)
    const list = fn(await listDecisions(cwd)).slice(-MAX)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, JSON.stringify(list, null, 1))
    return list
  })
  chain = next.catch(() => {})
  return next
}

export function recordDecision(cwd: string, d: Omit<ProjectDecision, 'id' | 'at'>): Promise<ProjectDecision[]> {
  // The same title logged again (a later session restating it) replaces the older entry.
  return update(cwd, (list) => [...list.filter((x) => x.title.trim().toLowerCase() !== d.title.trim().toLowerCase()), { ...d, id: randomUUID(), at: Date.now() }])
}

export function forgetDecision(cwd: string, id: string): Promise<ProjectDecision[]> {
  return update(cwd, (list) => list.filter((x) => x.id !== id))
}

/** The instructions a new session gets: what earlier sessions settled, newest last. */
export async function decisionsBrief(cwd: string, exceptSession?: string): Promise<string> {
  const list = (await listDecisions(cwd)).filter((d) => !exceptSession || d.sid !== exceptSession).slice(-IN_PROMPT)
  if (!list.length) return ''
  const day = (at: number) => new Date(at).toISOString().slice(0, 10)
  const lines = list.map((d) => `- ${day(d.at)} ${d.kind === 'assumption' ? '(assumed) ' : ''}${d.title}${d.detail ? `: ${d.detail}` : ''}${d.files?.length ? ` [${d.files.slice(0, 4).join(', ')}]` : ''}`)
  return `\n\nDecisions already made in this project in earlier sessions (the user has seen these; build on them rather than re-deciding). If your work needs to go against one, call check_in first and say which:\n${lines.join('\n')}`
}
