import type { Requirements } from '../../shared/events'
import { tr } from '../../shared/i18n'

export type SessionKind = 'coding' | 'review' | 'planning' | 'prd' | 'blank'

export const KINDS: { kind: SessionKind; icon: string; title: string; blurb: string }[] = [
  { kind: 'coding', icon: 'code', title: tr('launch.kinds.coding.title'), blurb: tr('launch.kinds.coding.blurb') },
  { kind: 'review', icon: 'git-pull-request', title: tr('launch.kinds.review.title'), blurb: tr('launch.kinds.review.blurb') },
  { kind: 'planning', icon: 'lightbulb', title: tr('launch.kinds.planning.title'), blurb: tr('launch.kinds.planning.blurb') },
  { kind: 'prd', icon: 'book', title: tr('launch.kinds.prd.title'), blurb: tr('launch.kinds.prd.blurb') },
  { kind: 'blank', icon: 'comment-discussion', title: tr('launch.kinds.blank.title'), blurb: tr('launch.kinds.blank.blurb') }
]

export const KIND_ICON: Record<SessionKind, string> = Object.fromEntries(KINDS.map((k) => [k.kind, k.icon])) as Record<SessionKind, string>

export type LaunchFields = {
  ticket?: string
  describe?: string
  startWith?: 'plan' | 'code'
  branch?: string
  pr?: { number: number; title: string; url: string; repo?: string }
  worktree?: boolean
  topic?: string
  context?: string
  confluence?: boolean
}

export type PendingStart = { prompt: string; display: string; plan?: boolean; requirements?: Partial<Requirements> }

/**
 * The Jira key in a ticket reference: a bare key (NSD-1234, any case) or any Jira link that names
 * one (…/browse/NSD-1234, board links with ?selectedIssue=NSD-1234, …/issues/NSD-1234).
 */
export function jiraKey(t: string): string | null {
  const s = t.trim()
  const bare = s.match(/^([A-Za-z][A-Za-z0-9]+-\d+)$/)
  if (bare) return bare[1].toUpperCase()
  if (!/^https?:\/\//i.test(s) || !/atlassian\.net|\/jira\/|\/browse\//i.test(s)) return null
  const m = s.match(/(?:selectedIssue=|\/browse\/|\/issues\/)([A-Z][A-Z0-9]+-\d+)/) ?? s.match(/\b([A-Z][A-Z0-9]+-\d+)\b/)
  return m ? m[1] : null
}
const isJira = (t: string) => !!jiraKey(t)
const isGitHubIssue = (t: string) => /github\.com\/.+\/issues\/\d+/.test(t) || /^#?\d+$/.test(t.trim())
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)

