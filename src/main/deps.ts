import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { tr } from '../shared/i18n'

/**
 * Blast radius: for each file Claude edited, the other files in the project that import or
 * reference it. Text search (git grep, or a bounded scan outside git) plus a per-language
 * matcher, so it's fast and dependency-free, and errs a little towards showing too much.
 */

export type Dependent = { path: string; line: number; text: string }
export type BlastRadiusFile = { path: string; dependents: Dependent[]; truncated: boolean }
export type BlastRadiusResult = { files: BlastRadiusFile[]; error?: string }

const MAX_DEPENDENTS = 50
const MAX_INPUT_FILES = 40
const GREP_TIMEOUT_MS = 15_000
const SCAN_BUDGET_MS = 10_000
const SCAN_MAX_FILES = 20_000
const SCAN_MAX_BYTES = 1024 * 1024
const MAX_LINE = 400
const CONCURRENCY = 4

const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'out', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', 'coverage', '.venv', 'venv', '__pycache__', '.terraform', 'target', 'vendor', '.turbo', '.cache'])
const EXCLUDE_PATHSPECS = [...SKIP_DIRS].map((d) => `:(exclude,glob)**/${d}/**`).concat([':(exclude,glob)**/*.min.js', ':(exclude,glob)**/*.map', ':(exclude,glob)**/*.lock', ':(exclude,glob)**/package-lock.json'])

type Family = 'js' | 'style' | 'py' | 'go' | 'jvm' | 'cs' | 'rust' | 'c' | 'other'

const EXT_FAMILY: Record<string, Family> = {
  ts: 'js', tsx: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', mts: 'js', cts: 'js', vue: 'js', svelte: 'js', astro: 'js',
  css: 'style', scss: 'style', sass: 'style', less: 'style',
  py: 'py', pyi: 'py',
  go: 'go',
  java: 'jvm', kt: 'jvm', kts: 'jvm',
  cs: 'cs',
  rs: 'rust',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', hxx: 'c'
}

const JS_EXTS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'astro', 'mdx', 'html']
const STYLE_EXTS = ['css', 'scss', 'sass', 'less']
/** Which files can reference a target of each family. */
const REFERRER_EXTS: Record<Family, string[]> = {
  js: [...JS_EXTS, ...STYLE_EXTS],
  style: [...JS_EXTS, ...STYLE_EXTS],
  other: [...JS_EXTS, ...STYLE_EXTS],
  py: ['py', 'pyi'],
  go: ['go'],
  jvm: ['java', 'kt', 'kts'],
  cs: ['cs', 'cshtml', 'razor'],
  rust: ['rs'],
  c: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx']
}

type Target = {
  abs: string
  /** Lower-cased, forward-slash absolute path, for comparisons. */
  key: string
  family: Family
  /** Words to search for. */
  terms: string[]
  /** Module names a reference must end in. */
  names: Set<string>
  isIndex: boolean
  folder: string
  parentFolder: string
}

const norm = (p: string) => p.replace(/\\/g, '/')
const keyOf = (p: string) => norm(resolve(p)).toLowerCase()
const stripExt = (p: string) => p.replace(/\.d\.ts$/i, '').replace(/\.[A-Za-z0-9]+$/, '')
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function makeTarget(cwd: string, file: string): Target | null {
  const abs = isAbsolute(file) ? resolve(file) : resolve(cwd, file)
  const ext = extname(abs).slice(1).toLowerCase()
  const family = EXT_FAMILY[ext] ?? 'other'
  const base = basename(abs)
  const stem = /\.d\.ts$/i.test(base) ? base.slice(0, -5) : base.slice(0, base.length - (ext ? ext.length + 1 : 0))
  const folder = basename(dirname(abs))
  const parentFolder = basename(dirname(dirname(abs)))
  let names: string[] = [stem]
  let isIndex = false
  switch (family) {
    case 'js':
      if (stem === 'index') { isIndex = true; names = [folder] }
      break
    case 'style':
      if (stem.startsWith('_')) names = [stem.slice(1), stem]
      if (stem === 'index' || stem === '_index') { isIndex = true; names = [folder] }
      break
    case 'py':
      if (stem === '__init__') { isIndex = true; names = [folder] }
      break
    case 'go':
      names = [folder]
      break
    case 'cs':
      names = [base.split('.')[0]]
      break
    case 'rust':
      if (stem === 'mod') { isIndex = true; names = [folder] }
      else if (stem === 'lib' || stem === 'main') return null
      break
    case 'c':
      names = [base]
      break
    case 'other':
      names = [base, stem]
      break
  }
  names = names.filter(Boolean)
  if (!names.length) return null
  return { abs, key: keyOf(abs), family, terms: [...new Set(names)], names: new Set(names), isIndex, folder, parentFolder }
}

