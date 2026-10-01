import { relPath } from './lib'
import { diffLines } from './linediff'
import { EDIT_TOOLS, isClaudeOwnFile, type SessionState } from './session'
import { editText } from './edits'

export type Dependency = { name: string; version: string; ecosystem: 'npm' | 'NuGet' | 'PyPI' | 'Go'; file: string }
export type RadarItem = { file: string; detail: string; toolId: string }
export type Radar = {
  dependencies: Dependency[]
  envVars: RadarItem[]
  config: RadarItem[]
  migrations: RadarItem[]
  contracts: RadarItem[]
  secrets: RadarItem[]
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, 'API secret key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/AIza[0-9A-Za-z_-]{35}/, 'Google API key'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key'],
  [/\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i, 'hard-coded credential'],
  [/Password=[^;"'\s]{4,}/i, 'password in a connection string']
]

/** What looks like a secret in some text, if anything. */
export function secretIn(text: string): string | null {
  for (const [re, label] of SECRET_PATTERNS) if (re.test(text)) return label
  return null
}

const ENV_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[["']([A-Z][A-Z0-9_]+)["']\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]+)/g,
  /os\.environ(?:\.get)?[[(]["']([A-Z][A-Z0-9_]+)["']/g,
  /os\.getenv\(["']([A-Z][A-Z0-9_]+)["']/g,
  /Environment\.GetEnvironmentVariable\("([A-Z][A-Z0-9_]+)"/g,
  /env::var\("([A-Z][A-Z0-9_]+)"/g,
  /os\.Getenv\("([A-Z][A-Z0-9_]+)"/g
]
const COMMON_ENV = new Set(['NODE_ENV', 'PATH', 'HOME', 'CI', 'DEBUG'])

const isMigration = (p: string) => /(^|\/)(migrations?|alembic\/versions|prisma\/migrations|db\/migrate)\//i.test(p) || /\.sql$/i.test(p)
const isConfig = (p: string) => /(^|\/)(appsettings[\w.]*\.json|\.env[\w.]*|[\w.-]+\.config|config\/[\w./-]+\.(json|ya?ml|toml))$/i.test(p) || /docker-compose[\w.-]*\.ya?ml$/i.test(p)
const isContractPath = (p: string) => /(controller|endpoint|contract|dto|\bapi\b|routes?|\.proto$|openapi|swagger|graphql|schema)/i.test(p) && !/test|spec/i.test(p)
const SIGNATURE = /^\s*(export\s+(default\s+)?(async\s+)?(function|const|class|interface|type|enum)\s+\w+|public\s+(static\s+)?[\w<>[\],?\s]+\s+\w+\s*\(|public\s+(record|class|interface|enum)\s+\w+|\[(Http(Get|Post|Put|Delete|Patch)|Route)\b|router\.(get|post|put|delete|patch)\(|app\.(get|post|put|delete|patch|Map(Get|Post|Put|Delete))\()/

/** Risky kinds of change in Claude's edits this session. */
export function changeRadar(s: SessionState, cwd: string): Radar {
  const radar: Radar = { dependencies: [], envVars: [], config: [], migrations: [], contracts: [], secrets: [] }
  const seenDep = new Set<string>()
  const seenEnv = new Set<string>()
  const seenFile = { config: new Set<string>(), migrations: new Set<string>(), contracts: new Set<string>() }
  for (const f of s.files) {
    const call = s.toolCalls[f.toolId]
    if (!EDIT_TOOLS.has(f.tool) || !call || call.status === 'error' || isClaudeOwnFile(f.path)) continue
    const rel = relPath(cwd, f.path)
    const { before, after } = editText(call)
    const lines = diffLines(before, after)
    const added = lines.filter((l) => l.t === '+').map((l) => l.s)
    const removed = lines.filter((l) => l.t === '-').map((l) => l.s)
    const addedText = added.join('\n')

    // Dependencies.
    const dep = (name: string, version: string, ecosystem: Dependency['ecosystem']) => {
      const k = `${ecosystem}:${name}`
      if (!seenDep.has(k)) {
        seenDep.add(k)
        radar.dependencies.push({ name, version: version.replace(/^[~^>=<\s]+/, ''), ecosystem, file: rel })
      }
    }
    if (/(^|\/)package\.json$/.test(rel))
      for (const l of added) {
        const m = l.match(/^\s*"(@?[a-z0-9][\w.-]*(?:\/[\w.-]+)?)"\s*:\s*"([~^]?\d[\w.+-]*)"/i)
        if (m) dep(m[1], m[2], 'npm')
      }
    if (/\.(cs|fs|vb)proj$|Directory\.Packages\.props$/.test(rel))
      for (const m of addedText.matchAll(/<Package(?:Reference|Version)\s+Include="([^"]+)"\s+Version="([^"]+)"/g)) dep(m[1], m[2], 'NuGet')
    if (/requirements[\w.-]*\.txt$/.test(rel))
      for (const l of added) {
        const m = l.match(/^\s*([A-Za-z0-9_.-]+)\s*[=~><]=\s*([\w.]+)/)
        if (m) dep(m[1], m[2], 'PyPI')
      }
    if (/(^|\/)go\.mod$/.test(rel))
      for (const l of added) {
        const m = l.match(/^\s*(?:require\s+)?([\w.-]+\.[\w./-]+)\s+(v[\w.+-]+)/)
        if (m) dep(m[1], m[2], 'Go')
      }

    // Environment variables read by the new code.
    for (const re of ENV_PATTERNS)
      for (const m of addedText.matchAll(re)) {
        if (COMMON_ENV.has(m[1]) || seenEnv.has(m[1])) continue
        seenEnv.add(m[1])
        radar.envVars.push({ file: rel, detail: m[1], toolId: call.id })
      }
    if (/(^|\/)\.env[\w.]*$/.test(rel))
      for (const l of added) {
        const m = l.match(/^\s*([A-Z][A-Z0-9_]+)\s*=/)
        if (m && !seenEnv.has(m[1])) {
          seenEnv.add(m[1])
          radar.envVars.push({ file: rel, detail: m[1], toolId: call.id })
        }
      }

    if (isConfig(rel) && !seenFile.config.has(rel)) {
      seenFile.config.add(rel)
      radar.config.push({ file: rel, detail: `${added.length} line${added.length === 1 ? '' : 's'} added`, toolId: call.id })
    }
    if (isMigration(rel) && !seenFile.migrations.has(rel)) {
      seenFile.migrations.add(rel)
      radar.migrations.push({ file: rel, detail: call.name === 'Write' && !before ? 'new migration' : 'migration changed', toolId: call.id })
    }

    // Public signatures removed or changed (a new one on its own isn't breaking).
    const changedSig = removed.filter((l) => SIGNATURE.test(l))
    if ((changedSig.length || (isContractPath(rel) && added.some((l) => SIGNATURE.test(l)))) && !seenFile.contracts.has(rel)) {
      seenFile.contracts.add(rel)
      radar.contracts.push({ file: rel, detail: changedSig.length ? `changed or removed: ${changedSig[0].trim().slice(0, 80)}` : 'new endpoint or contract', toolId: call.id })
    }

    for (const l of added) {
      const what = secretIn(l)
      if (what) radar.secrets.push({ file: rel, detail: what, toolId: call.id })
    }
  }
  return radar
}

export const radarCount = (r: Radar) => r.dependencies.length + r.envVars.length + r.config.length + r.migrations.length + r.contracts.length + r.secrets.length
