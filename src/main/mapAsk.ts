import { query } from './claude'

/**
 * "Show me a feature" on the map. You ask in plain words ("how discount codes are applied"); a
 * read-only Claude run searches the code and answers with the modules and files involved, in
 * the order the work flows through them, so the map can show just that feature as numbered steps.
 * Answers are kept for the session, so asking again (or switching tabs) is instant.
 */

export type MapAskModule = { id: string; name: string; path: string }
export type MapAnswer = {
  question: string
  title: string
  summary: string
  steps: { name: string; modules: string[]; files: { path: string; why: string }[] }[]
  error?: string
  at: number
}

const cache = new Map<string, MapAnswer>()
const running = new Map<string, Promise<MapAnswer>>()

export async function askMap(root: string, question: string, modules: MapAskModule[], force = false): Promise<MapAnswer> {
  const q = question.trim()
  const key = `${root.toLowerCase()}|${q.toLowerCase()}`
  if (!force && cache.has(key)) return cache.get(key)!
  const inflight = running.get(key)
  if (inflight) return inflight
  const ids = new Set(modules.map((m) => m.id))
  const job = (async (): Promise<MapAnswer> => {
    const list = modules.map((m) => `- ${m.id} | ${m.name} | ${m.path || '(root)'}`).join('\n')
    const prompt = `An engineer looking at a map of this codebase asked: "${q}"

Find the code that answers this, using Grep, Glob and Read (search first; read only what you need). Then describe it as the steps the work flows through, in order (for example: the screen the user acts on, the API it calls, the rules applied, where it's stored). Name each step in 1 to 4 plain words, title case.

The map's modules (id | name | folder) are below. For each step, give the module ids it lives in and the 1 to 4 files that matter most there, each with under 12 words on what that file does for this feature. Use paths relative to the project root, with forward slashes.

Rules: 1 to 6 steps; only module ids from the list; "title" is the feature in 1 to 4 words; "summary" is one or two plain sentences an engineer new to the code would understand. Always show the code that exists for it, even if the feature is partial, unfinished or works differently from what they asked (say so in the summary). Return no steps only when nothing in the code relates to it at all.

Modules:
${list}

Reply with only JSON: {"title":"...","summary":"...","steps":[{"name":"...","modules":["<id>"],"files":[{"path":"...","why":"..."}]}]}`
    let text = ''
    try {
      for await (const msg of query({
        prompt,
        options: {
          cwd: root,
          model: 'sonnet',
          tools: ['Grep', 'Glob', 'Read'],
          allowedTools: ['Grep', 'Glob', 'Read'],
          settingSources: [],
          persistSession: false,
          maxTurns: 16,
          thinking: { type: 'disabled' }
        }
      })) {
        if (msg.type === 'result') text = msg.subtype === 'success' ? msg.result : ''
      }
      const raw = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? 'null') as {
        title?: string
        summary?: string
        steps?: { name?: string; modules?: string[]; files?: { path?: string; why?: string }[] }[]
      } | null
      if (!raw) throw new Error('Claude didn’t return an answer. Try asking a different way.')
      const used = new Set<string>()
      const steps = (raw.steps ?? [])
        .slice(0, 6)
        .map((st) => ({
          name: String(st.name ?? '').trim().slice(0, 40) || 'Step',
          // A module belongs to the first step that names it, so each box appears once.
          modules: (st.modules ?? []).filter((id) => ids.has(id) && !used.has(id) && (used.add(id), true)),
          files: (st.files ?? [])
            .slice(0, 4)
            .map((f) => ({ path: String(f.path ?? '').replace(/\\/g, '/').replace(/^\.\//, ''), why: String(f.why ?? '').trim().slice(0, 90) }))
            .filter((f) => f.path)
        }))
        .filter((st) => st.modules.length || st.files.length)
      const answer: MapAnswer = { question: q, title: String(raw.title ?? '').trim().slice(0, 40) || q.slice(0, 40), summary: String(raw.summary ?? '').trim().slice(0, 400), steps, at: Date.now() }
      cache.set(key, answer)
      return answer
    } catch (err) {
      return { question: q, title: q.slice(0, 40), summary: '', steps: [], error: String(err instanceof Error ? err.message : err), at: Date.now() }
    } finally {
      running.delete(key)
    }
  })()
  running.set(key, job)
  return job
}
