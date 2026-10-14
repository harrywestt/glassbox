/**
 * Auto model: which model a message goes to. Opus writes the code and does the thinking (planning,
 * design, debugging, reviews, any change to the project); Sonnet does the work around it (answering
 * questions, running tests, builds and deploys, driving the Browser, QA); Haiku the one-word replies
 * and git chores. Instant rules on the message, no extra model call.
 *
 * Switching model has a cost: the new model hasn't cached the conversation, so its first step reads
 * all of it at full price. Long mechanical work (a test run, a QA pass) takes many steps, so the
 * cheaper model pays that back and it switches whatever the size; a short reply in a long
 * conversation stays where it is. A conversation too long for a model's window never goes to it.
 */

export type Tier = 'haiku' | 'sonnet' | 'opus'
export type Pick = { tier: Tier; reason: string }

const RANK: Record<Tier, number> = { haiku: 0, sonnet: 1, opus: 2 }

/** Wants real thinking. */
const DEEP = /\b(why (?:is|does|did|do|isn'?t|doesn'?t|didn'?t|won'?t|are|can'?t)|architect\w*|design\w*|refactor\w*|debug\w*|investigat\w*|root cause|race condition|deadlock|memory leak|security|vulnerab\w*|performance|optimi[sz]\w*|migrat\w*|trade-?offs?|approach|strateg\w*|plan\b|planning|spec\b|prd\b|rewrite|redesign|tricky|complex\w*|think (?:hard|carefully|it through)|ultrathink)\b/i
/** Asks for a change to the project: code gets written. */
const CODE = /\b(add|implement\w*|build|create|fix\w*|change|update|edit|write|make|remove|delete|rename|move|wire|hook up|support|handle|replace|convert|extract|split|merge (?:the|these)|style|restyle|tidy|clean ?up|bump|upgrade)\b/i
/** A one-word reply. */
const TRIVIAL = /^(?:y(?:es|ep|eah)?|ok(?:ay)?|sure|thanks?(?: you)?|ta|cheers|go(?: ahead| for it)?|continue|carry on|keep going|do it|sounds good|perfect|great|nice|lgtm|done|1|2|3|a|b|c)[\s.!]*$/i
/** Git chores. */
const CHORE = /^(?:(?:please |can you |now )?(?:commit|push|pull|rebase|stash|git \w+|open (?:a |the )?pr|create (?:a |the )?pr|raise (?:a |the )?pr|merge (?:it|the pr|this))\b)[^]{0,80}$/i
/** Mechanical work with many steps: running, testing, checking, deploying. */
const RUN = /^(?:(?:please |can you |now |ok,? |okay,? )?(?:run|rerun|re-run|test|retest|qa|check|verify|try|deploy|install|start|restart|watch|open|load|click|screenshot|record|lint|format)\b)/i
/** A question about the code or the project, not a change to it. */
const QUESTION = /^(?:what|where|which|who|when|how (?:does|do|is|are|many|much)|is there|are there|does|do we|can you (?:explain|tell|show|find|list)|explain|show me|find|list|summari[sz]e|tell me|look (?:at|for)|read)\b/i

/** Conversations bigger than this switch only to a model with room for them. */
const SMALL_WINDOW = 180_000
/** Below this a switch re-reads little, so it's always worth it. */
const CHEAP_TO_SWITCH = 40_000

export function pickTier(m: { text: string; plan: boolean; kind?: string; contextTokens: number; current?: Tier; firstMessage: boolean; wideSonnet: boolean }): Pick & { long?: boolean } {
  const text = m.text.trim()
  let want: Pick & { long?: boolean }
  if (m.plan) want = { tier: 'opus', reason: 'planning' }
  else if (m.kind === 'review' || m.kind === 'planning' || m.kind === 'prd') want = { tier: 'opus', reason: m.kind === 'review' ? 'a code review' : 'shaping an idea' }
  else if (TRIVIAL.test(text)) want = { tier: 'haiku', reason: 'a quick reply' }
  else if (CHORE.test(text)) want = { tier: 'haiku', reason: 'a git chore' }
  else if (m.kind === 'qa' || m.kind === 'qa-deep') want = DEEP.test(text) || text.length > 1500 ? { tier: 'opus', reason: 'working out what to test' } : { tier: 'sonnet', reason: 'testing', long: true }
  else if (text.length > 1500 || DEEP.test(text)) want = { tier: 'opus', reason: text.length > 1500 ? 'a long, detailed request' : 'it needs careful reasoning' }
  else if (RUN.test(text) && !CODE.test(text.replace(RUN, ''))) want = { tier: 'sonnet', reason: 'running and checking things', long: true }
  else if ((QUESTION.test(text) || /\?\s*$/.test(text)) && !CODE.test(text)) want = { tier: 'sonnet', reason: 'a question' }
  else want = { tier: 'opus', reason: 'writing code' }

  // A one-word reply in a long conversation isn't worth a model with less room; Haiku has the least.
  if (want.tier === 'haiku' && m.contextTokens > 120_000) want = { ...want, tier: 'sonnet' }
  if (m.contextTokens > SMALL_WINDOW && want.tier !== 'opus' && !(want.tier === 'sonnet' && m.wideSonnet))
    want = { tier: 'opus', reason: 'the conversation is too long for a smaller model' }

  const current = m.current
  if (!current || RANK[want.tier] >= RANK[current]) return want
  // Moving down pays off when the conversation is small, new work is starting, or the work ahead
  // is long (many steps at the cheaper price); a short reply in a long conversation stays put.
  if (m.firstMessage || m.contextTokens < CHEAP_TO_SWITCH || want.long) return want
  return { tier: current, reason: 'a short reply, and switching would re-read the whole conversation' }
}

/** The model id to ask for: the 1M-context version when the conversation needs the room (and the account has it). */
export function modelFor(tier: Tier, available: string[], contextTokens: number): string {
  const wide = `${tier}[1m]`
  return contextTokens > 150_000 && available.includes(wide) ? wide : tier
}
