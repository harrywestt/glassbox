import type { Requirements } from '../../shared/events'
import { tr } from '../../shared/i18n'

/** `planning` is "Shape an idea" (it took in "Write a PRD"); `prd` stays only so older sessions keep their icon. */
export type SessionKind = 'coding' | 'review' | 'qa' | 'planning' | 'prd' | 'blank'

export const KINDS: { kind: SessionKind; icon: string; title: string; blurb: string }[] = [
  { kind: 'coding', icon: 'code', title: tr('launch.kinds.coding.title'), blurb: tr('launch.kinds.coding.blurb') },
  { kind: 'review', icon: 'git-pull-request', title: tr('launch.kinds.review.title'), blurb: tr('launch.kinds.review.blurb') },
  { kind: 'qa', icon: 'beaker', title: tr('launch.kinds.qa.title'), blurb: tr('launch.kinds.qa.blurb') },
  { kind: 'planning', icon: 'lightbulb', title: tr('launch.kinds.planning.title'), blurb: tr('launch.kinds.planning.blurb') },
  { kind: 'blank', icon: 'comment-discussion', title: tr('launch.kinds.blank.title'), blurb: tr('launch.kinds.blank.blurb') }
]

export const KIND_ICON: Record<SessionKind, string> = { ...Object.fromEntries(KINDS.map((k) => [k.kind, k.icon])), prd: 'book' } as Record<SessionKind, string>

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
  /** Shape an idea: end with a PRD. */
  prd?: boolean
  /** QA: what to test (tickets, a PR link, or a feature), where, and anything else it needs. */
  what?: string
  env?: 'local' | 'url'
  url?: string
  notes?: string
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
    // An older "Write a PRD" start is Shape an idea with the PRD switched on.
    case 'prd':
      return buildLaunch('planning', { ...f, prd: true })
    case 'planning': {
      const topic = f.topic?.trim() ?? tr('launch.newFeature')
      const prompt = [
        `Let’s shape this idea together: ${topic}`,
        f.context?.trim() ? `Context and links: ${f.context.trim()}` : '',
        'This is a thinking session, so don’t change any project files. Work like a thoughtful tech lead: explore the codebase and any docs where it helps, ask me the questions that matter with log_decision (kind question), a few at a time, sketch the options with show_diagram, and log decisions and assumptions as you go.',
        f.prd
          ? `When we’ve settled on a direction, write it up as a PRD: the problem and evidence for it; users and what they’re trying to do; goals and non-goals; requirements, each with acceptance criteria; UX flows (show_diagram); data and API impact; risks and open questions; rollout and how we’ll measure success. Write it to docs/prd/${slug(topic) || 'prd'}.md (ask before overwriting an existing file) and present_file it.${f.confluence ? ' When I approve it, publish it to Confluence with the Atlassian connector and give me the link.' : ''}`
          : 'Finish with two or three options, their trade-offs, and your recommendation. Then offer to write it up as a PRD.'
      ]
        .filter(Boolean)
        .join('\n\n')
      return {
        title: (f.prd ? tr('launch.prdTitle', { title: topic }) : topic).slice(0, 40),
        start: { prompt, display: tr('launch.planDisplay', { topic }), plan: !f.prd },
        requirements: f.prd && f.confluence ? { connectors: ['claude.ai Atlassian'] } : undefined
      }
    }
    case 'qa': {
      const what = f.what?.trim() ?? ''
      const keys = [...new Set(what.split(/[\s,]+/).map((t) => jiraKey(t)).filter((k): k is string => !!k))]
      const pr = what.match(/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/)?.[0]
      const where = f.env === 'url' && f.url?.trim() ? f.url.trim() : null
      const name = keys.length ? keys.join(', ') : pr ? `PR ${pr.split('/').pop()}` : what.slice(0, 40)
      const prompt = [
        `QA this for me: ${what}`,
        where ? `Test it on ${where}.` : 'Test it locally: start the app with start_app (it runs the project’s services, as my Run all button does) and use what it opens.',
        f.notes?.trim() ? `Notes (accounts, test data, anything else): ${f.notes.trim()}` : '',
        'You’re testing, not fixing: don’t change the project’s code. Glassbox only lets you write your report, under .glassbox/qa/.',
        [
          '1. Understand what to test. ' +
            (keys.length ? `Read ${keys.join(', ')} with the Atlassian connector: description, acceptance criteria, comments, designs and linked issues. ` : '') +
            (pr ? `Read the PR with \`gh pr view ${pr}\` and \`gh pr diff ${pr}\`. ` : '') +
            'Look at the code for the screens, endpoints and rules involved (read only), so you know where to go and what should happen.',
          '2. Write the test plan: call set_acceptance_criteria with one criterion per test case. Cover the happy paths, edge cases, validation and error messages, empty and loading states, permissions or roles where they matter, and anything nearby the change could break. Then call check_in with the plan in a few lines, asking me to approve or adjust it, and don’t run anything before I answer.',
          where
            ? `3. Open ${where} in the Glassbox Browser (browser_open). If it needs signing in, call check_in asking me to sign in in the Browser tab and to answer when I’m in. Never ask for a password and never type credentials yourself.`
            : '3. Start the app with start_app and wait until it’s up. If it needs signing in, call check_in asking me to sign in in the Browser tab and to answer when I’m in. Never ask for a password and never type credentials yourself.',
          '4. Run each case in the Glassbox Browser: browser_snapshot to read the page, browser_click and browser_type to use it, browser_eval to check details, and browser_screenshot as evidence for anything that matters. Show progress with show_progress (step N of M, one step per case). As each case finishes, update its criterion: tested with the evidence (what you did and saw), or failing.',
          '5. For each bug, call report_finding the moment you find it: severity, steps to reproduce, what should happen and what did, and the screenshot path.',
          '6. Be careful with shared environments: call check_in before anything destructive or irreversible (deleting records, sending emails or notifications, payments, inviting people, changing settings others rely on). On production only look, never change anything. Prefix any test data you create with "QA " and today’s date, so it’s easy to find and clean up.',
          `7. Finish with a QA report: a table of the cases with pass or fail and the evidence, the bugs found with their severity, anything you couldn’t test and why, and what you’d test next. Write it to .glassbox/qa/${slug(name) || 'report'}.md and present_file it. Then offer to file the bugs${keys.length ? ' in Jira' : ''} (ask before creating anything) or to fix them in a coding session.`
        ].join('\n\n')
      ]
        .filter(Boolean)
        .join('\n\n')
      return {
        title: tr('launch.qaTitle', { name }).slice(0, 40),
        start: { prompt, display: tr('launch.qaDisplay', { what: what.slice(0, 120), where: where ?? tr('launch.qaLocal') }) },
        requirements: keys.length ? { connectors: ['claude.ai Atlassian'] } : undefined
      }
    }
    case 'blank':
      return { title: tr('launch.newSession') }
  }
}