/** Turn the launcher form into the session's title, first message and requirements. */
export function buildLaunch(kind: SessionKind, f: LaunchFields): { title: string; start?: PendingStart; requirements?: Partial<Requirements> } {
  switch (kind) {
    case 'coding': {
      const ticket = f.ticket?.trim()
      const key = ticket ? jiraKey(ticket) : null
      const plan = f.startWith !== 'code'
      const source = ticket
        ? key
          ? `Jira ticket ${key}${/^https?:/i.test(ticket) ? ` (${ticket})` : ''}.`
          : isGitHubIssue(ticket)
            ? `GitHub issue ${ticket}.`
            : `this ticket: ${ticket}.`
        : `this: ${f.describe?.trim()}`
      const branch = f.branch?.trim()
      // With a ticket, the first job is to load it and the code it touches into context.
      const gather = ticket
        ? [
            'First get the full picture before planning anything:',
            key
              ? `1. Read ${key} with the Atlassian connector: summary, description, acceptance criteria, comments, subtasks, linked issues, and any Confluence pages or designs it links to.`
              : isGitHubIssue(ticket)
                ? '1. Read the issue with `gh issue view` (with comments), and anything it links to.'
                : '1. Fetch the ticket and anything it links to.',
            `2. Find the code it touches: search the codebase for the features, entities, endpoints and screens it names, and check \`git log --all --grep\`, branches and PRs mentioning ${key ?? 'the ticket'} for earlier work.`,
            '3. Read the most relevant files and call pin_file on each, so they show up in Glassbox as the ticket’s context.',
            '4. Summarise the ticket and where it lands in the code in a few lines.'
          ].join('\n')
        : ''
      const prompt = [
        `Implement ${source}`,
        f.describe?.trim() && ticket ? `Extra notes from me: ${f.describe.trim()}` : '',
        gather,
        'Call set_acceptance_criteria with the acceptance criteria before you start (if there are none, write your own and log that as an assumption). Keep each criterion’s status up to date as you work, and only mark one tested with evidence: the test or command that proves it.',
        branch ? `Work on a new branch \`${branch}\` created from the up-to-date default branch.` : '',
        plan ? 'Start by proposing a plan for my approval. Don’t change anything until I approve it.' : 'Go straight into implementing it, logging decisions as you go.',
        'Run the relevant tests before you finish.'
      ]
        .filter(Boolean)
        .join('\n\n')
      return {
        title: ticket ? (key ?? ticket.replace(/^https?:\/\/\S+\/(browse|issues)\//, '')) : (f.describe ?? tr('launch.codingTitle')).slice(0, 40),
        start: { prompt, display: ticket ? tr(plan ? 'launch.implementDisplayPlanFirst' : 'launch.implementDisplay', { ticket: key ?? ticket }) : prompt.slice(0, 200), plan },
        requirements: ticket && isJira(ticket) ? { connectors: ['claude.ai Atlassian'] } : undefined
      }
    }
    case 'review': {
      const pr = f.pr!
      const prompt = [
        `Review GitHub pull request #${pr.number} (${pr.url}): “${pr.title}”. You’re reviewing, not fixing, so don’t edit any files.`,
        `1. Get the context: \`gh pr view ${pr.url}\` (description, linked ticket), \`gh pr diff ${pr.url}\`, then read the changed files and what they depend on.${f.worktree ? ' The PR is checked out in this folder, so you can run its tests and build.' : ''}`,
        '2. Call set_current_task with your review steps.',
        '3. Report each issue the moment you find it with report_finding: severity (blocker, major, minor, nit or question), file and line, and a suggested fix where you have one.',
        '4. Check the change against its ticket or description, and note anything missing or untested.',
        '5. Finish with what the PR does, the overall risk, and your recommendation: approve, request changes or comment. Don’t post anything to GitHub unless I ask.'
      ].join('\n\n')
      return { title: pr.repo ? tr('launch.reviewTitleRepo', { repo: pr.repo.split('/')[1], number: pr.number }) : tr('launch.reviewTitle', { number: pr.number }), start: { prompt, display: tr('launch.reviewDisplay', { number: pr.number, title: pr.title }) } }
    }
    case 'planning': {
      const prompt = [
        `Let’s think this through together: ${f.topic?.trim()}`,
        f.context?.trim() ? `Context: ${f.context.trim()}` : '',
        'This is a planning session, so don’t change any files. Work like a thoughtful tech lead: explore the codebase where it helps, ask me the questions that matter with log_decision (kind question), sketch options with show_diagram, and log decisions and assumptions as you go.',
        'Finish with two or three options, their trade-offs, and your recommendation.'
      ]
        .filter(Boolean)
        .join('\n\n')
      return { title: (f.topic ?? tr('launch.planningTitle')).slice(0, 40), start: { prompt, display: tr('launch.planDisplay', { topic: f.topic?.trim() }), plan: true } }
    }
    case 'prd': {
      const title = f.topic?.trim() ?? tr('launch.newFeature')
      const prompt = [
        `We’re writing a product requirements doc for: ${title}`,
        f.context?.trim() ? `Context and links: ${f.context.trim()}` : '',
        'Don’t change any code. Interview me first: ask the questions that matter most with log_decision (kind question), a few at a time, and look at the codebase and existing docs for context.',
        `Then draft the PRD with: the problem and evidence for it; users and what they’re trying to do; goals and non-goals; requirements, each with acceptance criteria; UX flows (use show_diagram); data and API impact; risks and open questions; rollout and how we’ll measure success. Write it to docs/prd/${slug(title) || 'prd'}.md, and ask before overwriting an existing file.`,
        f.confluence ? 'When I approve the draft, publish it to Confluence with the Atlassian connector and give me the link.' : ''
      ]
        .filter(Boolean)
        .join('\n\n')
      return {
        title: tr('launch.prdTitle', { title }).slice(0, 40),
        start: { prompt, display: tr('launch.prdDisplay', { title }) },
        requirements: f.confluence ? { connectors: ['claude.ai Atlassian'] } : undefined
      }
    }
    case 'blank':
      return { title: tr('launch.newSession') }
  }
}
