// Checks every tr('…') key in src exists in src/shared/i18n/en-GB.json (a key used with { count }
// may exist as key_one / key_other), and lists keys in the file that nothing uses.
// Run: node scripts/check-i18n.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([a-z]:)/i, '$1')
const strings = JSON.parse(readFileSync(join(root, 'src/shared/i18n/en-GB.json'), 'utf8'))
const keys = new Set()
const walk = (node, prefix) => {
  for (const [k, v] of Object.entries(node)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') keys.add(key)
    else walk(v, key)
  }
}
walk(strings, '')

const files = []
const collect = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) collect(p)
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) files.push(p)
  }
}
collect(join(root, 'src'))

const used = new Set()
const problems = []
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  for (const m of src.matchAll(/\btr\(\s*'([a-zA-Z0-9_.]+)'/g)) {
    const key = m[1]
    used.add(key)
    if (!keys.has(key) && !keys.has(`${key}_other`)) problems.push(`${f.slice(root.length)}: missing ${key}`)
  }
}
const base = (k) => k.replace(/_(zero|one|two|few|many|other)$/, '')
const unused = [...keys].filter((k) => !used.has(k) && !used.has(base(k)))
for (const p of problems) console.log(p)
if (unused.length) console.log(`${unused.length} unused key(s): ${unused.slice(0, 30).join(', ')}${unused.length > 30 ? '…' : ''}`)
console.log(`${used.size} keys used, ${keys.size} in en-GB.json, ${problems.length} missing`)
process.exit(problems.length ? 1 : 0)
