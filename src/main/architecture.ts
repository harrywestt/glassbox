import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, posix } from 'node:path'
import { gitListFiles } from './git'
import { listProjectFiles } from './files'
import { organise } from './mapLayout'
import { clientCalls, matchCalls, serverRoutes, type ClientCall, type ServerRoute } from './httpRoutes'
import { ARCH_VERSION, LAYER_ORDER, moduleOf, type ArchEdge, type ArchLink, type ArchLayer, type ArchModule, type ArchRole, type Architecture } from '../shared/architecture'

/**
 * The architecture engine behind the architect map: turns a project folder into modules
 * (folders that hang together) grouped into layers, plus a module-level import graph.
 * Heuristic and dependency-free; .glassbox/architecture.json overrides the module list.
 */

// Big monorepos (naq-app has ~13k source files) must fit whole: a cut taken alphabetically would
// drop everything after api/ (the whole UI). Import scanning is time-boxed separately.
const MAX_FILES = 60000
const MAX_READ_BYTES = 200 * 1024
const SCAN_BUDGET_MS = 8000
const MAX_LINKS = 20000
const CONCURRENCY = 16
// The whole-project map is fine-grained; the Map tab shows the part of it a conversation works in.
const MAX_MODULES = 150
// A module bigger than this (in source files) is split into its subfolders when it has them.
const BIG_MODULE_FILES = 120
/** The inner layers of one feature in layered (clean/onion/hexagonal) code. */
const INNER_LAYERS = new Set(['api', 'domain', 'application', 'infrastructure', 'core', 'contracts', 'abstractions', 'tests', 'test', 'mcp', 'external', 'm2m', 'persistence', 'data', 'web', 'endpoints', 'models', 'services', 'handlers', 'integration', 'unit', 'shared'])
const PROJECT_FILE = /(^|\/)([^/]+\.(csproj|fsproj|vbproj)|package\.json|pyproject\.toml|setup\.py|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?)$/i
const MIN_MODULES = 8
const CONTAINER_NAMES = new Set(['api', 'web', 'lib', 'libs', 'server', 'client', 'frontend', 'backend', 'services', 'db', 'data', 'modules', 'features', 'packages', 'apps'])
const MAX_EXTERNALS = 3

const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'out', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', 'coverage', '.venv', 'venv', '__pycache__', '.terraform', 'target', 'vendor', '.turbo', '.cache'])
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'cypress', '__mocks__', 'fixtures', 'testing'])
/** Top-level folders that aren't application code when the repo root is the source root. */
const NON_CODE_TOP = new Set(['docs', 'doc', 'scripts', 'script', 'tools', 'examples', 'example', 'public', 'static', 'assets', 'resources', 'third_party', 'terraform', 'infra', 'deploy', 'config', 'benchmarks'])
const SOURCE_ROOTS = ['src', 'app', 'lib', 'server', 'client', 'web', 'api', 'frontend', 'backend']
const MONO_ROOTS = ['packages', 'apps', 'services', 'modules']
/** Folder names that say nothing about what's inside, skipped when naming a module. */
const GENERIC = new Set(['src', 'source', 'sources', 'lib', 'code', 'pkg', 'internal'])

const SOURCE_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'astro', 'py', 'go', 'java', 'kt', 'kts', 'scala', 'cs', 'fs', 'rs', 'rb', 'php', 'swift', 'm', 'mm', 'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'dart', 'ex', 'exs', 'lua'])
const JS_EXTS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte']
const RESOLVE_EXTS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']

const ACRONYMS = new Set(['ui', 'api', 'db', 'ipc', 'cli', 'sdk', 'http', 'sql', 'aws', 'etl', 'io', 'id', 'url', 'css', 'html', 'json', 'rpc', 'ml', 'ai', 'ux', 'jwt', 'orm', 'gql', 's3', 'ci', 'mcp'])

const LAYER_WORDS: [ArchRole, Set<string>][] = [
  ['Web', new Set(['web', 'ui', 'client', 'frontend', 'components', 'pages', 'views', 'renderer', 'screens', 'widgets', 'styles', 'layouts', 'hooks'])],
  ['API', new Set(['api', 'server', 'routes', 'handlers', 'controllers', 'endpoints', 'main', 'preload', 'ipc', 'graphql', 'rpc', 'lambdas', 'lambda', 'functions', 'cli', 'cmd', 'commands', 'worker', 'workers', 'jobs', 'backend'])],
  ['Data', new Set(['db', 'database', 'schema', 'migrations', 'models', 'prisma', 'entities', 'repositories', 'repository', 'store', 'stores', 'storage', 'data', 'persistence', 'dal'])],
  ['Domain', new Set(['lib', 'core', 'domain', 'services', 'utils', 'util', 'shared', 'common', 'helpers', 'packages', 'types'])]
]

type ExternalDef = {
  key: string
  name: string
  layer: ArchLayer
  npm?: (pkg: string) => boolean
  py?: (mod: string) => boolean
  nuget?: (pkg: string) => boolean
  cs?: (ns: string) => boolean
}

const EXTERNALS: ExternalDef[] = [
  { key: 'postgres', name: 'PostgreSQL', layer: 'Data', npm: (p) => ['pg', 'postgres', '@neondatabase/serverless', 'pg-promise'].includes(p), py: (m) => /^(psycopg2?|asyncpg)$/.test(m), nuget: (p) => /^Npgsql/i.test(p), cs: (n) => /^Npgsql\b/.test(n) },
  { key: 'mysql', name: 'MySQL', layer: 'Data', npm: (p) => p === 'mysql' || p === 'mysql2', py: (m) => /^(pymysql|MySQLdb|mysql)$/.test(m), nuget: (p) => /^(MySql\.|MySqlConnector)/i.test(p), cs: (n) => /^(MySql|MySqlConnector)\b/.test(n) },
  { key: 'mongodb', name: 'MongoDB', layer: 'Data', npm: (p) => p === 'mongodb' || p === 'mongoose', py: (m) => m === 'pymongo' || m === 'motor', nuget: (p) => /^MongoDB\./i.test(p), cs: (n) => /^MongoDB\b/.test(n) },
  { key: 'prisma', name: 'Prisma DB', layer: 'Data', npm: (p) => p === '@prisma/client' || p === 'prisma' },
  { key: 'sqlite', name: 'SQLite', layer: 'Data', npm: (p) => p === 'better-sqlite3' || p === 'sqlite3' || p === 'sqlite', py: (m) => m === 'sqlite3' },
  { key: 'redis', name: 'Redis', layer: 'Data', npm: (p) => p === 'redis' || p === 'ioredis', py: (m) => m === 'redis', nuget: (p) => /^StackExchange\.Redis/i.test(p), cs: (n) => /^StackExchange\.Redis\b/.test(n) },
  { key: 'dynamodb', name: 'DynamoDB', layer: 'Data', npm: (p) => /^@aws-sdk\/(client|lib)-dynamodb$/.test(p), nuget: (p) => /^AWSSDK\.DynamoDB/i.test(p), cs: (n) => /^Amazon\.DynamoDBv2\b/.test(n) },
  { key: 'aws', name: 'AWS', layer: 'Other', npm: (p) => (p.startsWith('@aws-sdk/') && !/dynamodb/.test(p)) || p === 'aws-sdk', py: (m) => m === 'boto3' || m === 'botocore', nuget: (p) => /^(AWSSDK\.|Amazon\.Lambda)/i.test(p) && !/DynamoDB/i.test(p), cs: (n) => /^Amazon\b/.test(n) && !/^Amazon\.DynamoDBv2\b/.test(n) },
  { key: 'stripe', name: 'Stripe', layer: 'Other', npm: (p) => p === 'stripe', py: (m) => m === 'stripe', nuget: (p) => /^Stripe/i.test(p), cs: (n) => /^Stripe\b/.test(n) },
  { key: 'anthropic', name: 'Claude API', layer: 'Other', npm: (p) => p.startsWith('@anthropic-ai/'), py: (m) => m === 'anthropic' || m === 'claude_agent_sdk', nuget: (p) => /^Anthropic/i.test(p), cs: (n) => /^Anthropic\b/.test(n) },
  { key: 'openai', name: 'OpenAI API', layer: 'Other', npm: (p) => p === 'openai', py: (m) => m === 'openai', nuget: (p) => /^OpenAI/i.test(p), cs: (n) => /^OpenAI\b/.test(n) },
  { key: 'auth0', name: 'Auth0', layer: 'Other', npm: (p) => p === 'auth0' || p.startsWith('@auth0/'), py: (m) => m === 'auth0', nuget: (p) => /^Auth0\./i.test(p), cs: (n) => /^Auth0\b/.test(n) },
  { key: 'electron', name: 'Electron', layer: 'Other', npm: (p) => p === 'electron' }
]

