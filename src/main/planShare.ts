import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** A file name from the plan's title: "Refunds from the order page" → "refunds-from-the-order-page". */
const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'plan'

/** Saves the approved plan into the project (docs/plans/<title>.md), as plain Markdown. Returns its path. */
export function savePlan(cwd: string, title: string, markdown: string): string {
  const dir = join(cwd, 'docs', 'plans')
  mkdirSync(dir, { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  const file = join(dir, `${date}-${slug(title)}.md`)
  writeFileSync(file, markdown.endsWith('\n') ? markdown : markdown + '\n', 'utf8')
  return file
}

const MARK = '<!-- glassbox-plan -->'

/**
 * Puts the plan in the branch's pull request description (with the gh CLI, no model): in a folded
 * section at the end, replacing one added before.
 */
export async function addPlanToPr(cwd: string, markdown: string): Promise<{ url?: string; error?: string }> {
  try {
    const { stdout } = await exec('gh', ['pr', 'view', '--json', 'url,body'], { cwd, windowsHide: true })
    const pr = JSON.parse(stdout) as { url: string; body: string }
    const before = (pr.body ?? '').split(MARK)[0].trimEnd()
    const section = `${MARK}\n<details>\n<summary>The plan</summary>\n\n${markdown.trim()}\n\n</details>\n${MARK}`
    const body = before ? `${before}\n\n${section}` : section
    await exec('gh', ['pr', 'edit', '--body', body], { cwd, windowsHide: true })
    return { url: pr.url }
  } catch (e) {
    const msg = String((e as { stderr?: string }).stderr || e)
    return { error: /no pull requests? found/i.test(msg) ? 'This branch has no pull request yet.' : msg.split('\n')[0] }
  }
}
