import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { query } from './claude'

/**
 * "This conversation" on the map, grouped by Claude rather than by folder. Given the session's
 * heatmap (what it read, edited and searched in each module) and the modules connected to them, a
 * small one-shot call decides what an engineer following this work needs to see, groups it the way
 * they'd think about it, and leaves out noise (generated code, build output, fixtures, vendored code)
 * unless the work actually changed it. Cached per activity signature, so the same heat isn't regrouped.
 */

export type HeatModule = { id: string; name: string; path: string; files: number; reads: number; edits: number; searches: number; top: string[]; context?: boolean }
export type MapGroups = { groups: { name: string; why?: string; modules: string[] }[]; hidden: string[]; at: number; error?: string }

const dir = async () => join((await import('electron')).app.getPath('userData'), 'map-groups')
const keyOf = (root: string, mods: HeatModule[]) =>
  createHash('sha1')
    .update(root.toLowerCase() + '|' + mods.map((m) => `${m.id}:${m.reads}:${m.edits}:${m.searches}:${m.context ? 1 : 0}`).sort().join('|'))
    .digest('hex')
    .slice(0, 20)
const running = new Map<string, Promise<MapGroups>>()

export async function groupSessionMap(root: string, mods: HeatModule[], force = false): Promise<MapGroups> {
  if (!mods.length) return { groups: [], hidden: [], at: Date.now() }
  const key = keyOf(root, mods)
  const file = join(await dir(), key + '.json')
  if (!force) {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as MapGroups
    } catch {
      /* not grouped yet */
    }
  }
  const inflight = running.get(key)
  if (inflight) return inflight
  const job = (async (): Promise<MapGroups> => {
    const ids = new Set(mods.map((m) => m.id))
    const list = mods
      .map((m) => `- ${m.id} | ${m.name} | ${m.path || '(root)'} | ${m.files} files | ${m.context ? 'connected, not touched' : `read ${m.reads}, edited ${m.edits}, searched ${m.searches}`}${m.top.length ? ` | ${m.top.join(', ')}` : ''}`)
      .join('\n')
    const prompt = `An engineer is watching an AI coding session in this project and wants a map of the parts of the code the session is about. Below are the code modules it touched (with how much it read, edited and searched in each, and the busiest files), plus some connected modules it didn't touch.

Group them the way that engineer would want to see this piece of work: by what the code does for the task (for example "Pricing rules", "Order API", "Database schema", "Checkout UI"), not by folder. Put the modules that were edited first, in the groups that matter most.

Leave out (list in "hidden") anything that's noise for understanding the work: generated code (API clients, *.g.cs, protobuf output, "generated" folders), build output, vendored or third-party code, lockfiles, test fixtures and snapshots, and modules that were only glanced at once and don't connect to the work. Never hide a module that was edited.

Rules: 2 to 6 groups; each group 1 to 8 modules; every module id appears at most once; group names are 1 to 4 words, plain English, title case; "why" is under 12 words, saying what that group is to this work.

Modules (id | name | path | size | activity | busiest files):
${list}

Reply with only JSON: {"groups":[{"name":"...","why":"...","modules":["<id>",...]}],"hidden":["<id>",...]}`
    let text = ''
    try {
      for await (const msg of query({ prompt, options: { cwd: root, model: 'haiku', tools: [], settingSources: [], persistSession: false, maxTurns: 1, thinking: { type: 'disabled' } } })) {
        if (msg.type === 'result' && msg.subtype === 'success') text = msg.result
      }
      const raw = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? 'null') as { groups?: { name?: string; why?: string; modules?: string[] }[]; hidden?: string[] } | null
      if (!raw?.groups?.length) throw new Error('no groups in the reply')
      const used = new Set<string>()
      const edited = new Set(mods.filter((m) => m.edits > 0).map((m) => m.id))
      const groups = raw.groups
        .map((g) => ({
          name: String(g.name ?? '').trim().slice(0, 40) || 'Other',
          why: g.why ? String(g.why).trim().slice(0, 90) : undefined,
          modules: (g.modules ?? []).filter((id) => ids.has(id) && !used.has(id) && (used.add(id), true))
        }))
        .filter((g) => g.modules.length)
      const hidden = (raw.hidden ?? []).filter((id) => ids.has(id) && !used.has(id) && !edited.has(id))
      // Anything it forgot (and every edited module) still shows, in a group of its own.
      const missing = mods.filter((m) => !used.has(m.id) && !hidden.includes(m.id)).map((m) => m.id)
      if (missing.length) groups.push({ name: 'Also touched', why: undefined, modules: missing })
      const result: MapGroups = { groups, hidden, at: Date.now() }
      await mkdir(await dir(), { recursive: true })
      await writeFile(file, JSON.stringify(result))
      return result
    } catch (err) {
      return { groups: [], hidden: [], at: Date.now(), error: String(err instanceof Error ? err.message : err) }
    } finally {
      running.delete(key)
    }
  })()
  running.set(key, job)
  return job
}
