// electron-builder afterPack hook: makes node-pty's spawn-helper executable inside the packaged
// app, before signing. electron-builder copies files with the mode they had, so a node_modules
// whose spawn-helper was never fixed would otherwise ship a terminal that can't start a shell.
// Windows builds have no spawn-helper (ConPTY), so this does nothing for them.
const { chmodSync, existsSync, readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName
  if (platform === 'win32') return
  const resources =
    platform === 'darwin' || platform === 'mas'
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(context.appOutDir, 'resources')
  const pty = join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty')
  const helpers = [join(pty, 'build', 'Release', 'spawn-helper')]
  const prebuilds = join(pty, 'prebuilds')
  if (existsSync(prebuilds)) for (const dir of readdirSync(prebuilds)) helpers.push(join(prebuilds, dir, 'spawn-helper'))
  const fixed = helpers.filter((f) => existsSync(f))
  for (const file of fixed) chmodSync(file, statSync(file).mode | 0o755)
  // A Mac or Linux build without it would open no terminals: stop the build rather than ship that.
  if (!fixed.length) throw new Error(`afterPack: node-pty's spawn-helper not found under ${pty}`)
}
