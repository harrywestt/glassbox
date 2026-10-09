import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { GlassboxSignal } from '../shared/events'
import { showcasePrompt } from './showcase'
import { SERVICES_FILE, type ProjectServices } from './services'
import { BROWSER_TOOL_NAMES, browserTools, type BrowserBridge } from './browserTools'
import { Loaders } from './loaders'

export const GLASSBOX_TOOLS = [
  'mcp__glassbox__show_diagram',
  'mcp__glassbox__show_flow',
  'mcp__glassbox__show_sketch',
  'mcp__glassbox__set_current_task',
  'mcp__glassbox__pin_file',
  'mcp__glassbox__showcase_ready',
  'mcp__glassbox__log_decision',
  'mcp__glassbox__set_acceptance_criteria',
  'mcp__glassbox__report_finding',
  'mcp__glassbox__check_in',
  'mcp__glassbox__run_as_admin',
  'mcp__glassbox__open_file',
  'mcp__glassbox__present_file',
  'mcp__glassbox__open_diff',
  'mcp__glassbox__show_on_map',
  'mcp__glassbox__show_progress',
  'mcp__glassbox__show_plan_on_map',
  'mcp__glassbox__show_impact',
  'mcp__glassbox__show_database',
  'mcp__glassbox__open_preview',
  'mcp__glassbox__open_tab',
  'mcp__glassbox__build_showcase',
  'mcp__glassbox__app_status',
  'mcp__glassbox__start_app',
  'mcp__glassbox__app_logs',
  'mcp__glassbox__stop_app',
  ...BROWSER_TOOL_NAMES
]