// ── Small helpers ──

const extOf = (p: string) => {
  const b = p.slice(p.lastIndexOf('/') + 1)
  const i = b.lastIndexOf('.')
  return i > 0 ? b.slice(i + 1).toLowerCase() : ''
}
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const stemOf = (p: string) => baseOf(p).replace(/\.[^.]+$/, '')
const under = (file: string, folder: string) => folder === '' || file === folder || file.startsWith(folder + '/')
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

function isTestFile(p: string): boolean {
  const b = baseOf(p)
  return /\.(test|spec)\.[^.]+$/i.test(b) || /^test_.*\.py$/i.test(b) || /_test\.(py|go)$/i.test(b)
}
function inTestDir(p: string): boolean {
  return p.split('/').slice(0, -1).some((s) => TEST_DIRS.has(s.toLowerCase()) || /[.\-_]tests?$/i.test(s))
}
function isSource(p: string): boolean {
  const ext = extOf(p)
  if (!SOURCE_EXTS.has(ext)) return false
  if (/\.d\.[mc]?ts$/i.test(p) || /\.min\.js$/i.test(p)) return false
  return true
}

function tokens(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s\-_.]+/)
    .filter(Boolean)
}

/** `session-ui` → `Session UI`, `Naq.Migration.ClinicalProjects` → `Clinical Projects`. */
function humanName(folder: string): string {
  let s = folder.replace(/\.[a-z0-9]+$/i, (m) => (SOURCE_EXTS.has(m.slice(1).toLowerCase()) ? '' : m))
  if (s.includes('.')) s = s.split('.').filter((seg) => !/^tests?$/i.test(seg)).pop() ?? s
  const words = tokens(s)
  if (!words.length) return folder
  return words.map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ')
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'module'
}

/** Normalised name for matching test folders/files to modules. */
function matchKey(s: string): string {
  return tokens(s.replace(/\.[^.]+$/, (m) => (SOURCE_EXTS.has(m.slice(1).toLowerCase()) ? '' : m)))
    .map((w) => w.toLowerCase())
    .filter((w) => !['test', 'tests', 'spec', 'specs', 'e2e'].includes(w))
    .join('')
}

function layerFor(path: string, name: string, frontend: boolean): ArchRole {
  const segs = path.split('/').filter(Boolean)
  if (segs.length) segs[segs.length - 1] = segs[segs.length - 1].replace(/\.[^.]+$/, '')
  // Deepest segment first: `server/models` is Data, `renderer/src/panels` is Web.
  const checks = [...segs.reverse(), name]
  for (const seg of checks) {
    const lower = seg.toLowerCase()
    const toks = tokens(seg).map((t) => t.toLowerCase())
    for (const [layer, words] of LAYER_WORDS) {
      if (words.has(lower) || toks.some((t) => words.has(t) && t !== 'main')) return layer
    }
    if (frontend && lower === 'app') return 'Web'
  }
  return 'Other'
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++])
    })
  )
}

