import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { query } from './claude'
import { gitListFiles } from './git'
import type { Erd, ErdColumn, ErdEntity, ErdFocus, ErdRelation } from '../shared/erd'
import { tr } from '../shared/i18n'

/**
 * Reads a project's database schema from its code, no database connection needed:
 * - EF Core model snapshots (*ModelSnapshot.cs): entities, tables, columns, keys and relationships;
 * - Prisma schemas (schema.prisma);
 * - SQL migrations (CREATE TABLE … REFERENCES …).
 * Columns named after an entity in another module (FrameworkId) become inferred links, since
 * modular apps rarely declare foreign keys across their contexts.
 */

const MAX_FILES = 400
const MAX_BYTES = 4 * 1024 * 1024

const rootOf = (cwd: string) =>
  new Promise<string>((done) => execFile('git', ['rev-parse', '--show-toplevel'], { cwd, windowsHide: true, timeout: 5000 }, (err, out) => done((err ? cwd : out.trim() || cwd).replace(/\\/g, '/').replace(/\/+$/, ''))))

const short = (full: string) => full.split('.').pop() ?? full
/** api/modules/Controls/… → Controls. */
function groupOf(path: string): string {
  const segs = path.split('/')
  const i = segs.findIndex((s) => /^(modules|services|packages|apps|contexts|domains)$/i.test(s))
  if (i >= 0 && segs[i + 1]) return segs[i + 1]
  const infra = segs.find((s) => /\.(Infrastructure|Data|Persistence)$/i.test(s))
  if (infra) return infra.replace(/\.(Infrastructure|Data|Persistence)$/i, '')
  return segs.length > 1 ? segs[segs.length - 2] : 'Database'
}

// ── EF Core snapshots ──

function parseEf(path: string, text: string, entities: Map<string, ErdEntity>, relations: ErdRelation[]) {
  const group = groupOf(path)
  const defaultSchema = /HasDefaultSchema\("([^"]+)"\)/.exec(text)?.[1]
  const chunks = text.split('modelBuilder.Entity("').slice(1)
  for (const chunk of chunks) {
    const id = chunk.slice(0, chunk.indexOf('"'))
    // Only this entity's own statements (b.), not owned types' (b1.) or the next block.
    const body = chunk
    let e = entities.get(id)
    if (!e) entities.set(id, (e = { id, name: short(id), group, columns: [], schema: defaultSchema }))
    const table = /\bb\.ToTable\("([^"]+)"(?:\s*,\s*"([^"]+)")?/.exec(body)
    if (table) (e.table = table[1]), (e.schema = table[2] ?? e.schema)
    const keys = new Set([...(/\bb\.HasKey\(([^)]*)\)/.exec(body)?.[1] ?? '').matchAll(/"(\w+)"/g)].map((m) => m[1]))
    for (const m of body.matchAll(/\bb\.(?:Property|PrimitiveCollection)<([^(]+?)>\("(\w+)"\)([^;]*);/g)) {
      if (e.columns.some((c) => c.name === m[2])) continue
      const chain = m[3]
      const type = /HasColumnType\("([^"]+)"\)/.exec(chain)?.[1] ?? m[1].replace(/\?$/, '')
      e.columns.push({ name: m[2], type, required: /IsRequired\(\)/.test(chain) || !/\?$/.test(m[1].trim()) && !/string|\[\]/.test(m[1]), key: keys.has(m[2]) || undefined })
    }
    for (const m of body.matchAll(/\bb\.HasOne\("([^"]+)"\s*,\s*(?:"(\w*)"|null)\)([^;]*);/g)) {
      const chain = m[3]
      const fk = /HasForeignKey\((?:"[^"]*"\s*,\s*)?"(\w+)"/.exec(chain)?.[1]
      relations.push({ from: id, to: m[1], column: fk, nav: m[2] || undefined, many: /WithMany\(/.test(chain), required: /IsRequired\(\)/.test(chain) })
    }
  }
}

// ── Prisma ──

