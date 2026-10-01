/**
 * Whether a shell command only reads: lists, prints, searches, or asks git about the repository.
 * Those run without asking you, as the Claude CLI's read-only commands do. Anything that could
 * write (a redirect, sed -i, find -delete, an unknown program) is not read-only. Guardrails still
 * check every command first.
 */

const READERS = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'echo', 'printf', 'pwd', 'cd', 'pushd', 'popd', 'which', 'where', 'whereis',
  'tree', 'stat', 'file', 'du', 'df', 'sort', 'uniq', 'cut', 'tr', 'nl', 'less', 'more', 'diff', 'cmp', 'basename', 'dirname', 'realpath', 'readlink', 'date', 'whoami', 'hostname',
  'uname', 'printenv', 'true', 'false', 'test', '[', 'jq', 'yq', 'column', 'fold', 'rev', 'tac', 'od', 'xxd', 'hexdump', 'md5sum', 'sha1sum', 'sha256sum', 'findstr',
  'get-childitem', 'gci', 'get-content', 'gc', 'select-string', 'sls', 'get-location', 'gl', 'test-path', 'get-item', 'gi', 'get-itemproperty', 'measure-object', 'measure',
  'select-object', 'select', 'sort-object', 'where-object', '?', 'format-table', 'ft', 'format-list', 'fl', 'out-string', 'get-command',
  'get-process', 'get-date', 'resolve-path', 'split-path', 'join-path', 'get-filehash', 'get-psdrive', 'write-output', 'write-host', 'convertto-json', 'convertfrom-json', 'set-location', 'sl'
])
const GIT_READS = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'describe', 'shortlog', 'grep', 'merge-base', 'cat-file', 'reflog', 'tag', 'remote', 'config', 'rev-list', 'name-rev', 'whatchanged', 'for-each-ref'])
/** Versions and help: `node --version`, `npm -v`, `dotnet --info`. */
const VERSION_ONLY = /^(--version|-v|-V|version|--help|-h|help|--info|--list-sdks|--list-runtimes)$/

/** Words split out of one simple command, quotes kept together. */
function words(cmd: string): string[] {
  return cmd.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g) ?? []
}

function simpleReads(cmd: string): boolean {
  let w = words(cmd.trim())
  // Shell keywords around a loop or condition, and leading variable assignments, aren't commands.
  while (w.length && (/^(do|then|else|elif|if|while|until|!|\{|\}|\(|\))$/.test(w[0]) || /^[A-Za-z_]\w*=/.test(w[0]))) w = w.slice(1)
  if (!w.length || /^(done|fi|esac|\}|\))$/.test(w[0])) return true
  if (w[0] === 'for') return true // `for f in …` (its $( ) parts are checked separately)
  const prog = w[0].replace(/^["']|["']$/g, '').replace(/\.exe$/i, '').split(/[\\/]/).pop()!.toLowerCase()
  const args = w.slice(1)
  if (prog === 'git') {
    const sub = args.find((a) => !a.startsWith('-'))?.toLowerCase()
    if (!sub || !GIT_READS.has(sub)) return false
    if (sub === 'branch' && args.some((a) => /^-(d|D|m|M|c|C|-delete|-move|-copy)$/.test(a))) return false
    // `git tag` lists; with a name it creates one.
    if (sub === 'tag' && args.some((a) => a !== 'tag' && a !== '-l' && a !== '--list' && !a.startsWith('-n'))) return false
    if (sub === 'remote' && args.some((a) => /^(add|remove|rm|rename|set-url|prune)$/.test(a))) return false
    if (sub === 'config' && !args.some((a) => /^(--get|--get-all|--list|-l)$/.test(a))) return false
    return true
  }
  if (prog === 'sed') return !args.some((a) => /^-[a-z]*i/.test(a) || a === '--in-place')
  if (prog === 'find') return !args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(a))
  if (READERS.has(prog)) return true
  return args.length === 1 && VERSION_ONLY.test(args[0])
}

export function isReadOnlyShell(command: string): boolean {
  let cmd = command.trim()
  if (!cmd || cmd.length > 4000) return false
  // Output sent anywhere but the null device or another stream is a write.
  const noNull = cmd.replace(/\d?>\s*(\/dev\/null|\$null|nul)\b/gi, '').replace(/\d?>&\d/g, '')
  if (/>|\btee\b|Out-File|Set-Content|Add-Content|New-Item|Remove-Item|Copy-Item|Move-Item|Rename-Item/i.test(noNull.replace(/"[^"]*"|'[^']*'/g, ''))) return false
  // Command substitutions must read too; then they stand in as plain words.
  for (let guard = 0; guard < 10 && /\$\(|`/.test(cmd); guard++) {
    const m = /\$\(([^()]*)\)|`([^`]*)`/.exec(cmd)
    if (!m) return false
    if (!isReadOnlyShell(m[1] ?? m[2] ?? '')) return false
    cmd = cmd.slice(0, m.index) + 'x' + cmd.slice(m.index + m[0].length)
  }
  if (/\$\(|`/.test(cmd)) return false
  // Each command in a pipeline or chain.
  const parts = cmd.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (q) => q.replace(/[;&|]/g, ' ')).split(/\s*(?:&&|\|\||;|\||&|\r?\n)\s*/)
  return parts.every((p) => simpleReads(p))
}