async function readHead(abs: string): Promise<string> {
  const fh = await open(abs, 'r')
  try {
    const buf = Buffer.alloc(MAX_READ_BYTES)
    const { bytesRead } = await fh.read(buf, 0, MAX_READ_BYTES, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

async function readJson(abs: string): Promise<unknown> {
  try {
    return parseJsonc(await readFile(abs, 'utf8'))
  } catch {
    return null
  }
}

/** JSON with comments and trailing commas (tsconfig style). */
function parseJsonc(text: string): unknown {
  let out = ''
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inStr = false
    } else if (c === '"') {
      inStr = true
      out += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i < 0) break
      i++
    } else out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

function gitRoot(cwd: string): Promise<string | null> {
  return new Promise((done) => {
    execFile('git', ['rev-parse', '--show-toplevel'], { cwd, windowsHide: true, timeout: 5000 }, (err, stdout) => done(err ? null : stdout.trim() || null))
  })
}

// ── Folder tree of source files ──

type Node = { path: string; name: string; direct: string[]; children: Map<string, Node>; total: number }

function buildTree(files: string[]): Node {
  const root: Node = { path: '', name: '', direct: [], children: new Map(), total: 0 }
  for (const f of files) {
    const segs = f.split('/')
    let node = root
    node.total++
    for (let i = 0; i < segs.length - 1; i++) {
      let child = node.children.get(segs[i])
      if (!child) {
        child = { path: segs.slice(0, i + 1).join('/'), name: segs[i], direct: [], children: new Map(), total: 0 }
        node.children.set(segs[i], child)
      }
      node = child
      node.total++
    }
    node.direct.push(f)
  }
  return root
}

function findNode(root: Node, path: string): Node | undefined {
  let node: Node | undefined = root
  for (const seg of path.split('/').filter(Boolean)) node = node?.children.get(seg)
  return node
}

/** Walks down single-child folders with no files of their own (`cli/Foo.Cli` → the inner one). */
// Folders with their own project file (set per build): a module stops there rather than walking on
// into its only subfolder, so api/src/NaqApp.WebAPI stays "Web API", not "Web API/Things".
let projectStops = new Set<string>()

function collapse(node: Node): Node {
  while (node.direct.length === 0 && node.children.size === 1) {
    const only = [...node.children.values()][0]
    // Walk on into a source root (ui/src with folders inside) but not into a plain leaf folder,
    // nor from a feature into its only layer project (MigrationProvenance → MigrationProvenance.Infrastructure).
    if (projectStops.has(node.path) && only.children.size < 2) break
    if (node.name && only.name.toLowerCase().startsWith(node.name.toLowerCase() + '.')) break
    node = only
  }
  return node
}

function nodeName(node: Node, root: Node): string {
  const segs = node.path.split('/')
  // A nested lib/ or internal/ inside an app is its own thing ("Lib"); only src-like folders say nothing.
  const leaf = segs[segs.length - 1]?.toLowerCase() ?? ''
  if (segs.length > 1 && GENERIC.has(leaf) && !ROOTISH.has(leaf)) return humanName(segs[segs.length - 1])
  for (let i = segs.length - 1; i >= 0; i--) {
    if (GENERIC.has(segs[i].toLowerCase())) continue
    // MigrationProvenance/MigrationProvenance.Infrastructure is the Migration Provenance feature.
    const parent = segs[i - 1]
    if (parent && segs[i].toLowerCase().startsWith(parent.toLowerCase() + '.')) return humanName(parent)
    // NaqApp.Shared.Infrastructure: drop the solution prefix and keep the rest (Shared Infrastructure).
    const dotted = segs[i].split('.').filter(Boolean)
    if (dotted.length >= 3) return dotted.slice(1).map(humanName).join(' ')
    return humanName(segs[i])
  }
  const last = segs[segs.length - 1] ?? ''
  return humanName(last && last.toLowerCase() !== 'src' ? last : root.name || 'Project')
}

// ── Import parsing ──

type Resolver = {
  files: Set<string>
  lowerToReal: Map<string, string>
  /** `scope`: the folder whose files the alias applies to ('' or unset for the whole repo). */
  aliases: { prefix: string; targets: string[]; scope?: string }[]
  pyBases: string[]
  goModule?: string
  csProjects: { name: string; dir: string }[]
}

function resolveFile(r: Resolver, base: string): string | null {
  const norm = posix.normalize(base).replace(/^\.\//, '')
  if (norm.startsWith('..')) return null
  const tryOne = (p: string) => r.lowerToReal.get(p.toLowerCase()) ?? null
  const direct = extOf(norm) && tryOne(norm)
  if (direct) return direct
  const stripped = /\.(m|c)?js$/i.test(norm) ? norm.replace(/\.(m|c)?js$/i, '') : norm
  for (const e of RESOLVE_EXTS) {
    const hit = tryOne(`${stripped}.${e}`) ?? tryOne(`${norm}.${e}`)
    if (hit) return hit
  }
  for (const e of RESOLVE_EXTS) {
    const hit = tryOne(`${norm}/index.${e}`)
    if (hit) return hit
  }
  return null
}

function resolveJs(r: Resolver, from: string, spec: string): { file?: string; pkg?: string } {
  spec = spec.replace(/[?#].*$/, '')
  if (!spec || /^[a-z][a-z0-9+.-]*:/i.test(spec)) return {}
  if (spec.startsWith('.')) {
    const f = resolveFile(r, posix.join(dirOf(from), spec))
    return f ? { file: f } : {}
  }
  for (const a of r.aliases) {
    if (a.scope && !from.startsWith(a.scope + '/')) continue
    if (a.prefix.endsWith('*') ? spec.startsWith(a.prefix.slice(0, -1)) : spec === a.prefix) {
      const rest = a.prefix.endsWith('*') ? spec.slice(a.prefix.length - 1) : ''
      for (const t of a.targets) {
        const f = resolveFile(r, t.replace('*', rest))
        if (f) return { file: f }
      }
    }
  }
  if (spec.startsWith('/')) {
    const f = resolveFile(r, spec.slice(1))
    if (f) return { file: f }
  }
  const segs = spec.split('/')
  const pkg = spec.startsWith('@') ? segs.slice(0, 2).join('/') : segs[0]
  // `src/utils/x` style (baseUrl) without a declared alias.
  const f = segs.length > 1 ? resolveFile(r, spec) : null
  return f ? { file: f } : { pkg }
}

function resolvePy(r: Resolver, from: string, dots: string, mod: string, names: string[]): string | null {
  const parts = mod.split('.').filter(Boolean)
  const bases: string[] = []
  if (dots) {
    let d = dirOf(from)
    for (let i = 1; i < dots.length; i++) d = dirOf(d)
    bases.push(d)
  } else bases.push(...r.pyBases, dirOf(from))
  const tryMod = (base: string, segs: string[]) => {
    const p = [base, ...segs].filter(Boolean).join('/')
    if (!p) return null
    return r.lowerToReal.get(`${p}.py`.toLowerCase()) ?? r.lowerToReal.get(`${p}/__init__.py`.toLowerCase()) ?? null
  }
  for (const base of bases) {
    for (const n of names) {
      const hit = tryMod(base, [...parts, n])
      if (hit) return hit
    }
    for (let len = parts.length; len >= 1; len--) {
      const hit = tryMod(base, parts.slice(0, len))
      if (hit) return hit
    }
  }
  return null
}

const JS_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"\n]{1,300})\1/g
const PY_FROM = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+\(?([^\n#)]*)/gm
const PY_IMPORT = /^[ \t]*import[ \t]+([\w., \t]+)/gm
const CS_USING = /^[ \t]*(?:global[ \t]+)?using[ \t]+(?:static[ \t]+)?(?:\w+[ \t]*=[ \t]*)?([\w.]+)[ \t]*;/gm
const GO_IMPORT_BLOCK = /\bimport\s*\(([\s\S]*?)\)/g
const GO_IMPORT_ONE = /\bimport\s+(?:[\w.]+\s+)?"([^"\n]+)"/g

/** Imports in one file: internal target files, plus external package / namespace names. */
/**
 * The names an import statement brings in, read backwards from where its module string starts:
 * `import A, { b, c as d } from`, `import * as ns from`, `export { x } from`, `const { y } = require(`.
 * Side-effect and dynamic imports bring in no names.
 */
function jsNames(text: string, at: number): string[] {
  const before = text.slice(Math.max(0, at - 600), at)
  let start = -1
  for (const k of before.matchAll(/\b(import|export|const|let|var)\b/g)) start = k.index ?? start
  if (start < 0) return []
  const clause = before.slice(start)
  const m = /^(?:import|export)\s+(?:type\s+)?([\s\S]*?)\s*from\s*$/.exec(clause) ?? /^(?:const|let|var)\s+([\s\S]*?)\s*=\s*(?:await\s+)?require\s*\(\s*$/.exec(clause)
  if (!m) return []
  const body = m[1].trim()
  const names: string[] = []
  const braces = /\{([^}]*)\}/.exec(body)
  if (braces) for (const part of braces[1].split(',')) {
    const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+|\s*:\s*/)[0].trim()
    if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name)
  }
  const rest = body.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim()
  const star = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(rest)
  if (star) names.push(`* as ${star[1]}`)
  else if (/^[A-Za-z_$][\w$]*$/.test(rest)) names.unshift(rest)
  return names
}

type ImportLink = { file?: string; pkg?: string; names: string[] }

function parseImports(r: Resolver, file: string, text: string): { files: string[]; pkgs: string[]; py: string[]; cs: string[]; links: ImportLink[] } {
  const out = { files: [] as string[], pkgs: [] as string[], py: [] as string[], cs: [] as string[], links: [] as ImportLink[] }
  const ext = extOf(file)
  if (JS_EXTS.includes(ext)) {
    for (const m of text.matchAll(JS_IMPORT)) {
      const res = resolveJs(r, file, m[2])
      // Read back from the opening quote, so the clause ends with `from` / `require(`.
      const names = jsNames(text, (m.index ?? 0) + m[0].indexOf(m[1]))
      if (res.file) out.files.push(res.file), out.links.push({ file: res.file, names })
      else if (res.pkg) out.pkgs.push(res.pkg), out.links.push({ pkg: res.pkg, names })
    }
  } else if (ext === 'py') {
    for (const m of text.matchAll(PY_FROM)) {
      const names = m[3].split(',').map((s) => s.trim().split(/\s+/)[0]).filter((s) => /^\w+$/.test(s))
      const hit = resolvePy(r, file, m[1], m[2], names)
      if (hit) out.files.push(hit), out.links.push({ file: hit, names })
      else if (!m[1] && m[2]) out.py.push(m[2].split('.')[0])
    }
    for (const m of text.matchAll(PY_IMPORT)) {
      for (const part of m[1].split(',')) {
        const mod = part.trim().split(/\s+/)[0]
        if (!mod) continue
        const hit = resolvePy(r, file, '', mod, [])
        if (hit) out.files.push(hit), out.links.push({ file: hit, names: [] })
        else out.py.push(mod.split('.')[0])
      }
    }
  } else if (ext === 'cs') {
    for (const m of text.matchAll(CS_USING)) {
      const ns = m[1]
      let best: { name: string; dir: string } | undefined
      for (const p of r.csProjects) {
        if ((ns === p.name || ns.startsWith(p.name + '.')) && (!best || p.name.length > best.name.length)) best = p
      }
      if (best) out.files.push(best.dir + '/'), out.links.push({ file: best.dir + '/', names: [] })
      else out.cs.push(ns)
    }
  } else if (ext === 'go' && r.goModule) {
    const specs: string[] = []
    for (const m of text.matchAll(GO_IMPORT_BLOCK)) for (const q of m[1].matchAll(/"([^"\n]+)"/g)) specs.push(q[1])
    for (const m of text.matchAll(GO_IMPORT_ONE)) specs.push(m[1])
    for (const s of specs) {
      if (s === r.goModule || s.startsWith(r.goModule + '/')) out.files.push(s.slice(r.goModule.length + 1) + '/'), out.links.push({ file: s.slice(r.goModule.length + 1) + '/', names: [] })
    }
  }
  return out
}

// ── Manifests (for external systems) ──

type Manifest = { npm: Set<string>; py: Set<string>; nuget: Set<string>; frontend: boolean }

async function readManifests(root: string, allFiles: string[]): Promise<Manifest> {
  const m: Manifest = { npm: new Set(), py: new Set(), nuget: new Set(), frontend: false }
  const pkgJsons = allFiles.filter((f) => baseOf(f) === 'package.json').sort((a, b) => a.split('/').length - b.split('/').length).slice(0, 20)
  for (const f of pkgJsons) {
    const j = (await readJson(`${root}/${f}`)) as Record<string, Record<string, string> | undefined> | null
    if (!j) continue
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) for (const d of Object.keys(j[k] ?? {})) m.npm.add(d)
  }
  if (['react', 'react-dom', 'next', 'vue', 'svelte', '@remix-run/react', 'solid-js'].some((d) => m.npm.has(d))) m.frontend = true
  const pyFiles = allFiles.filter((f) => /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.py)$/.test(f)).slice(0, 10)
  for (const f of pyFiles) {
    try {
      const text = await readHead(`${root}/${f}`)
      for (const w of text.match(/[A-Za-z][\w.-]*/g) ?? []) {
        const name = w.toLowerCase().replace(/-/g, '_')
        m.py.add(name)
        m.py.add(name.split('_')[0]) // psycopg2-binary → psycopg2
      }
    } catch {
      // Unreadable manifest: skip.
    }
  }
  const csprojs = allFiles.filter((f) => f.endsWith('.csproj')).slice(0, 200)
  await mapLimit(csprojs, CONCURRENCY, async (f) => {
    try {
      for (const x of (await readHead(`${root}/${f}`)).matchAll(/<PackageReference\s+Include="([^"]+)"/g)) m.nuget.add(x[1])
    } catch {
      // Unreadable project file: skip.
    }
  })
  return m
}

function manifestHas(def: ExternalDef, m: Manifest): boolean {
  return (!!def.npm && [...m.npm].some(def.npm)) || (!!def.py && [...m.py].some(def.py)) || (!!def.nuget && [...m.nuget].some(def.nuget))
}

// ── Detection ──

type Candidate = { path: string; name?: string }

function detectModules(tree: Node, projectName: string, externalsPlanned: number, projectDirs: Set<string> = new Set()): { candidates: Candidate[]; scope: string[] } {
  // A folder whose children (or their only child) are separate projects: api/src/NaqApp.Shared/…, packages/*.
  const holdsProjects = (n: Node) => {
    const kids = [...n.children.values()].filter((k) => k.total > 0)
    return kids.length >= 2 && kids.filter((k) => projectDirs.has(k.path) || [...k.children.values()].some((g) => projectDirs.has(g.path))).length >= 2
  }
  // One feature built as layer projects (Controls/Controls.API, Controls.Domain, Controls.Application…,
  // or api/, domain/, infrastructure/ folders): its layers are its insides, not modules of their own.
  const layeredUnit = (n: Node) => {
    const kids = [...n.children.values()].filter((k) => k.total > 0)
    if (kids.length < 2) return false
    const own = n.name.toLowerCase()
    // Controls.API under Controls, or plain domain/, application/ folders; not NaqApp.Shared.Infrastructure
    // next to NaqApp.WebAPI (separate projects that merely end in a layer word).
    const layerish = kids.filter((k) => {
      const name = k.name.toLowerCase()
      return (name.startsWith(own + '.') && name.length > own.length + 1) || (!name.includes('.') && INNER_LAYERS.has(name))
    })
    return layerish.length >= 2 && layerish.length >= kids.length * 0.6
  }
  // Source roots: conventional folders, or monorepo package folders.
  let roots: Node[] = []
  const monoRoots: Node[] = []
  for (const name of SOURCE_ROOTS) {
    const n = tree.children.get(name)
    if (n && n.total > 0) roots.push(n)
  }
  for (const name of MONO_ROOTS) {
    const n = tree.children.get(name)
    if (n && [...n.children.values()].filter((c) => c.total > 0).length >= 2) monoRoots.push(n)
  }
  roots.push(...monoRoots)
  // Other top-level code folders (Next's components/, lib/ next to app/, and so on).
  if (roots.length) {
    for (const n of tree.children.values()) {
      const lower = n.name.toLowerCase()
      if (roots.includes(n) || n.total < 2 || NON_CODE_TOP.has(lower) || MONO_ROOTS.includes(lower) || n.name.startsWith('.')) continue
      roots.push(n)
    }
  }
  let rootMode = false
  if (!roots.length) {
    rootMode = true
    roots = [tree]
  }

  const candidates = new Map<string, Candidate>()
  const add = (n: Node) => candidates.set(n.path, { path: n.path, name: n.path === '' ? humanName(projectName) : nodeName(n, tree) })
  for (const r0 of roots) {
    const r = rootMode ? r0 : collapse(r0)
    const kids = [...r.children.values()].filter((c) => c.total > 0 && !(rootMode && (NON_CODE_TOP.has(c.name.toLowerCase()) || c.name.startsWith('.'))))
    if (!kids.length) {
      if (r.path !== '' || r.direct.length >= 3) add(r)
      continue
    }
    for (const k of kids) add(collapse(k))
    if (r.direct.length > 0 && (r.path !== '' || r.direct.length >= 3)) add(r)
  }
  if (!rootMode && tree.direct.length >= 3) add(tree)

  // The files the map covers: everything under a source root, plus loose root files when they form a module.
  const scopeRoots = rootMode ? [...candidates.keys()] : roots.map((r) => r.path)
  const inScope = (f: string) => scopeRoots.some((p) => (p === '' ? !f.includes('/') : under(f, p)))
  const scope: string[] = []
  const collect = (n: Node) => {
    scope.push(...n.direct)
    for (const c of n.children.values()) collect(c)
  }
  collect(tree)
  const scoped = scope.filter((f) => inScope(f) || (candidates.has('') && !f.includes('/')))

  const sizes = () => {
    const paths = [...candidates.keys()].sort((a, b) => b.length - a.length)
    const s = new Map<string, number>(paths.map((p) => [p, 0]))
    let orphans = 0
    for (const f of scoped) {
      const p = paths.find((c) => under(f, c))
      if (p === undefined) orphans++
      else s.set(p, s.get(p)! + 1)
    }
    return { s, orphans }
  }
  const budget = () => MAX_MODULES - externalsPlanned

  // Split folders that hold too much of the code (or split the biggest when there are too few modules).
  const unsplittable = new Set<string>()
  for (let iter = 0; iter < 200; iter++) {
    const { s } = sizes()
    const total = scoped.length || 1
    const splittable = [...candidates.keys()]
      .filter((p) => !unsplittable.has(p))
      .map((p) => ({ p, n: findNode(tree, p)!, size: s.get(p) ?? 0 }))
      .filter((c) => c.n && !layeredUnit(c.n) && [...c.n.children.values()].filter((k) => !candidates.has(collapse(k).path) && k.total > 0).length >= 2)
      .sort((a, b) => b.size - a.size)
    // Folders named after a whole layer (src/api, src/web, lib…), folders of separate projects, and
    // very large modules all open up; a feature's own layer projects never do.
    // In a big codebase a folder of tiny pieces (components/button, components/checkbox…) is one
    // module, a component kit; its children only become modules when they're substantial.
    const worthSplitting = (n: Node) => {
      if (total < 2000) return true
      const sizes = [...n.children.values()].filter((k) => k.total > 0).map((k) => k.total).sort((a, b) => a - b)
      return (sizes[Math.floor(sizes.length / 2)] ?? 0) >= 8
    }
    let pick =
      splittable.find((c) => c.size > total * 0.4 && worthSplitting(c.n)) ??
      splittable.find((c) => (CONTAINER_NAMES.has(c.p.split('/').pop()!.toLowerCase()) || holdsProjects(c.n)) && worthSplitting(c.n) && candidates.size < budget() - 1) ??
      splittable.find((c) => c.size > BIG_MODULE_FILES && worthSplitting(c.n) && candidates.size < budget() - 1)
    if (!pick && candidates.size < MIN_MODULES) pick = splittable[0]
    if (!pick) break
    const kids = [...pick.n.children.values()].map(collapse).filter((k) => k.total > 0 && !candidates.has(k.path)).sort((a, b) => b.total - a.total)
    const available = budget() - (candidates.size - 1) // slots if the parent gives up its own
    const keep = kids.slice(0, Math.max(0, available))
    const parentStays = keep.length < kids.length || pick.n.direct.length > 0
    if (parentStays && keep.length >= available) keep.splice(Math.max(0, available - 1))
    if (keep.length < 2) {
      unsplittable.add(pick.p)
      continue
    }
    if (!parentStays) candidates.delete(pick.p)
    for (const k of keep) add(k)
    unsplittable.add(pick.p)
  }

  // Fold tiny folders into their parent module, or into Other.
  for (let iter = 0; iter < 3; iter++) {
    const { s } = sizes()
    let changed = false
    for (const [p, n] of s) {
      // In a small project a one-file folder is still a real part of the system; only fold in big ones.
      if (n < 2 && candidates.size > 1 && p !== '' && scoped.length > 40) {
        candidates.delete(p)
        changed = true
      }
    }
    if (!changed) break
  }
  // Too many modules: fold the smallest.
  while (candidates.size > budget()) {
    const { s } = sizes()
    const smallest = [...s].filter(([p]) => p !== '').sort((a, b) => a[1] - b[1])[0]
    if (!smallest) break
    candidates.delete(smallest[0])
  }
  // Anything left without a module goes to Other at the (single) source root, or the repo root.
  // When they all come from one folder, that folder is its own (small) module instead.
  if (sizes().orphans > 0) {
    const otherPath = !rootMode && roots.length === 1 ? collapse(roots[0]).path : ''
    const paths = [...candidates.keys()]
    const orphans = scoped.filter((f) => !paths.some((c) => under(f, c)))
    const tops = new Set(orphans.map((f) => (otherPath ? f.slice(otherPath.length + 1) : f).split('/')[0]))
    const only = tops.size === 1 && orphans.every((f) => f.includes('/', otherPath ? otherPath.length + 1 : 0)) ? findNode(tree, [otherPath, [...tops][0]].filter(Boolean).join('/')) : undefined
    if (only) add(collapse(only))
    else if (!candidates.has(otherPath)) candidates.set(otherPath, { path: otherPath, name: 'Other' })
  }

  // Tiny projects: when there's barely a structure, the files themselves are the modules.
  const { s } = sizes()
  if (candidates.size < 3 && scoped.length <= 12) {
    const biggest = [...s].sort((a, b) => b[1] - a[1])[0]
    const n = biggest && findNode(tree, biggest[0])
    if (n && n.direct.length >= 2 && n.direct.length <= 12) {
      candidates.delete(biggest[0])
      for (const f of n.direct) candidates.set(f, { path: f, name: humanName(stemOf(f)) })
      if (n.children.size) candidates.set(n.path, { path: n.path, name: nodeName(n, tree) })
    }
  }
  return { candidates: [...candidates.values()], scope: scoped }
}

// ── Main entry ──

type OverrideFile = { layers?: { name?: string; modules?: { name?: string; path?: string; external?: boolean }[] }[] }

// Maps are kept per project (in memory and in Glassbox's data folder), so switching tabs,
// projects or restarting never redraws from scratch. They're rebuilt in the background when a new
// session starts in the project, or when Claude adds files (the caller forces it).
const cache = new Map<string, Architecture>()
/** What the last build of each project learned for reading imports (aliases, projects) and HTTP routes. */
type ScanContext = { resolver: Resolver; routes: (ServerRoute & { module: string })[] }
const contexts = new Map<string, ScanContext>()
const building = new Map<string, Promise<Architecture>>()
let onChanged: (root: string) => void = () => {}
/** Called with the project root whenever a background rebuild changes its map. */
export function onArchitectureChanged(fn: (root: string) => void) {
  onChanged = fn
}

const diskFile = async (key: string) => join((await import('electron')).app.getPath('userData'), 'map-cache', createHash('sha1').update(key).digest('hex').slice(0, 16) + '.json')
async function fromDisk(key: string): Promise<Architecture | null> {
  try {
    return JSON.parse(await readFile(await diskFile(key), 'utf8')) as Architecture
  } catch {
    return null
  }
}
async function toDisk(key: string, arch: Architecture) {
  try {
    const file = await diskFile(key)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(arch))
  } catch {
    /* outside Electron, or the disk refused: memory cache still works */
  }
}

const slashed = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
async function rootOf(cwd: string) {
  return slashed((await gitRoot(cwd)) ?? slashed(cwd || ''))
}

function rebuild(root: string): Promise<Architecture> {
  const key = root.toLowerCase()
  const running = building.get(key)
  if (running) return running
  const p = (async () => {
    // Categories named by Claude for this project (once, in the background), over the detected map.
    const arch = await organise(await build(root), () => void rebuild(root).then(() => onChanged(root)))
    // While Claude is still naming the categories, keep the detected map in memory only; the
    // named one replaces it (and is saved) when it lands.
    cache.set(key, arch)
    if (!arch.organising) void toDisk(key, arch)
    return arch
  })().finally(() => building.delete(key))
  building.set(key, p)
  return p
}

export async function getArchitecture(cwd: string, force?: boolean): Promise<Architecture> {
  let root = slashed(cwd || '')
  try {
    root = await rootOf(cwd)
    const key = root.toLowerCase()
    if (!force) {
      const hit = cache.get(key) ?? (await fromDisk(key))
      if (hit && hit.version === ARCH_VERSION) {
        cache.set(key, hit)
        return hit
      }
    }
    return await rebuild(root)
  } catch (e) {
    return { root, layers: [], modules: [], edges: [], source: 'detected', error: errText(e) }
  }
}

/** A new session started here: redraw the map in the background and say if it changed. */
export async function refreshArchitecture(cwd: string) {
  try {
    const root = await rootOf(cwd)
    const before = cache.get(root.toLowerCase()) ?? (await fromDisk(root.toLowerCase()))
    const after = await rebuild(root)
    if (!before || JSON.stringify(before) !== JSON.stringify(after)) onChanged(root)
  } catch {
    /* keep the cached map */
  }
}

async function build(root: string): Promise<Architecture> {
  const started = Date.now()
  const listed = ((await gitListFiles(root)) ?? (await listProjectFiles(root))).map((f) => f.replace(/\\/g, '/'))
  // Generated code and tool output (api clients, brag-output/, …) aren't parts of the system.
  const visible = listed.filter((f) => !f.split('/').slice(0, -1).some((s) => SKIP_DIRS.has(s) || (s.startsWith('.') && s !== '.glassbox') || /^generated$|[-_]output$/i.test(s)))
  const allSource = visible.filter(isSource).slice(0, MAX_FILES)
  const testFiles = allSource.filter((f) => isTestFile(f) || inTestDir(f))
  const testSet = new Set(testFiles)
  const sourceFiles = allSource.filter((f) => !testSet.has(f))
  const manifest = await readManifests(root, visible)
  const projectName = basename(root)

  const plannedExternals = EXTERNALS.filter((d) => manifestHas(d, manifest))
  let modules: ArchModule[] = []
  let source: Architecture['source'] = 'detected'
  let scope = sourceFiles

  const override = (await readJson(`${root}/.glassbox/architecture.json`)) as OverrideFile | null
  if (override && Array.isArray(override.layers)) {
    source = 'file'
    const seen = new Set<string>()
    for (const l of override.layers) {
      // Any category name the project chooses, such as "Lambdas" or "Billing".
      const layer: ArchLayer = typeof l.name === 'string' && l.name.trim() ? l.name.trim().slice(0, 40) : 'Other'
      for (const m of l.modules ?? []) {
        if (!m || typeof m.name !== 'string') continue
        const path = String(m.path ?? '').replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '')
        let id = m.external ? `ext:${slug(m.name)}` : path || slug(m.name)
        while (seen.has(id)) id += '-2'
        seen.add(id)
        modules.push({ id, name: m.name, path, layer, files: 0, tests: 0, ...(m.external ? { external: true } : {}) })
      }
    }
  } else {
    const tree = buildTree(sourceFiles)
    tree.name = projectName
    const reserve = Math.min(MAX_EXTERNALS, plannedExternals.length)
    // Folders holding their own project file: a parent full of these is a container of projects.
    const projectDirs = new Set(visible.filter((f) => PROJECT_FILE.test(f)).map(dirOf))
    projectStops = projectDirs
    const det = detectModules(tree, projectName, reserve, projectDirs)
    scope = det.scope
    const names = new Map<string, number>()
    for (const c of det.candidates) names.set(c.name ?? '', (names.get(c.name ?? '') ?? 0) + 1)
    modules = det.candidates.map((c) => {
      let name = c.name ?? humanName(baseOf(c.path))
      if ((names.get(name) ?? 0) > 1 && c.path) {
        // Same name in two places (a UI feature and an API module both called Controls): say where
        // each lives, using the first folder where their paths part ways.
        const twins = det.candidates.filter((o) => o !== c && (o.name ?? humanName(baseOf(o.path))) === name).map((o) => o.path.split('/'))
        const segs = c.path.split('/')
        let i = 0
        while (i < segs.length - 1 && twins.every((t) => t[i] === segs[i])) i++
        const where = segs.slice(i, -1).find((s) => !GENERIC.has(s.toLowerCase()) && humanName(s) !== name) ?? segs[i]
        if (where && humanName(where) !== name) name = `${name} (${humanName(where)})`
      }
      const id = c.path || slug(name)
      return { id, name, path: c.path, layer: name === 'Other' ? 'Other' : layerFor(c.path, name, manifest.frontend), files: 0, tests: 0 }
    })
    // Still two of a name (src/ai and src/features/ai are both "AI (UI)"): name each by its own parent folder.
    const seen = new Map<string, ArchModule[]>()
    for (const m of modules) seen.set(m.name, [...(seen.get(m.name) ?? []), m])
    for (const [, same] of seen) {
      if (same.length < 2) continue
      for (const m of same) {
        const segs = m.path.split('/').filter(Boolean)
        const owner = segs.slice(0, -1).reverse().find((s) => !ROOTISH.has(s.toLowerCase()))
        const base = m.name.replace(/ \([^)]*\)$/, '')
        if (owner) m.name = `${base} (${humanName(owner)})`
      }
    }
  }

  const arch: Architecture = { root, layers: [], modules, edges: [], source }
  const internal = modules.filter((m) => !m.external)
  const byId = new Map(modules.map((m) => [m.id, m]))

  // File counts.
  for (const f of scope) {
    const m = moduleOf(arch, f)
    if (m) m.files++
  }
  // Test counts: test-named files inside a module, and test folders named after a module.
  const byKey = new Map<string, ArchModule>()
  for (const m of internal) {
    for (const k of [matchKey(baseOf(m.path)), matchKey(m.name), matchKey(stemOf(m.path))]) if (k && !byKey.has(k)) byKey.set(k, m)
  }
  // Folders folded into a bigger module still match by name (tests/Foo.Tests → the module holding src/x/Foo).
  for (const dir of new Set(scope.map(dirOf))) {
    for (let d = dir; d; d = dirOf(d)) {
      const k = matchKey(baseOf(d))
      const m = k && !byKey.has(k) ? moduleOf(arch, d + '/x') : undefined
      if (m && m.path !== '') byKey.set(k, m)
    }
  }
  for (const t of testFiles) {
    const segs = t.split('/')
    const ti = segs.findIndex((s, i) => i < segs.length - 1 && (TEST_DIRS.has(s.toLowerCase()) || /[.\-_]tests?$/i.test(s)))
    if (ti >= 0) {
      const own = segs[ti]
      const candidatesKeys = /[.\-_]tests?$/i.test(own) ? [own] : [segs[ti + 1] ?? '', stemOf(t)]
      const target = candidatesKeys.map((k) => byKey.get(matchKey(k))).find(Boolean)
      if (target) { target.tests++; continue }
      // A test folder inside a module (`src/foo/__tests__`) belongs to that module.
      if (ti > 0) {
        const m = moduleOf(arch, segs.slice(0, ti).join('/') + '/x')
        if (m && m.path !== '') { m.tests++; continue }
      }
      continue
    }
    const m = moduleOf(arch, t)
    const named = byKey.get(matchKey(stemOf(t).replace(/^test_|_test$/i, '')))
    if (named && (!m || m.path === dirOf(t) || named.path.startsWith(dirOf(t)))) named.tests++
    else if (m) m.tests++
  }

  // Resolver setup.
  const resolver: Resolver = {
    files: new Set(allSource),
    lowerToReal: new Map(allSource.map((f) => [f.toLowerCase(), f])),
    aliases: [],
    pyBases: ['', ...['src', 'app', 'lib'].filter((d) => allSource.some((f) => f.startsWith(d + '/') && f.endsWith('.py')))],
    csProjects: []
  }
  // Path aliases (@/components/…) from every tsconfig/jsconfig in the repo, each applying to the files
  // under its own folder: a monorepo's apps (ui/naq-webapp-ui) each declare their own.
  const configs = visible.filter((f) => /(^|\/)(tsconfig[\w.-]*|jsconfig)\.json$/i.test(f)).slice(0, 60)
  for (const cfg of configs) {
    const scope = dirOf(cfg)
    const j = (await readJson(`${root}/${cfg}`)) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, unknown> } } | null
    const paths = j?.compilerOptions?.paths
    if (!paths || typeof paths !== 'object') continue
    const baseUrl = posix.join(scope || '.', String(j?.compilerOptions?.baseUrl ?? '.'))
    for (const [prefix, targets] of Object.entries(paths)) {
      if (!Array.isArray(targets)) continue
      resolver.aliases.push({ prefix, scope, targets: targets.filter((t): t is string => typeof t === 'string').map((t) => posix.normalize(posix.join(baseUrl, t)).replace(/^\.\//, '')) })
    }
  }
  // The usual @/ and ~/ shorthand for a src folder, where none is declared.
  for (const src of [...new Set(allSource.map((f) => /^(.*?\/)?src\//.exec(f)?.[0]).filter((x): x is string => !!x))].slice(0, 20)) {
    const scope = src.replace(/\/?src\/$/, '')
    if (resolver.aliases.some((a) => a.prefix === '@/*' && (a.scope ?? '') === scope)) continue
    resolver.aliases.push({ prefix: '@/*', scope, targets: [`${src}*`] }, { prefix: '~/*', scope, targets: [`${src}*`] })
  }
  // Most specific folder first, so an app's own aliases win over the repo's.
  resolver.aliases.sort((a, b) => (b.scope ?? '').length - (a.scope ?? '').length)
  if (visible.includes('go.mod')) {
    try {
      resolver.goModule = (await readHead(`${root}/go.mod`)).match(/^module\s+(\S+)/m)?.[1]
    } catch {
      // No go module path: Go imports stay unresolved.
    }
  }
  const csprojFiles = visible.filter((f) => f.endsWith('.csproj') && !inTestDir(f + '/x'))
  resolver.csProjects = csprojFiles.map((f) => ({ name: stemOf(f), dir: dirOf(f) }))

  // Edges.
  const weights = new Map<string, number>()
  const extWeights = new Map<string, Map<string, number>>()
  const bump = (from: string, to: string) => {
    if (from === to) return
    const k = `${from}\u0000${to}`
    weights.set(k, (weights.get(k) ?? 0) + 1)
  }
  const bumpExt = (from: string, key: string) => {
    const m = extWeights.get(key) ?? new Map<string, number>()
    m.set(from, (m.get(from) ?? 0) + 1)
    extWeights.set(key, m)
  }
  const deadline = started + SCAN_BUDGET_MS
  const links: ArchLink[] = []
  const routes: (ServerRoute & { module: string })[] = []
  const calls: (ClientCall & { module: string })[] = []

  const scanList = scope.filter((f) => JS_EXTS.includes(extOf(f)) || ['py', 'cs', 'go'].includes(extOf(f)))
  await mapLimit(scanList, CONCURRENCY, async (f) => {
    if (Date.now() > deadline) return
    const from = moduleOf(arch, f)
    if (!from) return
    let text: string
    try {
      text = await readHead(`${root}/${f}`)
    } catch {
      return
    }
    const imp = parseImports(resolver, f, text)
    // HTTP: routes this file serves, and API paths it calls.
    for (const r of serverRoutes(f, text)) routes.push({ ...r, module: from.id })
    if (JS_EXTS.includes(extOf(f))) for (const c of clientCalls(f, text)) calls.push({ ...c, module: from.id })
    for (const target of imp.files) {
      const to = moduleOf(arch, target.endsWith('/') ? target + 'x' : target)
      if (to) bump(from.id, to.id)
    }
    // The file-to-file detail behind the edges, for "how does this module connect" on the map.
    for (const l of imp.links) {
      if (links.length >= MAX_LINKS) break
      if (l.file) {
        const to = moduleOf(arch, l.file.endsWith('/') ? l.file + 'x' : l.file)
        if (to && to.id !== from.id) links.push({ from: f, to: l.file, fromModule: from.id, toModule: to.id, names: l.names.slice(0, 12) })
      } else if (l.pkg) {
        const d = EXTERNALS.find((x) => x.npm?.(l.pkg!))
        if (d) links.push({ from: f, to: '', fromModule: from.id, toModule: `ext:${d.key}`, names: l.names.slice(0, 12) })
      }
    }
    for (const d of EXTERNALS) {
      const n = (d.npm ? imp.pkgs.filter(d.npm).length : 0) + (d.py ? imp.py.filter(d.py).length : 0) + (d.cs ? imp.cs.filter(d.cs).length : 0)
      for (let i = 0; i < n; i++) bumpExt(from.id, d.key)
    }
  })
  // C# project references count as dependencies too.
  await mapLimit(csprojFiles, CONCURRENCY, async (f) => {
    if (Date.now() > deadline) return
    const from = moduleOf(arch, dirOf(f) + '/x')
    if (!from) return
    try {
      const text = await readHead(`${root}/${f}`)
      for (const x of text.matchAll(/<ProjectReference\s+Include="([^"]+)"/g)) {
        const target = posix.normalize(posix.join(dirOf(f), x[1].replace(/\\/g, '/')))
        const to = moduleOf(arch, dirOf(target) + '/x')
        if (to) bump(from.id, to.id)
      }
      for (const x of text.matchAll(/<PackageReference\s+Include="([^"]+)"/g)) {
        for (const d of EXTERNALS) if (d.nuget?.(x[1])) bumpExt(from.id, d.key)
      }
    } catch {
      // Unreadable project file: skip.
    }
  })

  // External systems.
  if (source === 'file') {
    for (const m of modules.filter((x) => x.external)) {
      const lower = `${m.name} ${m.path}`.toLowerCase()
      const def = EXTERNALS.find((d) => lower.includes(d.key) || lower.includes(d.name.toLowerCase()))
      for (const [from, w] of (def && extWeights.get(def.key)) || []) if (byId.has(from)) weights.set(`${from}\u0000${m.id}`, w)
    }
  } else {
    const usage = plannedExternals
      .map((d) => ({ d, total: [...(extWeights.get(d.key)?.values() ?? [])].reduce((a, b) => a + b, 0) }))
      .filter((x) => x.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, MAX_EXTERNALS)
    for (const { d } of usage) {
      const id = `ext:${d.key}`
      modules.push({ id, name: d.name, path: '', layer: d.layer, files: 0, tests: 0, external: true })
      for (const [from, w] of extWeights.get(d.key)!) weights.set(`${from}\u0000${id}`, w)
    }
  }

  // A frontend calling a backend over HTTP connects them as surely as an import does.
  const httpWeights = new Map<string, number>()
  // Connections where at least one call matches its route for certain; the rest are likely only.
  const httpSure = new Set<string>()
  for (const { call, route, sure } of matchCalls(routes, calls)) {
    const from = (call as ClientCall & { module: string }).module
    const to = (route as ServerRoute & { module: string }).module
    if (from === to) continue
    const k = `${from}\u0000${to}`
    httpWeights.set(k, (httpWeights.get(k) ?? 0) + 1)
    if (sure) httpSure.add(k)
    if (links.length < MAX_LINKS) links.push({ from: call.file, to: route.file, fromModule: from, toModule: to, names: [`${route.method} ${route.route}`], http: true, ...(sure ? {} : { weak: true }) })
  }
  contexts.set(root.toLowerCase(), { resolver, routes })
  const edges: ArchEdge[] = [
    ...[...weights].map(([k, weight]) => {
      const [from, to] = k.split('\u0000')
      return { from, to, weight }
    }),
    ...[...httpWeights].filter(([k]) => !weights.has(k)).map(([k, weight]) => {
      const [from, to] = k.split('\u0000')
      return { from, to, weight, http: true, ...(httpSure.has(k) ? {} : { weak: true }) }
    })
  ].sort((a, b) => b.weight - a.weight)

  if (source === 'detected') categorise(modules, manifest.frontend)
  // Categories in reading order: the file's own order, else by the role each plays (web first, data last).
  const layers: ArchLayer[] = []
  if (source === 'file' && override) for (const l of override.layers ?? []) { const n = typeof l.name === 'string' && l.name.trim() ? l.name.trim().slice(0, 40) : 'Other'; if (!layers.includes(n) && modules.some((m) => m.layer === n)) layers.push(n) }
  else {
    const rank = (layer: string) => (layer === 'External' ? 99 : layer === 'Other' ? 98 : LAYER_ORDER.indexOf(roleOfName(layer, modules, manifest.frontend)))
    for (const m of modules) if (!layers.includes(m.layer)) layers.push(m.layer)
    layers.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  }
  const pos = new Map(layers.map((l, i) => [l, i]))
  modules.sort((a, b) => pos.get(a.layer)! - pos.get(b.layer)! || Number(!!a.external) - Number(!!b.external) || b.files - a.files || a.name.localeCompare(b.name))
  const ids = new Set(modules.map((m) => m.id))
  return {
    root,
    layers,
    modules,
    edges,
    links: links.filter((l) => ids.has(l.fromModule) && ids.has(l.toModule)),
    version: ARCH_VERSION,
    source
  }
}

/** Folder names that only hold code rather than name part of the system. */
const ROOTISH = new Set(['src', 'source', 'sources', 'code'])

/**
 * Name each module's category after the folder that groups it with its siblings (src/lambdas/*
 * becomes "Lambdas", src/renderer/src/* becomes "Renderer"). A module on its own falls back to the
 * role its path suggests (Web, API, Domain, Data), and anything outside the code is "External".
 */
/** Folder names that need their owner's name to mean anything as a category. */
const CONTEXT_WORDS = new Set(['modules', 'features', 'services', 'components', 'packages', 'apps', 'libs', 'pages', 'functions', 'handlers', 'plugins', 'extensions', 'workers', 'jobs'])

function categorise(modules: ArchModule[], frontend: boolean) {
  const internal = modules.filter((m) => !m.external && m.name !== 'Other')
  // Big codebases get structural categories only; small ones keep the web/API/data roles.
  const big = internal.length > 24
  const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
  const siblings = new Map<string, number>()
  for (const m of internal) siblings.set(parentOf(m.path), (siblings.get(parentOf(m.path)) ?? 0) + 1)
  const groupName = (dir: string): string | null => {
    const segs = dir.split('/').filter(Boolean)
    // "src" says nothing: name the group after the folder above it (src/renderer/src → Renderer).
    while (segs.length && ROOTISH.has(segs[segs.length - 1].toLowerCase())) segs.pop()
    if (!segs.length) return null
    const last = segs[segs.length - 1]
    // "Modules" or "Features" alone doesn't say whose: say which part of the system they're in
    // (api/modules → API modules, ui/webapp/src/features → Webapp features).
    if (CONTEXT_WORDS.has(last.toLowerCase())) {
      const owner = segs.slice(0, -1).reverse().find((s) => !ROOTISH.has(s.toLowerCase()))
      if (owner) return `${humanName(owner)} ${humanName(last).toLowerCase()}`
    }
    return humanName(last)
  }
  // Not in any folder group: file it under the top-level area it lives in (API, UI, Emails…), not a
  // guess from words in its path.
  const areaOf = (path: string): string | null => {
    const top = path.split('/').filter(Boolean).find((s) => !ROOTISH.has(s.toLowerCase()))
    return top && path.includes('/') ? humanName(top) : null
  }
  const groups = new Map<string, string>()
  for (const [dir, n] of siblings) {
    if (n < 2 || !dir) continue
    const name = groupName(dir)
    if (name && !(ROOTISH.has(dir.toLowerCase()))) groups.set(dir, name)
  }
  for (const m of modules) {
    if (m.external) { m.layer = 'External'; continue }
    if (m.name === 'Other') { m.layer = 'Other'; continue }
    // The module that is itself a group's folder (src/renderer/src next to its children) joins that group.
    const own = groups.get(m.path)
    const parent = groups.get(parentOf(m.path))
    m.layer = own ?? parent ?? (big ? areaOf(m.path) : null) ?? layerFor(m.path, m.name, frontend)
  }
  // A category of one is just noise: fold it back to its role.
  const count = new Map<string, number>()
  for (const m of modules) count.set(m.layer, (count.get(m.layer) ?? 0) + 1)
  for (const m of modules) if (!m.external && m.name !== 'Other' && (count.get(m.layer) ?? 0) < 2 && !(LAYER_ORDER as string[]).includes(m.layer)) m.layer = layerFor(m.path, m.name, frontend)
}

/** The role a category plays, for ordering: from its name if it is one, else from its modules' paths. */
function roleOfName(layer: string, modules: ArchModule[], frontend: boolean): ArchRole {
  if ((LAYER_ORDER as string[]).includes(layer)) return layer as ArchRole
  const votes = new Map<ArchRole, number>()
  for (const m of modules) if (m.layer === layer) { const r = layerFor(m.path, layer, frontend); votes.set(r, (votes.get(r) ?? 0) + 1) }
  let best: ArchRole = 'Other', n = -1
  for (const [r, v] of votes) if (v > n && r !== 'Other') { best = r; n = v }
  return n < 0 ? layerFor(layer.toLowerCase(), layer, frontend) : best
}

// ── Reading single files against the map (the architecture diff, boundary checks) ──

/** A connection one file makes to another module: an import, or an HTTP call to its routes. */
export type FileConnection = { toModule: string; to: string; names: string[]; http?: boolean }

/**
 * The map and what reading imports needs for a project, building the map first when this run of
 * Glassbox hasn't scanned it yet (a map loaded from disk has no import resolver).
 */
async function scanFor(cwd: string): Promise<{ arch: Architecture; ctx: ScanContext } | null> {
  const root = await rootOf(cwd)
  const key = root.toLowerCase()
  let arch = cache.get(key)
  if (!arch || !contexts.has(key)) arch = await rebuild(root)
  const ctx = contexts.get(key)
  return arch && ctx ? { arch, ctx } : null
}

function connectionsIn(arch: Architecture, ctx: ScanContext, file: string, text: string): FileConnection[] {
  const from = moduleOf(arch, file)
  if (!from) return []
  const ids = new Set(arch.modules.map((m) => m.id))
  const out: FileConnection[] = []
  const imp = parseImports(ctx.resolver, file, text)
  for (const l of imp.links) {
    if (l.file) {
      const to = moduleOf(arch, l.file.endsWith('/') ? l.file + 'x' : l.file)
      if (to && to.id !== from.id) out.push({ toModule: to.id, to: l.file, names: l.names })
    } else if (l.pkg) {
      const d = EXTERNALS.find((x) => x.npm?.(l.pkg!))
      if (d && ids.has(`ext:${d.key}`)) out.push({ toModule: `ext:${d.key}`, to: '', names: l.names })
    }
  }
  if (JS_EXTS.includes(extOf(file))) {
    for (const { route } of matchCalls(ctx.routes, clientCalls(file, text))) {
      const to = (route as ServerRoute & { module: string }).module
      if (to !== from.id) out.push({ toModule: to, to: route.file, names: [`${route.method} ${route.route}`], http: true })
    }
  }
  return out
}

/**
 * The connections each of these files makes (paths relative to the repo root, with the text to
 * read, which may be an older version of the file). New files count as resolvable targets.
 */
export async function fileConnections(cwd: string, files: { path: string; text: string }[]): Promise<{ arch: Architecture; conns: FileConnection[][] } | null> {
  const scan = await scanFor(cwd)
  if (!scan) return null
  for (const f of files) {
    if (!isSource(f.path)) continue
    scan.ctx.resolver.files.add(f.path)
    scan.ctx.resolver.lowerToReal.set(f.path.toLowerCase(), f.path)
  }
  return { arch: scan.arch, conns: files.map((f) => (isSource(f.path) ? connectionsIn(scan.arch, scan.ctx, f.path, f.text) : [])) }
}

/** The map for a project if it's already in memory (no building): for quick checks on the hot path. */
export function cachedScan(root: string): { arch: Architecture; ctx: ScanContext } | null {
  const key = slashed(root).toLowerCase()
  const arch = cache.get(key)
  const ctx = contexts.get(key)
  return arch && ctx ? { arch, ctx } : null
}

/** The files and folders (relative to the repo root) that `text`, as the contents of `file`, imports. */
export function importTargets(scan: { ctx: ScanContext }, file: string, text: string): string[] {
  return parseImports(scan.ctx.resolver, file, text).files
}

/** Warm the map (and its import resolver) for a project in the background. */
export function warmScan(cwd: string) {
  void scanFor(cwd).catch(() => {})
}