export const GLASSBOX_INSTRUCTIONS = `You are running inside Glassbox, a desktop UI that shows the user everything you do.
Show, don't only tell. The user is watching Glassbox, and its views are what make it better than a terminal, so put things in them:
- Explaining how something works (architecture, data, a sequence of calls, a state machine), or planning a change across modules: show_diagram alongside your answer, then open_tab diagrams.
  For example: "how does auth work here?" (a diagram of the services and where the token goes); "what happens to an order after checkout?" (a flowchart of its states); planning a refactor of three modules (a diagram of the modules and the connections you'll add or remove); a database question (show_database, or an ER diagram).
- Finished a change that spans more than one module or alters how a request moves through the system: show_flow (before and after) or show_diagram before your summary.
  For example: a new API endpoint the front end now calls (a flow from Browser to API to Database, new hops marked new); moving validation from the controller into a service (the flow before and after, the moved hop marked changed); adding a cache in front of a lookup (the flow with the cache hit and miss).
- Anything you start that runs for more than a minute: show_progress, so the user sees it moving without asking. Do it unprompted.
  For example: watching a deploy or a CI run (gh run watch, a pipeline, kubectl rollout status): one loader with steps for the stages (build, test, deploy), or watch on the log; a full test suite, build, docker build or install: watch its log file for a percent or a done line; a dev server or service coming up: watch its url; a migration or data backfill: step and steps as each batch finishes; a QA sweep across 6 pages or a change across 12 files: step 1 of 6 and so on, moved on as each finishes.
- Showing an idea or a problem whose look or layout matters, where words or a diagram fall short: show_sketch, a rough HTML page in the user's Sketches view. Do it unprompted when describing a screen would take a paragraph.
  For example: two or three layouts for a settings page, each a data-pick option so the user can click one; what a user sees now beside what they should see (a bug, a confusing form), with the problem marked .bad; a rough data table to agree what columns a report needs; a tiny interactive prototype of a drag or a toggle to check it feels right. Not for structure (show_diagram), a request's path (show_flow) or finished work (build_showcase), and never the real UI: a sketch is thrown away.
- A showcase, demo or deck of the work: build_showcase, never a skill or a hand-written page.
  For example: "make a showcase of this PR", "something I can show the team", "a demo of the feature for stand-up", or at the end of a ticket when the user asks for something to share.
Use the glassbox MCP tools to keep the user oriented:
- Call set_current_task when you start a distinct piece of work, and update it as steps complete. For multi-step work, list every step up front and give each step the files you expect it to change, so the map can show where each step lands.
- Before you present a plan (ExitPlanMode) or start work that spans more than one module, call show_plan_on_map with the modules it changes or adds and the connections between modules it adds or removes (an import, or a call over HTTP). The user approves the design on the map, before any code exists; call it again if the plan changes.
- Call log_decision whenever you make a non-obvious choice, rule out an alternative, assume something you haven't verified, or hit a question only the user can answer. Log it at the moment it happens, not at the end. The user reviews these live and may challenge them.
- When you work from a ticket or spec, call set_acceptance_criteria with its criteria up front and call it again whenever a status changes. Mark a criterion tested only with evidence (the test name or command that proves it).
- Call check_in before a consequential step you're unsure about: an ambiguous requirement, a risky change, or a choice that would be expensive to undo. It pauses you until the user answers, so use it when being wrong costs more than waiting, not for routine choices.
- In a review, call report_finding for each issue the moment you find it.
- When you design, explain or change architecture, data flow or a sequence of interactions, call show_diagram with a Mermaid diagram. Reuse the same id to update a diagram rather than creating near-duplicates.
- When a change alters how a request or user action moves through the system (new calls, removed calls, changed payloads or responses), call show_flow with the path before and after, marking new, changed and removed hops.
- Call pin_file for files the user should look at (key files you created or changed, or files central to your explanation).
- You can put things in front of the user instead of describing them. When you explain or ask about specific code, call open_file with the lines. After a change the user should review, call open_diff. To show where something lives in the system or which parts a change touches, call show_on_map. When a change could ripple further than it looks, call show_impact. To show a running page, call open_preview. After show_diagram or show_flow, call open_tab if the user should look at it now. Give each a short "why". These switch the user's view, so use them when looking is the point, not for every file you touch.
- When you make or find a file for the user (a document, spreadsheet, slide deck, PDF, image, video, recording, web page, CSV or export), call present_file with its path as soon as it exists. It appears in the conversation, ready to open, and in their Attachments tab. Never just tell the user where you saved something ("it's in your Downloads folder"): present it. Save what you make in the working folder, or where the user asked, rather than Downloads or a temp folder.
- Files the user attaches arrive at the end of their message in an <attachments> block, one path per line. Open each one before you answer (Read shows images and PDFs; use a suitable tool or library for other formats) and treat them as part of the request.
- show_progress is only for long work (expect it to take more than a minute) where you can show real progress: a task with distinct steps (pass step and steps, e.g. step 2 of 5, and move it on as each finishes), a percent you actually know, or something Glassbox can watch. Don't use it for ordinary commands, quick checks, reading or searching, or just to say you're busy: the user already sees what's running. Update it as you go and set status done or failed at the end. If there's something that shows how it's going, pass watch instead of updating it yourself: a url that answers once it's up, a file that appears when it's finished, or a log file whose lines give the percent (and done or failure lines). Use one id per task; several can run at once.
- When the user asks for a showcase, demo deck or PR showcase of the work, call build_showcase first and follow the instructions it returns (even if a showcase or pr-showcase skill is available), and finish with showcase_ready so it appears in their Showcase view. Don't hand-write a deck without it.
- Glassbox has a view for each kind of thing you might show; use the tool for it rather than describing it or writing your own page: a plan (ExitPlanMode, show_plan_on_map), where code lives (show_on_map), the database (show_database), a diagram (show_diagram), a request's path (show_flow), an idea or problem to look at (show_sketch), what a change could affect (show_impact), a web page (open_preview), a file or diff (open_file, open_diff), something you made (present_file), a deck (build_showcase). open_tab brings any view to the front, including the terminal for a command the user should run themselves.
- Keep one task list and keep it current: your to-do list (TodoWrite, or TaskCreate and TaskUpdate). Mark each item in progress when you start it and completed the moment it's done, and add or delete items when the plan changes; the user watches it as Tasks and an out-of-date list misleads them. Use set_current_task for the one-line summary and the files each step will change (for the map), with the same step names, and update it whenever the list changes.
- To run, try or test the app, call start_app: it starts the project's services the same way the user's Run all button does and opens the app in the Glassbox Browser. Never open a browser window and never start dev servers yourself in the shell (no "npm run dev &", "start http://…"). Use app_status to see what's running, app_logs to read a service's output, and stop_app to stop. If the project has no services file yet, create it first (see below). Test runners and curl against an API are fine.
- To look at, click through or check any web page (your app, docs, a dashboard), use the Glassbox Browser tools, not Playwright, Puppeteer, headless Chrome or an external browser: browser_open, then browser_snapshot (a short text outline with numbered controls), browser_click / browser_type / browser_press on those numbers, browser_eval to pull out exactly what you need in one call, browser_wait, browser_tabs. The user watches it happen. Read pages with browser_snapshot (narrow it with find) or browser_eval; take a browser_screenshot only when how it looks matters. The Browser keeps the user's sign-ins: if a page needs a login, ask the user to sign in in the Browser tab, then carry on; never ask for their password.
- Tools and skills that start their own local preview server (hyperframes preview, vite, storybook and the like) open a browser by default: always pass their no-open flag (e.g. --no-open), then call open_preview with the URL they print. When you produce a video, image or recording the user should see (a rendered brag.mp4, a screenshot, a chart), call open_file on it: it plays inline in the conversation. Never open these in an external player or browser.
These tools only affect the Glassbox UI; they are cheap, so use them freely.
- When a command genuinely needs administrator rights (installing system software, changing system settings, services or protected folders), run it with run_as_admin rather than your normal shell. The user approves each one in a Windows prompt, so batch related steps into one command and never use it for things that don't need elevation.
- Don't let work hang. Anything that may not exit (a dev server, a watcher, a REPL) or could wait for input belongs in the background (run_in_background) or under start_app, never in the foreground. Make commands non-interactive (--yes, --no-input, CI=1, a timeout). While background work runs, check its output now and then (TaskOutput) rather than waiting blindly, and stop anything that has hung (TaskStop). Glassbox's watchdog may also prompt you to check on quiet background work.
- Stay answerable. When work will take more than a couple of minutes (several subagents, a long build or test run), start it in the background (run_in_background: true) so you remain free to reply. When the user writes while work is running, reply to them first, briefly, then carry on.
- In markdown tables each row must stay on one line. For a line break inside a cell use <br>; for a list inside a cell write "- first<br>- second" (Glassbox shows it as bullets). Keep cells short; put long explanations below the table.
The user may attach "Glassbox session requirements" to their messages: files they marked must-read, must-edit or don't-touch, and connectors or skills they require. Treat these as firm instructions.`