// ── Matchers: does this line (in file `from`) reference the target? ──

const IMPORTISH = /\b(import|require|from|export|mock|lazy)\b|@(import|use|forward)\b/
const QUOTED = /(['"`])([^'"`\n]+)\1/g

function specMatches(t: Target, spec: string, fromAbs: string, fromIsStyle: boolean): boolean {
  spec = spec.replace(/[?#].*$/, '').trim()
  if (!spec || /^[a-z]+:\/\//i.test(spec)) return false
  const relative = spec.startsWith('.') || spec.startsWith('/') || fromIsStyle
  if (relative && !spec.startsWith('/')) {
    const cand = keyOf(resolve(dirname(fromAbs), spec))
    if (cand === t.key) return true
    const tNoExt = stripExt(t.key)
    if (stripExt(cand) === tNoExt || cand === tNoExt) return true
    if (t.isIndex && (cand === keyOf(dirname(t.abs)) || cand === keyOf(join(dirname(t.abs), 'index')))) return true
    if (t.family === 'style') {
      const partial = keyOf(join(dirname(cand), '_' + basename(cand)))
      if (partial === t.key || stripExt(partial) === tNoExt) return true
    }
    if (!fromIsStyle) return false
  }
  // Aliased or bare specifier (@/components/Foo, ~/lib/x, src/utils): compare trailing segments.
  const segs = spec.split('/').filter(Boolean)
  if (!segs.length) return false
  let last = stripExt(segs[segs.length - 1])
  let prevIdx = segs.length - 2
  if (t.isIndex && last === 'index') { last = segs[segs.length - 2] ?? ''; prevIdx-- }
  if (t.family === 'style') last = last.replace(/^_/, '')
  if (!t.names.has(last) && !t.names.has(segs[segs.length - 1])) return false
  if (segs.length === 1) return fromIsStyle // a lone bare name in JS is a package
  const prev = segs[prevIdx]
  if (!prev || /^[@~#$]/.test(prev) || prev === 'src') return true
  return prev === (t.isIndex ? t.parentFolder : t.folder)
}

function lineMatches(t: Target, line: string, fromAbs: string): boolean {
  const trimmed = line.trim()
  if (!trimmed || line.length > MAX_LINE) return false
  const fromExt = extname(fromAbs).slice(1).toLowerCase()
  switch (t.family) {
    case 'js':
    case 'style':
    case 'other': {
      if (!IMPORTISH.test(line)) return false
      const fromIsStyle = STYLE_EXTS.includes(fromExt)
      for (const m of line.matchAll(QUOTED)) if (specMatches(t, m[2], fromAbs, fromIsStyle)) return true
      return false
    }
    case 'py': {
      const from = trimmed.match(/^from\s+(\.*)([\w.]*)\s+import\s+(.+)$/)
      if (from) {
        const mod = from[2].split('.').filter(Boolean)
        if (mod.length && t.names.has(mod[mod.length - 1])) return true
        const imported = from[3].replace(/[()]/g, '').split(',').map((s) => s.trim().split(/\s+/)[0])
        return imported.some((n) => t.names.has(n)) && (mod.length === 0 ? true : mod[mod.length - 1] === (t.isIndex ? t.parentFolder : t.folder))
      }
      const imp = trimmed.match(/^import\s+(.+)$/)
      if (!imp) return false
      return imp[1].split(',').some((part) => {
        const segs = part.trim().split(/\s+/)[0].split('.')
        return t.names.has(segs[segs.length - 1])
      })
    }
    case 'go': {
      const m = trimmed.match(/^(?:import\s+)?(?:[\w.]+\s+)?"([^"]+)"$/) ?? trimmed.match(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/)
      if (!m) return false
      const segs = m[1].split('/')
      if (segs[segs.length - 1] !== t.folder) return false
      return segs.length < 2 || segs[segs.length - 2] === t.parentFolder || !t.parentFolder
    }
    case 'jvm':
    case 'cs': {
      if (/^(\/\/|\/?\*|#)/.test(trimmed)) return false
      const word = [...t.names][0]
      return new RegExp(`(^|[^\\w])${escapeRe(word)}([^\\w]|$)`).test(line)
    }
    case 'rust': {
      if (trimmed.startsWith('//')) return false
      const n = escapeRe([...t.names][0])
      if (new RegExp(`\\bmod\\s+${n}\\s*[;{]`).test(line)) return true
      if (/^(pub(\([^)]*\))?\s+)?use\s/.test(trimmed) && new RegExp(`\\b${n}\\b`).test(line)) return true
      return new RegExp(`\\b${n}::`).test(line)
    }
    case 'c': {
      const m = trimmed.match(/^#\s*include\s*[<"]([^>"]+)[>"]/)
      if (!m) return false
      const spec = norm(m[1])
      if (spec.startsWith('.')) return keyOf(resolve(dirname(fromAbs), spec)) === t.key
      return spec === [...t.names][0] || spec.endsWith('/' + [...t.names][0])
    }
  }
}

// ── Search back ends ──

type Hit = { abs: string; line: number; text: string }

function run(cmd: string, args: string[], cwd: string): Promise<{ stdout: string; code: number }> {
  return new Promise((done, fail) => {
    execFile(cmd, args, { cwd, timeout: GREP_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return done({ stdout, code: 0 })
      const e = err as Error & { code?: unknown; killed?: boolean }
      if (e.killed) return fail(new Error(`${cmd} timed out after ${GREP_TIMEOUT_MS / 1000}s`))
      if (e.code === 1 && !stderr.trim()) return done({ stdout, code: 1 })
      fail(new Error(stderr.trim() || e.message))
    })
  })
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    return (await run('git', ['rev-parse', '--is-inside-work-tree'], cwd)).stdout.trim() === 'true'
  } catch {
    return false
  }
}

async function gitGrep(cwd: string, t: Target): Promise<Hit[]> {
  const args = ['grep', '-n', '-I', '-z', '-w', '-F', '--untracked', '--no-color']
  for (const term of t.terms) args.push('-e', term)
  args.push('--', ...REFERRER_EXTS[t.family].map((e) => `*.${e}`), ...EXCLUDE_PATHSPECS)
  const { stdout } = await run('git', args, cwd)
  const hits: Hit[] = []
  for (const rec of stdout.split('\n')) {
    if (!rec) continue
    const [path, line, ...rest] = rec.split('\0')
    if (!path || !line) continue
    hits.push({ abs: resolve(cwd, path), line: Number(line), text: rest.join('\0') })
  }
  return hits
}

type ScanIndex = { files: string[]; truncated: boolean }

async function scanIndex(cwd: string, deadline: number): Promise<ScanIndex> {
  const files: string[] = []
  let truncated = false
  const walk = async (dir: string): Promise<void> => {
    if (files.length >= SCAN_MAX_FILES || Date.now() > deadline) { truncated = true; return }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(join(dir, e.name))
      } else if (e.isFile()) {
        if (files.length >= SCAN_MAX_FILES) { truncated = true; return }
        files.push(join(dir, e.name))
      }
    }
  }
  await walk(cwd)
  return { files, truncated }
}

async function scanGrep(index: ScanIndex, t: Target, deadline: number): Promise<Hit[]> {
  const exts = new Set(REFERRER_EXTS[t.family])
  const words = t.terms.map((w) => new RegExp(`(^|[^\\w])${escapeRe(w)}([^\\w]|$)`))
  const hits: Hit[] = []
  for (const abs of index.files) {
    if (Date.now() > deadline) break
    if (!exts.has(extname(abs).slice(1).toLowerCase())) continue
    try {
      if ((await stat(abs)).size > SCAN_MAX_BYTES) continue
      const content = await readFile(abs, 'utf8')
      if (!t.terms.some((w) => content.includes(w))) continue
      content.split(/\r?\n/).forEach((text, i) => {
        if (words.some((re) => re.test(text))) hits.push({ abs, line: i + 1, text })
      })
    } catch {
      // Unreadable file: skip.
    }
  }
  return hits
}

function outPath(cwd: string, abs: string): string {
  const rel = relative(cwd, abs)
  return !rel.startsWith('..') && !isAbsolute(rel) ? norm(rel) : norm(abs)
}

function collect(cwd: string, t: Target, hits: Hit[]): BlastRadiusFile {
  const seen = new Set<string>()
  const dependents: Dependent[] = []
  let truncated = false
  for (const h of hits) {
    const key = keyOf(h.abs)
    if (key === t.key || seen.has(key)) continue
    if (norm(h.abs).split('/').some((seg) => SKIP_DIRS.has(seg))) continue
    const text = h.text.replace(/\r$/, '')
    if (!lineMatches(t, text, h.abs)) continue
    seen.add(key)
    if (dependents.length >= MAX_DEPENDENTS) { truncated = true; break }
    dependents.push({ path: outPath(cwd, h.abs), line: h.line, text: text.trim().slice(0, 200) })
  }
  return { path: outPath(cwd, t.abs), dependents, truncated }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    })
  )
  return out
}

/** Files that import or reference each of `files`. Never throws; problems go in `error`. */
export async function findDependents(cwd: string, files: string[]): Promise<BlastRadiusResult> {
  const errors: string[] = []
  try {
    if (!(await stat(cwd).catch(() => null))?.isDirectory()) return { files: [], error: tr('mainDeps.folderNotFound', { cwd }) }
    const unique = [...new Map(files.map((f) => [keyOf(isAbsolute(f) ? f : resolve(cwd, f)), f])).values()]
    if (unique.length > MAX_INPUT_FILES) errors.push(tr('mainDeps.onlyFirstFiles', { max: MAX_INPUT_FILES, total: unique.length }))
    const inputs = unique.slice(0, MAX_INPUT_FILES)
    const git = await isGitRepo(cwd)
    const deadline = Date.now() + SCAN_BUDGET_MS
    let index: ScanIndex | null = null
    if (!git) {
      index = await scanIndex(cwd, deadline)
      if (index.truncated) errors.push(tr('mainDeps.notGitPartial'))
    }
    const results = await mapLimit(inputs, git ? CONCURRENCY : 1, async (file): Promise<BlastRadiusFile> => {
      const t = makeTarget(cwd, file)
      if (!t) return { path: outPath(cwd, isAbsolute(file) ? file : resolve(cwd, file)), dependents: [], truncated: false }
      try {
        const hits = git ? await gitGrep(cwd, t) : await scanGrep(index!, t, deadline)
        return collect(cwd, t, hits)
      } catch (e) {
        errors.push(`${basename(t.abs)}: ${e instanceof Error ? e.message : String(e)}`)
        return { path: outPath(cwd, t.abs), dependents: [], truncated: false }
      }
    })
    return errors.length ? { files: results, error: errors.join('\n') } : { files: results }
  } catch (e) {
    return { files: [], error: e instanceof Error ? e.message : String(e) }
  }
}
