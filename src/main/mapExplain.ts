import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ArchLink, Architecture } from '../shared/architecture'
import type { ModuleExplain } from '../shared/events'
import { getArchitecture } from './architecture'

/**
 * Why each of a module's connections exists, in one sentence each, written by Haiku from the code on
 * both sides (the lines that use the imported names, and where those names are defined). Runs in
 * the background; saved per module until a file on either side changes.
 */

const MAX_GROUPS = 12
const SNIPPET_LINES = 6
const running = new Map<string, Promise<ModuleExplain>>()

type Group = { id: string; other: string; links: ArchLink[] }

const dataDir = async () => join((await import('electron')).app.getPath('userData'), 'map-explain')
const fileFor = async (root: string) => join(await dataDir(), createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16) + '.json')

type Store = Record<string, { signature: string; why: Record<string, string> }>
async function loadStore(root: string): Promise<Store> {
  try {
    return JSON.parse(await readFile(await fileFor(root), 'utf8')) as Store
  } catch {
    return {}
  }
}

/** The module's connections, both ways, busiest first: "out:<module>" it uses, "in:<module>" that use it. */
export function groupsOf(arch: Architecture, id: string): Group[] {
  const by = new Map<string, Group>()
  for (const l of arch.links ?? []) {
    const dir = l.fromModule === id ? 'out' : l.toModule === id ? 'in' : null
    if (!dir) continue
    const other = dir === 'out' ? l.toModule : l.fromModule
    const key = `${dir}:${other}`
    let g = by.get(key)
    if (!g) by.set(key, (g = { id: key, other, links: [] }))
    g.links.push(l)
  }
  return [...by.values()].sort((a, b) => b.links.length - a.links.length).slice(0, MAX_GROUPS)
}

const read = async (root: string, rel: string) => {
  try {
    return (await readFile(`${root}/${rel}`, 'utf8')).slice(0, 64 * 1024)
  } catch {
    return ''
  }
}

/** The lines in `text` that mention any of `names` (or its first lines when there are no names). */
function linesFor(text: string, names: string[], defining: boolean): string[] {
  const lines = text.split(/\r?\n/)
  const plain = names.map((n) => n.replace(/^\* as /, '')).filter(Boolean)
  if (!plain.length) return lines.filter((l) => l.trim()).slice(0, 3).map((l) => l.trim().slice(0, 160))
  const word = new RegExp(`\\b(${plain.map((n) => n.replace(/[$]/g, '\\$')).join('|')})\\b`)
  const def = /\b(export|function|class|def|const|let|var|interface|type|func|public|async)\b/
  return lines
    .filter((l) => word.test(l) && (!defining || def.test(l)) && !/^\s*(import|from)\b|require\(/.test(l))
    .slice(0, SNIPPET_LINES)
    .map((l) => l.trim().slice(0, 160))
}

async function signatureOf(root: string, groups: Group[]): Promise<string> {
  const files = [...new Set(groups.flatMap((g) => g.links.flatMap((l) => [l.from, l.to]).filter(Boolean)))].sort()
  const stamps = await Promise.all(files.map(async (f) => `${f}:${(await stat(`${root}/${f}`).catch(() => null))?.mtimeMs ?? 0}`))
  return createHash('sha1').update(JSON.stringify([groups.map((g) => g.id), stamps])).digest('hex')
}

async function ask(arch: Architecture, id: string, groups: Group[]): Promise<Record<string, string>> {
  const name = (m: string) => arch.modules.find((x) => x.id === m)?.name ?? m
  const me = arch.modules.find((m) => m.id === id)
  const items = await Promise.all(
    groups.map(async (g) => {
      const sample = g.links.slice(0, 3)
      return {
        id: g.id,
        direction: g.id.startsWith('out:') ? `${name(id)} uses ${name(g.other)}` : `${name(g.other)} uses ${name(id)}`,
        imports: await Promise.all(
          sample.map(async (l) => ({
            file: l.from,
            via: l.http ? 'HTTP call to this route' : 'import',
            from: l.to || name(l.toModule),
            names: l.names,
            usedLike: linesFor(await read(arch.root, l.from), l.names, false),
            definedLike: l.to && !l.to.endsWith('/') ? linesFor(await read(arch.root, l.to), l.names, true) : []
          }))
        )
      }
    })
  )
  const prompt = `You're explaining a codebase's structure to the developer who owns it. Module "${me?.name}" (${me?.path || 'project root'}) connects to other modules as below. For each connection, write one sentence (at most 25 words) saying what one side uses the other for and why, in plain words, based only on the code shown. Name the functions or types when it helps. No filler like "This connection".\n\nReply with only JSON: {"<id>": "<sentence>", ...}\n\n${JSON.stringify(items)}`
  let out = ''
  for await (const msg of query({
    prompt,
    options: { model: 'haiku', tools: [], settingSources: [], persistSession: false, maxTurns: 1, thinking: { type: 'disabled' }, systemPrompt: 'You explain how parts of a codebase connect. Reply with JSON only.', cwd: arch.root }
  }) as AsyncIterable<SDKMessage>) {
    if (msg.type === 'result' && msg.subtype === 'success') out = msg.result
  }
  try {
    const parsed = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as Record<string, unknown>
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string')) as Record<string, string>
  } catch {
    return {}
  }
}

export function explainModule(cwd: string, id: string): Promise<ModuleExplain> {
  const key = `${cwd.toLowerCase()}\u0000${id}`
  const inflight = running.get(key)
  if (inflight) return inflight
  const p = (async (): Promise<ModuleExplain> => {
    try {
      const arch = await getArchitecture(cwd)
      const groups = groupsOf(arch, id)
      if (!groups.length) return { why: {} }
      const signature = await signatureOf(arch.root, groups)
      const store = await loadStore(arch.root)
      const hit = store[id]
      if (hit && hit.signature === signature) return { why: hit.why }
      const why = await ask(arch, id, groups)
      if (Object.keys(why).length) {
        try {
          const fresh = await loadStore(arch.root)
          fresh[id] = { signature, why }
          await mkdir(await dataDir(), { recursive: true })
          await writeFile(await fileFor(arch.root), JSON.stringify(fresh))
        } catch {
          /* not saved (e.g. outside the app); still returned */
        }
      }
      return { why }
    } catch (e) {
      return { why: {}, error: e instanceof Error ? e.message : String(e) }
    } finally {
      running.delete(key)
    }
  })()
  running.set(key, p)
  return p
}
