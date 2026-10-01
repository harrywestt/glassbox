import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

export const showcaseDir = () => {
  const dir = join(app.getPath('userData'), 'showcases')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Where a project's own /pr-showcase skill keeps its decks. */
export const skillDeckDir = () => join(homedir(), '.claude', 'pr-showcase')

/** The house deck template (the one /pr-showcase uses), bundled with the app. */
export function showcaseTemplate(): string | null {
  const path = join(app.getAppPath(), 'resources', 'showcase-template.html')
  return existsSync(path) ? path : null
}

export type ShowcaseRequest = {
  name: string
  base: string | null
  notes: string
  previousArtifactUrl?: string
  /** Also add the Artifact link to the branch's PR description and its Jira ticket. */
  linkIt?: boolean
}

/** The prompt for the background showcase builder. */
export function showcasePrompt({ name, base, notes, previousArtifactUrl, linkIt }: ShowcaseRequest): string {
  const notesBlock = notes.trim() ? `

## Notes from me
${notes.trim()}` : ''
  const ready =
    'Finally, call mcp__glassbox__showcase_ready with the local file path, a short title, and the Artifact URL, so Glassbox can preview it and link to it.'
  const path = join(showcaseDir(), `${name}.html`)
  const template = showcaseTemplate()
  return `Build a shareable **showcase deck** of the work in this session, for teammates who weren't here, and publish it as a **Claude Artifact**.

## Template
${
  template
    ? `Use the house template at ${template}: read it, copy it to ${path}, and fill in every {{TOKEN}}. Follow the instructions in its header comment: duplicate the PLATE:UI, PLATE:CODE and PLATE:DECISION blocks as needed, delete the ones you don't use, and keep the left rail's ticks in sync with the plates, one per plate and in order. Keep it wrapper-free (no doctype, html, head or body) and fully self-contained: no external URLs, since the Artifact CSP blocks them, so draw any diagram as inline SVG.`
    : `Write one self-contained HTML deck to ${path}: a left rail listing the slides, one slide visible at a time, ←/→ to navigate. No external URLs (the Artifact CSP blocks them), so draw diagrams as inline SVG.`
}

## Source of record
If the branch name starts with a ticket key (like ABC-123) and a Jira connector is available, read the ticket (description, acceptance criteria, linked specs) and use it as what was asked for when you tag the decisions. Otherwise use this conversation and the commits.

## What goes in it
The deck always shows the whole change${base ? ` against \`${base}\` (use \`git merge-base ${base} HEAD\` as the base)` : ''}, committed and uncommitted.
- **Overview**: what was built and why, in two or three sentences, with the branch, the ticket if the branch names one, and the stats (files, lines added and removed, commits). Keep only the flags that apply: new module, migration, breaking change, infra.
- **UI before → after**, only if screens changed: rebuild the old and new state as static HTML from the component source (old = \`git show <base>:<path>\`), one plate per screen, with the NEW/CHANGED/REMOVED notes.
- **Code highlights**: only what a teammate must know exists (new contracts, migrations, infra, endpoints, new patterns or dependencies), not a file tour. One card each: a kind chip, the path, a one-line "why it matters", and a trimmed 12–16 line snippet, HTML-escaped, with added and removed lines marked.
- **Decisions**: what was decided and why, taken from this conversation and the commits. Tag each one FOLLOWED SPEC, DEVIATED, REJECTED, OWN CALL or FROM CONVERSATION. Never invent a rationale; mark anything uncertain.
One item per plate: split rather than overflow. Each plate should read without scrolling on a laptop.

## Publish
Publish ${path} with the Artifact tool${previousArtifactUrl ? `, redeploying to ${previousArtifactUrl} so the link stays the same` : ''}. This is the deliverable, so if the Artifact tool isn't available, say so plainly rather than stopping at the local file. Remind me that Artifacts start private: I need to open it in claude.ai and share it with the org before teammates can view it.
${linkIt ? `
## Link it
Once it's published: if the branch has an open PR (\`gh pr view\`), add or refresh a "Showcase" section in its description with the Artifact link, between the markers <!-- glassbox-showcase:start --> and <!-- glassbox-showcase:end --> so a rebuild replaces it rather than adding another. If the branch names a Jira ticket and a Jira connector is available, add a comment with the link, unless one with this exact link is already there. Skip either quietly if there's no PR or no ticket.
` : ''}${ready}${notesBlock}`
}
