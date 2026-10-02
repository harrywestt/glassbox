import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { query } from './claude'
import type { Architecture } from '../shared/architecture'

/**
 * The map's categories, named by Claude for this project. The first time a project is mapped (and
 * again whenever its set of modules changes) a small one-shot Haiku call groups the detected modules
 * into categories that describe what they do here. Stored in Glassbox's own data, never in the repo.
 */

type Layout = { signature: string; layers: { name: string; modules: string[] }[] }

const running = new Map<string, Promise<void>>()
// Electron is loaded lazily so the map engine also runs (without Claude's names) outside the app.
const dir = async () => join((await import('electron')).app.getPath('userData'), 'map-layouts')
const fileFor = async (root: string) => join(await dir(), createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16) + '.json')
// v2: names only (groups come from the code); layouts saved by the regrouping version are redone.
const signatureOf = (arch: Architecture) => 'v2|' + arch.modules.map((m) => `${m.id}@${m.layer}`).sort().join('|')

async function load(root: string): Promise<Layout | null> {
  try {
    return JSON.parse(await readFile(await fileFor(root), 'utf8')) as Layout
  } catch {
    return null
  }
}

/**
 * Apply the stored layout when it still fits the detected modules. Otherwise start naming them in
 * the background (at most once at a time per project) and say so, so the UI refreshes when it's done.
 * `onDone` runs when a new layout has been saved.
 */
export async function organise(arch: Architecture, onDone: () => void): Promise<Architecture> {
  if (arch.source !== 'detected' || arch.modules.length < 3) return arch
  try {
    await dir()
  } catch {
    return arch // not running inside Electron
  }
  const sig = signatureOf(arch)
  const saved = await load(arch.root)
  if (saved && saved.signature === sig) return applyLayout(arch, saved)
  if (!running.has(arch.root)) {
    const job = nameCategories(arch, sig)
      .then(async (layout) => {
        if (!layout) return
        await mkdir(await dir(), { recursive: true })
        await writeFile(await fileFor(arch.root), JSON.stringify(layout, null, 2))
        onDone()
      })
      .catch(() => {})
      .finally(() => running.delete(arch.root))
    running.set(arch.root, job)
  }
  // Until Claude's names arrive, keep the categories a stored layout gave last time where they still apply.
  return { ...(saved ? applyLayout(arch, saved) : arch), organising: true }
}

function applyLayout(arch: Architecture, layout: Layout): Architecture {
  const layerOf = new Map<string, string>()
  for (const l of layout.layers) for (const id of l.modules) layerOf.set(id, l.name)
  const modules = arch.modules.map((m) => ({ ...m, layer: layerOf.get(m.id) ?? m.layer }))
  const layers: string[] = []
  for (const l of layout.layers) if (modules.some((m) => m.layer === l.name) && !layers.includes(l.name)) layers.push(l.name)
  for (const m of modules) if (!layers.includes(m.layer)) layers.push(m.layer)
  return { ...arch, modules, layers }
}

/**
 * Claude names the map's categories, and only names them: which modules belong together comes
 * from the code's own folders (the engine's groups), because a model regrouping a hundred modules
 * invents buckets ("Infrastructure") that don't match the code.
 */
export async function nameCategories(arch: Architecture, signature: string): Promise<Layout | null> {
  const groups = arch.layers
    .map((layer) => ({ layer, mods: arch.modules.filter((m) => m.layer === layer) }))
    .filter((g) => g.mods.length && g.layer !== 'External' && g.layer !== 'Other')
  if (groups.length < 2) return null
  const list = groups
    .map((g, i) => `${i}. "${g.layer}": ${g.mods.slice(0, 10).map((m) => `${m.name} (${m.path})`).join('; ')}${g.mods.length > 10 ? `; and ${g.mods.length - 10} more` : ''}`)
    .join('\n')
  const prompt = `These are the parts of a software project, grouped by the folders they live in. Give each group a short name (1 to 4 words, title case) that says what it is in THIS project, the way its developers would say it: e.g. "Web App Features", "API Modules", "Shared Platform", "Email Templates". Keep each group exactly as it is: don't merge, split or move anything. If the current name is already clear, keep it.

${list}

Reply with only JSON: {"<number>": "<name>", ...}`
  let text = ''
  for await (const msg of query({ prompt, options: { cwd: arch.root, model: 'haiku', tools: [], settingSources: [], persistSession: false, maxTurns: 1, thinking: { type: 'disabled' } } })) {
    if (msg.type === 'result' && msg.subtype === 'success') text = msg.result
  }
  const raw = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? 'null') as Record<string, unknown> | null
  if (!raw) return null
  const taken = new Set<string>()
  const layers = groups.map((g, i) => {
    let n = String(raw[String(i)] ?? '').trim().slice(0, 32)
    if (!n || taken.has(n)) n = g.layer
    taken.add(n)
    return { name: n, modules: g.mods.map((m) => m.id) }
  })
  return { signature, layers }
}