function parsePrisma(path: string, text: string, entities: Map<string, ErdEntity>, relations: ErdRelation[]) {
  const group = groupOf(path)
  for (const m of text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const id = m[1]
    const e: ErdEntity = { id, name: id, group, columns: [], table: /@@map\("([^"]+)"\)/.exec(m[2])?.[1] }
    for (const line of m[2].split('\n')) {
      const f = /^\s*(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/.exec(line)
      if (!f || f[1].startsWith('@@')) continue
      const rel = /@relation\([^)]*fields:\s*\[([^\]]+)\]/.exec(f[5])
      if (rel) {
        relations.push({ from: id, to: f[2], column: rel[1].split(',')[0].trim(), nav: f[1], many: true, required: !f[4] })
        continue
      }
      if (f[3] || /^[A-Z]/.test(f[2]) && !/^(String|Int|BigInt|Float|Decimal|Boolean|DateTime|Json|Bytes)$/.test(f[2])) continue
      e.columns.push({ name: f[1], type: f[2], required: !f[4], key: /@id\b/.test(f[5]) || undefined })
    }
    entities.set(id, e)
  }
}

// ── SQL migrations ──

function parseSql(path: string, text: string, entities: Map<string, ErdEntity>, relations: ErdRelation[]) {
  const group = groupOf(path)
  const clean = (n: string) => n.replace(/["`[\]]/g, '')
  for (const m of text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."`[\]]+)\s*\(([\s\S]*?)\)\s*;/gi)) {
    const full = clean(m[1])
    const [schema, table] = full.includes('.') ? full.split('.') : [undefined, full]
    const id = full
    const e: ErdEntity = { id, name: table, table, schema, group, columns: [] }
    for (const raw of m[2].split(/,(?![^(]*\))/)) {
      const line = raw.trim()
      const fk = /foreign\s+key\s*\(([^)]+)\)\s*references\s+([\w."`[\]]+)/i.exec(line)
      if (fk) {
        relations.push({ from: id, to: clean(fk[2]), column: clean(fk[1]), many: true })
        continue
      }
      if (/^(primary|unique|constraint|check|key|index)\b/i.test(line)) continue
      const col = /^([\w"`[\]]+)\s+([\w]+(?:\s*\([^)]*\))?)(.*)$/.exec(line)
      if (!col) continue
      const ref = /references\s+([\w."`[\]]+)/i.exec(col[3])
      if (ref) relations.push({ from: id, to: clean(ref[1]), column: clean(col[1]), many: true, required: /not\s+null/i.test(col[3]) })
      e.columns.push({ name: clean(col[1]), type: col[2], required: /not\s+null|primary\s+key/i.test(col[3]), key: /primary\s+key/i.test(col[3]) || undefined, fk: !!ref || undefined })
    }
    entities.set(id, e)
  }
}

// ── Assembly ──

const cache = new Map<string, { sig: string; erd: Erd }>()

export async function getErd(cwd: string): Promise<Erd> {
  const root = await rootOf(cwd)
  try {
    const files = ((await gitListFiles(root)) ?? []).map((f) => f.replace(/\\/g, '/'))
    const ef = files.filter((f) => /ModelSnapshot\.cs$/.test(f))
    const prisma = ef.length ? [] : files.filter((f) => /\.prisma$/.test(f))
    const sql = ef.length || prisma.length ? [] : files.filter((f) => /(^|\/)(migrations?|schema|db|database|sql)\/.*\.sql$/i.test(f) && !/seed|fixture|test/i.test(f))
    const sources = [...ef, ...prisma, ...sql].slice(0, MAX_FILES)
    if (!sources.length) return { root, source: 'none', entities: [], relations: [] }
    const stats = await Promise.all(sources.map((f) => stat(`${root}/${f}`).then((s) => `${f}:${s.mtimeMs}`, () => f)))
    const sig = stats.join('|')
    const hit = cache.get(root.toLowerCase())
    if (hit && hit.sig === sig) return hit.erd

    const entities = new Map<string, ErdEntity>()
    const relations: ErdRelation[] = []
    let bytes = 0
    for (const f of sources) {
      if (bytes > MAX_BYTES) break
      const text = await readFile(`${root}/${f}`, 'utf8').catch(() => '')
      bytes += text.length
      if (f.endsWith('.cs')) parseEf(f, text, entities, relations)
      else if (f.endsWith('.prisma')) parsePrisma(f, text, entities, relations)
      else parseSql(f, text, entities, relations)
    }
    // Relationships to entities that aren't mapped (an owned or shared type): dropped.
    const known = (id: string) => entities.has(id)
    const declared = relations.filter((r) => known(r.from) && known(r.to))
    const seen = new Set<string>()
    const unique = declared.filter((r) => {
      const k = `${r.from}>${r.to}>${r.column ?? ''}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    for (const r of unique) {
      const col = entities.get(r.from)!.columns.find((c) => c.name === r.column)
      if (col) col.fk = true
    }
    // Links across modules that aren't declared: a FrameworkId column where exactly one entity is called Framework.
    const byName = new Map<string, ErdEntity[]>()
    for (const e of entities.values()) byName.set(e.name.toLowerCase(), [...(byName.get(e.name.toLowerCase()) ?? []), e])
    for (const e of entities.values()) {
      for (const c of e.columns) {
        const m = /^(\w+?)Id$/.exec(c.name)
        if (!m || c.fk || c.key) continue
        const targets = (byName.get(m[1].toLowerCase()) ?? []).filter((t) => t.id !== e.id)
        if (targets.length !== 1) continue
        c.fk = true
        unique.push({ from: e.id, to: targets[0].id, column: c.name, many: true, inferred: true })
      }
    }
    // The file each entity class lives in (EF Core): Controls.Domain.Entities.Control → …/Controls.Domain/…/Control.cs.
    const csByName = new Map<string, string[]>()
    for (const f of files) if (f.endsWith('.cs')) csByName.set(f.slice(f.lastIndexOf('/') + 1).toLowerCase(), [...(csByName.get(f.slice(f.lastIndexOf('/') + 1).toLowerCase()) ?? []), f])
    for (const e of entities.values()) {
      if (!ef.length) continue
      const cands = csByName.get(`${e.name.toLowerCase()}.cs`) ?? []
      const ns = e.id.split('.').slice(0, 2).join('.').toLowerCase()
      e.file = cands.find((f) => f.toLowerCase().includes(ns)) ?? (cands.length === 1 ? cands[0] : undefined)
    }
    const erd: Erd = { root, source: ef.length ? 'ef' : prisma.length ? 'prisma' : 'sql', entities: [...entities.values()], relations: unique }
    cache.set(root.toLowerCase(), { sig, erd })
    return erd
  } catch (err) {
    return { root, source: 'none', entities: [], relations: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Which entities an area of the database covers ("controls v2", "how risks get owners"): Claude
 * reads the code (read-only) to see which tables that feature uses, and picks them from the list.
 */
export async function focusErd(cwd: string, question: string): Promise<ErdFocus> {
  const erd = await getErd(cwd)
  if (!erd.entities.length) return { entities: [], error: tr('mainErd.noSchema') }
  const list = erd.entities.map((e) => `${e.id}${e.table ? ` (table ${e.schema ? `${e.schema}.` : ''}${e.table})` : ''} [${e.group}]`).join('\n')
  const prompt = `The user is looking at the database of the project in ${erd.root} and wants to see: "${question}".

These are all the entities (id, table, module):
${list}

Work out which entities that area uses. If the words name a feature, screen or API rather than a table (for example a UI folder such as controls-v2), search the code (read-only) to see which API calls and entities it uses. Keep it focused: the entities that area reads or writes, usually 3 to 25.

Reply with JSON only: {"entities": ["<entity id exactly as listed>", ...], "why": "<one plain sentence saying what you included and why>"}`
  let out = ''
  try {
    for await (const msg of query({
      prompt,
      options: { model: 'sonnet', cwd: erd.root, tools: ['Grep', 'Glob', 'Read'], allowedTools: ['Grep', 'Glob', 'Read'], permissionMode: 'default', settingSources: [], persistSession: false, maxTurns: 12, systemPrompt: 'You map questions about a codebase onto its database entities. Only read files; never change anything. Reply with JSON only.', env: { ...process.env, HOME: process.env.HOME ?? homedir() } }
    }) as AsyncIterable<SDKMessage>) {
      if (msg.type === 'result' && msg.subtype === 'success') out = msg.result
    }
  } catch (err) {
    return { entities: [], error: err instanceof Error ? err.message : String(err) }
  }
  try {
    const body = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)
    const parsed = JSON.parse(body) as { entities?: unknown; why?: unknown }
    const ids = new Set(erd.entities.map((e) => e.id))
    const picked = (Array.isArray(parsed.entities) ? parsed.entities : []).filter((x): x is string => typeof x === 'string' && ids.has(x))
    return { entities: picked, why: typeof parsed.why === 'string' ? parsed.why : undefined, ...(picked.length ? {} : { error: tr('mainErd.noMatch') }) }
  } catch {
    return { entities: [], error: tr('mainErd.unreadable') }
  }
}