// Kept in context instead of deferred behind tool search, and read-only so plan mode allows them
// (they only update the Glassbox UI).
const ALWAYS_LOAD = { alwaysLoad: true, annotations: { readOnlyHint: true } }

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })

const FLOW_HOP = z.object({
  from: z.string().describe('Lane name the call or response starts from'),
  to: z.string().describe('Lane name it goes to'),
  label: z.string().describe('Short, e.g. "POST /orders" or "201 { orderId }"'),
  kind: z.enum(['new', 'changed', 'removed']).optional().describe('Omit for hops your change leaves alone')
})

/** checkIn resolves with the user's answer; it's what makes check_in actually pause Claude. */
export function createGlassboxServer(
  emit: (signal: GlassboxSignal) => void,
  checkIn: (q: { confidence: 'low' | 'medium'; about: string; reason: string; options?: string[] }) => Promise<string>,
  runAdmin?: (command: string, reason: string) => Promise<string>,
  app?: () => ProjectServices,
  /** Decisions and assumptions, kept for the project so later sessions start from them. */
  onDecision?: (d: { kind: 'decision' | 'assumption'; title: string; detail?: string; files?: string[] }) => void,
  /** The session's folder, for paths Claude gives relative to it. */
  cwd?: string,
  /** The session's Browser tabs, for Claude's browser tools. */
  browser?: { bridge: BrowserBridge; shotsDir: string },
  /** The session's loaders, kept across its restarts (a background task gets its own). */
  sessionLoaders?: Loaders
) {
  const loaders = sessionLoaders ?? new Loaders(cwd ?? process.cwd(), (loader) => emit({ type: 'loader', loader }))
  return createSdkMcpServer({
    name: 'glassbox',
    version: '0.2.0',
    tools: [
      ...(runAdmin
        ? [
            tool(
              'run_as_admin',
              'Run one PowerShell command with administrator rights, in the project folder. The user approves it in a Windows (UAC) prompt; returns the output and exit code. Only for commands that need elevation.',
              {
                command: z.string().describe('PowerShell to run elevated. Combine related steps with ; so the user approves once.'),
                reason: z.string().describe('One line the user sees: why this needs administrator rights')
              },
              async ({ command, reason }) => ok(await runAdmin(command, reason))
            )
          ]
        : []),
      tool(
        'show_diagram',
        'Display a Mermaid diagram in the Glassbox Diagrams panel. Reusing an id replaces that diagram. Use it whenever a picture explains faster than words: how services or modules connect (flowchart LR), the order of calls in a request (sequenceDiagram), the states something moves through (stateDiagram-v2), tables and their relations (erDiagram), or the plan for a change across modules.',
        {
          id: z.string().describe('Stable slug, e.g. "auth-flow"'),
          title: z.string(),
          mermaid: z.string().describe('Mermaid source, e.g. "flowchart LR\\n  A --> B"')
        },
        async ({ id, title, mermaid }) => {
          emit({ type: 'diagram', id, title, mermaid })
          return ok(`Diagram "${title}" is now visible in Glassbox.`)
        },
        ALWAYS_LOAD
      ),
      tool(
        'show_sketch',
        'Show a rough HTML sketch in the Glassbox Sketches view, to put an idea or a problem in front of the user: layouts to choose between, a screen as it is against as it should be, a rough table, a small interactive prototype. The user pans and zooms it, clicks options, and comments on parts of it; their pick or comment comes back to you as a message. Reusing an id adds a new version (they can step back through versions), so revise rather than making near-duplicates.\n\n' +
          'Write a self-contained fragment (no doctype needed): inline <style> and <script> are fine; nothing loads from the network, so no external fonts, images or libraries (draw with HTML, CSS or inline SVG). Glassbox\'s colours are set as CSS variables (--bg, --surface, --surface2, --elevated, --border, --fg, --muted, --subtle, --accent, --accent-fg, --ok, --warn, --err, --info) and match the user\'s light or dark theme; plain elements are already styled. Use colour whenever it helps, and prefer Glassbox\'s own: by default a sketch is drawn in the user\'s scheme and accent, and its colours should come from the app: the theme variables, its status colours, and its chart palette --cat-1 to --cat-8 (for categories, in order). Every app colour (accent, ok, warn, err, info, cat-1 to cat-8) has classes .text-<colour> (coloured text), .fill-<colour> (a soft tint with a matching border, e.g. a card or row) and .solid-<colour> (a strong fill, e.g. a button or tag). Only when the user asks for it (a light version, another accent, their brand\'s or product\'s colours) set scheme or accent to another of the app\'s, or use your own CSS colours. Keep it rough and quick: it is a sketch, not the product. Classes ready to use: .row (side by side, wrapping) and .col (stacked), .grow, .card (a panel), .box (a dashed placeholder for "image here", "chart here"), .note (an annotation), .bad and .good (mark a problem or the fix), .label (a small tag), .muted, .small, button.primary.\n\n' +
          'To let the user choose, put data-pick="Option A" (a short name) on each option\'s container: clicking one sends you "I pick Option A". Lay options side by side in a .row at the given width, each with a heading saying what is different.',
        {
          id: z.string().describe('Stable slug, e.g. "settings-layout"; the same id again is a new version'),
          title: z.string().describe('What it shows, e.g. "Settings: three layouts"'),
          html: z.string().describe('The sketch: an HTML fragment with any inline <style> and <script>'),
          width: z.number().int().min(320).max(2400).optional().describe('Page width in px it is drawn at (default 1200; 390 for a phone)'),
          note: z.string().optional().describe('One line on what changed in this version'),
          scheme: z.enum(['match', 'dark', 'light']).optional().describe("Leave out (the user's scheme) unless the user asks for dark or light"),
          accent: z.enum(['match', 'teal', 'blue', 'violet', 'green', 'amber', 'rose']).optional().describe("Leave out (the user's accent) unless the user asks for another")
        },
        async ({ id, title, html, width, note, scheme, accent }) => {
          emit({ type: 'sketch', id, title, html, width, note, scheme, accent })
          return ok(`Sketch "${title}" is in the Sketches view. Call open_tab sketches if the user should look now. Their pick or comment will arrive as a message.`)
        },
        ALWAYS_LOAD
      ),
      tool(
        'show_flow',
        'Show how a request or user action moves through the system, before and after your change, as an animated sequence in Glassbox. Reusing an id replaces that flow. Use it after any change that adds, removes or alters a call, payload or response on a path the user cares about: e.g. "Place an order" across Browser, API, Orders service and Database, with the hops you added marked new and the ones you changed marked changed.',
        {
          id: z.string().describe('Stable slug, e.g. "place-order"'),
          title: z.string().describe('The user action or request, e.g. "Place an order"'),
          lanes: z.array(z.string()).min(2).max(7).describe('Participants left to right, e.g. ["Browser", "API", "Orders service", "Database"]'),
          before: z.array(FLOW_HOP).optional().describe('The path before your change, in order. Omit for a brand-new flow.'),
          after: z.array(FLOW_HOP).describe('The path after your change, in order')
        },
        async ({ id, title, lanes, before, after }) => {
          const known = new Set(lanes)
          const bad = [...(before ?? []), ...after].flatMap((h) => [h.from, h.to]).filter((n) => !known.has(n))
          if (bad.length) {
            return { ...ok(`Hop ends must be lane names. Not in lanes: ${[...new Set(bad)].map((n) => `"${n}"`).join(', ')}. Lanes are: ${lanes.map((n) => `"${n}"`).join(', ')}.`), isError: true }
          }
          emit({ type: 'flow', id, title, lanes, before, after })
          return ok(`Flow "${title}" is now visible in Glassbox.`)
        },
        ALWAYS_LOAD
      ),
      tool(
        'set_current_task',
        'Set the task banner Glassbox shows the user: a one-line summary of what you are doing, plus optional steps.',
        {
          summary: z.string(),
          steps: z
            .array(
              z.object({
                label: z.string(),
                status: z.enum(['pending', 'active', 'done']),
                files: z.array(z.string()).optional().describe('Files this step is expected to change, relative to the working directory')
              })
            )
            .optional()
        },
        async ({ summary, steps }) => {
          emit({ type: 'task', summary, steps })
          return ok('Task updated.')
        },
        ALWAYS_LOAD
      ),
      tool(
        'pin_file',
        'Pin a file in the Glassbox Changes panel so the user can review it.',
        { path: z.string().describe('Absolute path, or relative to the working directory'), reason: z.string().optional() },
        async ({ path, reason }) => {
          emit({ type: 'pin', path, reason })
          return ok(`Pinned ${path}.`)
        },
        ALWAYS_LOAD
      ),
      tool(
        'log_decision',
        'Record a decision, assumption or open question in the Glassbox decisions log as it happens. The user sees it immediately and can challenge it.',
        {
          kind: z.enum(['decision', 'assumption', 'question']).describe('decision: a choice you made; assumption: something you are taking as true without verifying; question: something only the user can answer'),
          title: z.string().describe('One line, e.g. "Store discounts as basis points, not floats"'),
          detail: z.string().optional().describe('Why, in a sentence or two'),
          alternatives: z.array(z.string()).optional().describe('Options you considered and rejected'),
          files: z.array(z.string()).optional()
        },
        async ({ kind, title, detail, files }) => {
          if (kind !== 'question') onDecision?.({ kind, title, detail, files })
          return ok(kind === 'question' ? `Logged. The user has been shown your question: "${title}". Carry on with anything that doesn't depend on the answer.` : 'Logged.')
        },
        ALWAYS_LOAD
      ),
      tool(
        'set_acceptance_criteria',
        'Show the acceptance criteria you are working to as a live checklist. Send the full list every time; update statuses as you go.',
        {
          source: z.string().optional().describe('Where the criteria come from, e.g. "NSD-1234" or a URL'),
          criteria: z.array(
            z.object({
              id: z.string().describe('Stable short id, e.g. "ac1"'),
              text: z.string(),
              status: z.enum(['todo', 'in-progress', 'done', 'tested']),
              evidence: z.string().optional().describe('For tested: the test or command that proves it')
            })
          )
        },
        async ({ criteria }) => ok(`Checklist updated: ${criteria.filter((c) => c.status === 'tested').length} of ${criteria.length} tested.`),
        ALWAYS_LOAD
      ),
      tool(
        'report_finding',
        'Report one review finding so the user sees it immediately.',
        {
          severity: z.enum(['blocker', 'major', 'minor', 'nit', 'question']),
          title: z.string(),
          detail: z.string().optional(),
          file: z.string().optional(),
          line: z.number().optional(),
          suggestion: z.string().optional().describe('Suggested fix, code or prose')
        },
        async () => ok('Finding recorded.'),
        ALWAYS_LOAD
      ),
      tool(
        'check_in',
        'Pause and ask the user before a consequential step you are not confident about. Returns their answer.',
        {
          confidence: z.enum(['low', 'medium']),
          about: z.string().describe('What you are about to do, in one line'),
          reason: z.string().describe('Why you are unsure'),
          options: z.array(z.string()).optional().describe('Up to 4 concrete choices the user can pick from')
        },
        async (q) => ok(`The user answered: ${await checkIn(q)}`),
        ALWAYS_LOAD
      ),
      // Putting things in front of the user. Each switches the user's view, so they're for when
      // looking at the thing is the point (you're explaining it, or asking about it).
      tool(
        'open_file',
        'Open a project file in a Glassbox tab for the user, scrolled to and highlighting the given lines. Use it when you point the user at code: explaining it, asking about it, or showing where something happens. For an image, video or audio file (a screenshot, a chart, a recording) it shows the file inline in the conversation instead; images you Read or create also appear there automatically.',
        {
          path: z.string().describe('File path, relative to the project or absolute'),
          line: z.number().int().positive().optional().describe('First line to highlight'),
          endLine: z.number().int().positive().optional().describe('Last line to highlight (defaults to line)'),
          why: z.string().optional().describe('One short line shown above the file, e.g. "This is where the discount is applied"')
        },
        async ({ path, line, endLine, why }) => {
          emit({ type: 'open', target: { view: 'file', path, line, endLine }, why })
          return ok(`Opened ${path} for the user.`)
        },
        ALWAYS_LOAD
      ),
      tool(
        'present_file',
        "Show the user a file you made or found for them (a document, spreadsheet, deck, PDF, image, video, web page, export): a card in the conversation they open with one click, also kept in their Attachments tab. Use it for every deliverable instead of saying where it's saved.",
        {
          path: z.string().describe('The file, absolute or relative to the working directory'),
          title: z.string().optional().describe('What it is, in a few words, e.g. "Q3 board pack"'),
          why: z.string().optional().describe('One line on what to look at in it')
        },
        async ({ path }) => {
          const { existsSync } = await import('node:fs')
          const { isAbsolute, resolve } = await import('node:path')
          const full = isAbsolute(path) ? path : resolve(cwd ?? process.cwd(), path)
          return existsSync(full) ? ok(`Shown to the user: ${path}`) : { ...ok(`There's no file at ${path}. Create it first, or pass the path it was actually saved to.`), isError: true }
        },
        ALWAYS_LOAD
      ),
      tool(
        'open_diff',
        "Open the diff of a file you changed, so the user can review exactly what changed.",
        { path: z.string(), why: z.string().optional().describe('One short line shown above the diff') },
        async ({ path, why }) => {
          emit({ type: 'open', target: { view: 'diff', path }, why })
          return ok(`Opened the diff of ${path} for the user.`)
        },
        ALWAYS_LOAD
      ),
      tool(
        'show_on_map',
        "Bring up the Glassbox map with the modules containing these files highlighted and the first one opened (its connections and why they exist). Use it to show where something lives in the system or which parts a change spans.",
        {
          paths: z.array(z.string()).min(1).describe('Files or folders; their modules are highlighted'),
          why: z.string().optional().describe('One short line shown on the map')
        },
        async ({ paths, why }) => {
          emit({ type: 'open', target: { view: 'map', paths }, why })
          return ok('The map is showing those modules.')
        },
        ALWAYS_LOAD
      ),
      tool(
        'show_plan_on_map',
        "Draw a plan's shape on the Glassbox map before writing code: the modules it changes or adds, and the connections between modules it adds or removes. The user reviews the design there (alongside the plan text) and approves it. Send the whole shape each time; it replaces the last one.",
        {
          modules: z
            .array(
              z.object({
                path: z.string().describe('A file or folder in the module, relative to the project. For a new module, the folder it will live in.'),
                change: z.enum(['change', 'new']).describe('change: an existing module you will edit; new: a module (folder) you will create'),
                why: z.string().optional().describe('What changes there, in a few words')
              })
            )
            .min(1),
          connections: z
            .array(
              z.object({
                from: z.string().describe('A file or folder in the module that depends on the other'),
                to: z.string().describe('A file or folder in the module it depends on'),
                change: z.enum(['new', 'removed']),
                http: z.boolean().optional().describe('The connection is a call over HTTP, not an import'),
                why: z.string().optional()
              })
            )
            .optional()
            .describe('Only connections your plan adds or removes, not existing ones it keeps')
        },
        async ({ modules, connections }) => ok(`The plan is on the map: ${modules.length} module${modules.length === 1 ? '' : 's'}${connections?.length ? `, ${connections.length} connection change${connections.length === 1 ? '' : 's'}` : ''}.`),
        ALWAYS_LOAD
      ),
      tool(
        'show_database',
        "Open the Glassbox database view (tables and how they connect, read from the project's EF Core model, Prisma schema or SQL migrations) on an area. Use it when you explain or change the data model, or the user asks how tables relate.",
        {
          area: z.string().optional().describe('What to show, in words, e.g. "controls v2" or "how evidence links to controls"; Glassbox works out the tables'),
          entities: z.array(z.string()).optional().describe('Or the exact entities or tables to show, e.g. ["Control", "ControlEvidence"]'),
          why: z.string().optional()
        },
        async ({ area, entities, why }) => {
          emit({ type: 'open', target: { view: 'erd', entities, query: area }, why })
          return ok('The database view is open.')
        },
        ALWAYS_LOAD
      ),
      tool(
        'show_progress',
        "Show (or update) a named loader just above the user's message box, for anything you start that runs over a minute, without being asked: watching a deploy or CI run (steps for its stages, or watch its log), a full test suite or build (watch its log for a percent or done line), a service starting (watch its url), a migration or a multi-file change (step N of M). Use it ONLY where there's real progress to show. Starting one needs step and steps (e.g. step 1 of 4), a known percent, or watch; without one of those it's refused. Move it along with step (or percent) and detail as each part finishes, or pass watch and Glassbox moves it: done when a url answers or a file appears, or percent and done read from a log file. Not for ordinary commands or quick checks.",
        {
          id: z.string().describe('Stable id for this task, e.g. "build" or "deploy-staging"; reuse it to update'),
          label: z.string().describe('What is loading, e.g. "Building the API"'),
          status: z.enum(['running', 'done', 'failed']).optional().describe('Default running'),
          step: z.number().int().min(1).optional().describe('Which step is under way now (1-based), with steps'),
          steps: z.number().int().min(2).optional().describe('How many steps there are in all'),
          percent: z.number().min(0).max(100).optional().describe('How far along, when you actually know it'),
          detail: z.string().optional().describe('One line on what is happening now'),
          watch: z
            .object({
              url: z.string().optional().describe('Done once this URL answers (e.g. a dev server coming up)'),
              file: z.string().optional().describe('Done once this file exists'),
              log: z.string().optional().describe('A log file to read for progress: lines with a percent ("45%") or a count ("stage 3 of 5", "[3/5]") move the bar; its latest line shows under it. Send a command\'s output there to watch it (e.g. > deploy.log 2>&1).'),
              percent_pattern: z.string().optional().describe('Regex whose first group is the percent in a log line (default: a number followed by %)'),
              done_pattern: z.string().optional().describe('Regex for a log line that means it finished'),
              fail_pattern: z.string().optional().describe('Regex for a log line that means it failed')
            })
            .optional()
        },
        async ({ id, label, status, step, steps, percent, detail, watch }) => {
          // A loader is for progress you can show, not for "busy": a new one needs steps, a percent or something to watch.
          if (!loaders.has(id) && (status ?? 'running') === 'running' && !(step && steps) && percent === undefined && !watch)
            return ok('Not shown: a loader needs real progress. Pass step and steps (e.g. step 1 of 4) for work with distinct parts, a percent you know, or watch. For ordinary commands and short work, skip it: the user already sees what is running.')
          // An update only changes what it gives (leaving out step keeps the one already shown; a step moves the bar).
          const given = Object.fromEntries(Object.entries({ percent, step, steps, detail, watch }).filter(([, v]) => v !== undefined))
          loaders.set({ id, label, status: status ?? 'running', ...given })
          return ok(watch && (status ?? 'running') === 'running' ? `Showing "${label}". Glassbox is watching it and will mark it done.` : `"${label}" is ${status ?? 'running'}.`)
        },
        ALWAYS_LOAD
      ),
      tool(
        'show_impact',
        "Open the Ripple view for a file's module: everything that depends on it, and which of those are covered by tests. Use it when a change could affect more than it looks.",
        { path: z.string(), why: z.string().optional() },
        async ({ path, why }) => {
          emit({ type: 'open', target: { view: 'ripple', path }, why })
          return ok('Opened the impact view.')
        },
        ALWAYS_LOAD
      ),
      tool(
        'open_preview',
        'Show the user a page (usually of the running app) in the Glassbox Browser. To read or use the page yourself, use browser_open instead.',
        { url: z.string().describe('http(s) URL, usually a local dev server'), why: z.string().optional() },
        async ({ url, why }) => {
          emit({ type: 'open', target: { view: 'preview', url }, why })
          return ok(`Opened ${url} in the Browser.`)
        },
        ALWAYS_LOAD
      ),
      tool(
        'open_tab',
        'Bring one of the Glassbox views to the front: conversation; plan (your plan, to approve or reread); map (the parts of the project this work touches); database (tables and how they connect; use show_database to focus an area); diagrams (after show_diagram); sketches (after show_sketch); flows (after show_flow); live (each file as you edit it); ripple (what a change could affect; use show_impact for a file); terminal (the user\'s own shell in this folder, for a command they should run themselves); browser (web pages; use open_preview for a URL); attachments (files they attached and files you made); showcase (the shareable deck; use build_showcase to make one); replay (step back through the session).',
        { tab: z.enum(['conversation', 'plan', 'map', 'database', 'diagrams', 'sketches', 'flows', 'live', 'ripple', 'terminal', 'browser', 'attachments', 'showcase', 'replay']), why: z.string().optional() },
        async ({ tab, why }) => {
          emit({ type: 'open', target: { view: 'tab', tab }, why })
          return ok(`Showing ${tab}.`)
        },
        ALWAYS_LOAD
      ),
      ...(app ? appTools(app, emit) : []),
      ...(browser ? browserTools(browser.bridge, browser.shotsDir) : []),
      tool(
        'build_showcase',
        'Get the instructions for building a showcase deck of this work (a shareable page for teammates, published as a Claude Artifact). Call it when the user asks for a showcase, demo, deck or "something to show the team" about the work (a PR, a ticket, a feature); then follow the instructions it returns.',
        {
          name: z.string().describe('Short kebab-case name for the deck, e.g. the ticket key and a slug'),
          notes: z.string().optional().describe("Anything the user asked to emphasise"),
          base: z.string().optional().describe('Branch the work is compared against, if known')
        },
        async ({ name, notes, base }) => ok(showcasePrompt({ name: name.replace(/[^\w.-]+/g, '-').slice(0, 80) || 'showcase', base: base ?? null, notes: notes ?? '' })),
        ALWAYS_LOAD
      ),
      tool(
        'showcase_ready',
        'Tell Glassbox a showcase deck has been written (and optionally published), so it shows in the Showcase view. Always call it when a deck is done, however it was made.',
        { path: z.string(), title: z.string(), artifactUrl: z.string().optional() },
        async ({ path, title, artifactUrl }) => {
          emit({ type: 'showcase', path, title, artifactUrl })
          return ok('Showcase is visible in Glassbox.')
        },
        ALWAYS_LOAD
      )
    ]
  })
}

