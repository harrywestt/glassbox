import strings from './i18n/en-GB.json'

/**
 * Every word Glassbox shows you comes from i18n/en-GB.json, through tr():
 *
 *   tr('composer.send')                          → "Send"
 *   tr('changes.files', { count: 3 })            → "3 files"     (picks files_one / files_other by count)
 *   tr('agents.stop', { name: 'Explore agent' }) → "Stop Explore agent"
 *
 * Keys are dotted paths into the JSON, grouped by screen. {name} placeholders are filled from vars.
 * A key with _one and _other variants is chosen by vars.count, using English plural rules.
 * Text sent to Claude (prompts, tool descriptions) is not UI and stays in the code.
 */

type Vars = Record<string, string | number | undefined | null>
type Tree = { [k: string]: string | Tree }

const LOCALE = 'en-GB'
const plurals = new Intl.PluralRules(LOCALE)
const missing = new Set<string>()

function lookup(key: string): string | undefined {
  let node: string | Tree | undefined = strings as Tree
  for (const part of key.split('.')) {
    if (node === undefined || typeof node === 'string') return undefined
    node = node[part]
  }
  return typeof node === 'string' ? node : undefined
}

export function tr(key: string, vars?: Vars): string {
  let text: string | undefined
  if (vars && typeof vars.count === 'number') text = lookup(`${key}_${plurals.select(vars.count)}`) ?? lookup(`${key}_other`)
  text ??= lookup(key)
  if (text === undefined) {
    // A missing key shows as itself, so it's obvious in the UI and easy to find.
    if (!missing.has(key)) missing.add(key), console.warn(`[i18n] missing key ${key}`)
    return key
  }
  return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (vars[name] === undefined || vars[name] === null ? m : String(vars[name]))) : text
}

/** Whether a key exists (for text that's optional, such as a hint only some items have). */
export const hasText = (key: string) => lookup(key) !== undefined
