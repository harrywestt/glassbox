// node-pty's macOS and Linux prebuilds ship spawn-helper without the execute bit, so opening a
// terminal fails with "posix_spawnp failed". Runs after `npm install` to set it. Windows uses
// ConPTY and has no spawn-helper, so there's nothing to do there.
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform === 'win32') process.exit(0)

const pty = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'node-pty')
const helpers = [join(pty, 'build', 'Release', 'spawn-helper')]
const prebuilds = join(pty, 'prebuilds')
if (existsSync(prebuilds)) for (const dir of readdirSync(prebuilds)) helpers.push(join(prebuilds, dir, 'spawn-helper'))

for (const file of helpers) {
  if (!existsSync(file)) continue
  try {
    chmodSync(file, statSync(file).mode | 0o755)
  } catch (err) {
    // Never fail the install over this; the terminal is the only thing that needs it.
    console.warn(`glassbox: could not make ${file} executable: ${err}`)
  }
}