/** The session's services as a short status list, with each one's URL. */
function describeServices(p: ProjectServices): string {
  const snap = p.snapshot()
  if (!snap.exists) return `This project has no ${SERVICES_FILE.replace(/\\/g, '/')} yet, so Glassbox doesn't know how to run it. Create one (see your instructions), then call start_app.`
  if (snap.error) return `The services file couldn't be read: ${snap.error}`
  if (!snap.services.length) return 'The services file lists no services.'
  return snap.services
    .map((s) => `${s.name}: ${s.status}${s.port ? ` on port ${s.port}` : ''}${s.config.url ? ` (${s.config.url})` : ''}${s.waitingFor?.length ? `, waiting for ${s.waitingFor.join(', ')}` : ''}${s.exitCode !== undefined ? `, exit code ${s.exitCode}` : ''}`)
    .join('\n')
}

/** The web page to show: the running service that looks most like the front end. */
function webUrl(p: ProjectServices): string | undefined {
  const web = p.snapshot().services.filter((s) => s.status === 'running' && s.config.url && /^https?:\/\//.test(s.config.url))
  return (web.find((s) => /web|ui|front|app|client|site/i.test(s.name)) ?? web[0])?.config.url
}

/**
 * Running the app the way the user does: through the session's services (the Run all button),
 * shown in the Glassbox preview, never in a separate browser.
 */
function appTools(app: () => ProjectServices, emit: (signal: GlassboxSignal) => void) {
  return [
    tool(
      'app_status',
      "Show this session's app services (from the Glassbox services file): which are running, their ports and URLs.",
      {},
      async () => ok(describeServices(app())),
      ALWAYS_LOAD
    ),
    tool(
      'start_app',
      "Start the app to try or test it: runs this session's services exactly like the user's Run all button (or just one service), waits until they're ready, then opens the web app in the Glassbox preview. Use this instead of starting dev servers in the shell or opening a browser.",
      {
        service: z.string().optional().describe('Start only this service (and what it depends on); omit to start everything'),
        path: z.string().optional().describe('Page to open in the preview, e.g. "/checkout"'),
        why: z.string().optional().describe('One short line shown above the preview')
      },
      async ({ service, path, why }) => {
        const p = app()
        p.load()
        if (!p.snapshot().exists) return ok(describeServices(p))
        if (service) await p.start(service)
        else await p.startAll()
        const url = webUrl(p)
        if (url) {
          const page = path ? new URL(path, url).toString() : url
          emit({ type: 'open', target: { view: 'preview', url: page }, why: why ?? 'Running the app to try the change' })
          return ok(`${describeServices(p)}\n\nThe app is open in the Glassbox Browser at ${page}. Read and use it with browser_snapshot, browser_click and browser_type; app_logs reads a service's output.`)
        }
        return ok(`${describeServices(p)}\n\nNo web service is running, so there's nothing to preview. Use app_logs to see why a service didn't start.`)
      },
      ALWAYS_LOAD
    ),
    tool(
      'app_logs',
      "Read a service's recent output (build errors, stack traces, request logs).",
      { service: z.string(), lines: z.number().int().positive().max(400).optional().describe('How many of the latest lines (default 80)') },
      async ({ service, lines }) => {
        const out = app().logs(service)
        return ok(out.length ? out.slice(-(lines ?? 80)).join('\n') : `No output from ${service} yet.`)
      },
      ALWAYS_LOAD
    ),
    tool(
      'stop_app',
      "Stop this session's services, or one of them (e.g. to restart after changing its config).",
      { service: z.string().optional() },
      async ({ service }) => {
        const p = app()
        if (service) await p.stop(service)
        else await p.stopAll()
        return ok(describeServices(p))
      },
      ALWAYS_LOAD
    )
  ]
}
