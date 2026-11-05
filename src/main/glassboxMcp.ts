import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { GlassboxSignal } from '../shared/events'
import { servicesFile, type ProjectServices } from './services'
import { BROWSER_TOOL_NAMES, browserTools, type BrowserBridge, type BrowserHooks } from './browserTools'
import type { UxReviewer } from './uxReviewer'
import { Loaders } from './loaders'
import { describeStyle, projectStyle } from './projectStyle'
import { keepSketch, latestSketch, readSketch, setLatestSketch, sketchSnapshot, sketchUrl, withAssets } from './sketch'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { componentId, deleteLibrary, listLibrary, saveLibrary, sourceHash } from './library'
import { isAbsolute, resolve as resolvePath } from 'node:path'

export const GLASSBOX_TOOLS = [
  'mcp__glassbox__show_diagram',
  'mcp__glassbox__show_flow',
  'mcp__glassbox__show_sketch',
  'mcp__glassbox__sketch_snapshot',
  'mcp__glassbox__delete_sketch',
  'mcp__glassbox__pr_overview',
  'mcp__glassbox__review_ux',
  'mcp__glassbox__set_current_task',
  'mcp__glassbox__pin_file',
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
  'mcp__glassbox__show_database',
  'mcp__glassbox__open_preview',
  'mcp__glassbox__open_tab',
  'mcp__glassbox__app_status',
  'mcp__glassbox__start_app',
  'mcp__glassbox__get_services',
  'mcp__glassbox__save_component',
  'mcp__glassbox__list_components',
  'mcp__glassbox__delete_component',
  'mcp__glassbox__save_services',
  'mcp__glassbox__app_logs',
  'mcp__glassbox__stop_app',
  ...BROWSER_TOOL_NAMES
]

export const GLASSBOX_INSTRUCTIONS = `You are running inside Glassbox, a desktop app that shows the user your session: the conversation, changed files, a map of the project and a Browser.
Spend tokens only on what the user asked for. Don't add work they didn't ask for: no diagrams, flows, maps, decks or UX reviews unless the user asks for one or the task is about it.
Sketches come first for UI: when a task adds or changes UI, show_sketch the proposed screen (and its states, or two or three options to pick from) before you build it, so the user can react. It is drawn in the project's own colours; match the app's real layout and components.
Plans (ExitPlanMode) are rendered by Glassbox as a document: Markdown plus these blocks, each tag on its own lines. Use them where they help, not by default:
- <Sketch id="sketch-id" /> embeds a sketch you made with show_sketch; for UI plans put the proposed screens near the top.
- <Files> with one line per file: "+ path | why" (new), "~ path | what changes", "- path | why removed" </Files>.
- \`\`\`mermaid for architecture or flow; <Diff file="path"> a short unified diff of the key change </Diff>; <Callout type="risk|decision|note"> one point </Callout>.
- One <Questions> block at the end, a line each: "- question | recommended answer | alternative". The user answers in place.
Lead with the outcome, name real files and symbols, keep prose short.
Glassbox tools (mcp__glassbox__*, loaded through tool search when you need one):
- To show something the user asked to see: show_diagram (Mermaid), show_flow, show_sketch, show_on_map, show_plan_on_map, show_database, open_file, open_diff, open_preview, open_tab.
- present_file: when you make a file for the user (document, image, video, export), present it rather than saying where it is. Save it in the working folder.
- check_in: wait for the user's answer before a risky or hard-to-undo step you're unsure about.
- start_app, app_status, app_logs, stop_app: run the project's services (the user's Run button). Don't start dev servers or open browsers yourself.
- browser_*: look at web pages in the Glassbox Browser instead of Playwright or an external browser. Read pages with browser_snapshot or browser_eval; screenshot only when the look matters. If a page needs a login, ask the user to sign in there; never ask for passwords. Reuse the current tab and close tabs you're done with.
- run_as_admin: only for commands that need administrator rights; the user approves each one.
- show_progress: only for work you expect to run for several minutes; pass watch (a log file, url or file) rather than updating it repeatedly.
- set_current_task, log_decision, set_acceptance_criteria, report_finding, pin_file: only when the user asks for them.
Files the user attaches arrive in an <attachments> block at the end of their message; read them.
Never leave a command that waits for input or never exits in the foreground: background it or use start_app.
In markdown tables keep each row on one line; use <br> for a line break inside a cell.
The user may attach "Glassbox session requirements" (files marked must-read, must-edit or don't-touch; required connectors or skills): treat them as firm instructions.`

// Read-only so plan mode allows them (they only update the Glassbox UI). Deferred behind tool search
// like any connector's tools, so their schemas don't ride along with every request.
const READ_ONLY = { annotations: { readOnlyHint: true } }

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
  browser?: { bridge: BrowserBridge; shotsDir: string; hooks?: BrowserHooks },
  /** The session's loaders, kept across its restarts (a background task gets its own). */
  sessionLoaders?: Loaders,
  /** The UX reviewer: a second agent that looks over screenshots in the background. */
  ux?: Pick<UxReviewer, 'add' | 'addReference' | 'status' | 'flush'>
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
        READ_ONLY
      ),
      tool(
        'show_sketch',
        'Show a rough HTML sketch in the Glassbox Sketches view, to put an idea or a problem in front of the user: layouts to choose between, a screen as it is against as it should be, a rough table, a small interactive prototype. The user pans and zooms it, clicks options, and comments on parts of it; their pick or comment comes back to you as a message. Reusing an id adds a new version (they can step back through versions), so revise rather than making near-duplicates.\n\n' +
          'Write a self-contained fragment (no doctype needed): inline <style> and <script> are fine; nothing loads from the network (no CDN fonts, images or libraries; draw with HTML, CSS or inline SVG), but image and font files on disk can be used (see below). Any width works. Colours are set as CSS variables (--bg, --surface, --surface2, --elevated, --border, --fg, --muted, --subtle, --accent, --accent-fg, --ok, --warn, --err, --info, --radius) and plain elements are already styled with them. By default they are THE PROJECT\'S OWN colours, read from its stylesheets and Tailwind config, so a proposed screen looks like the app it is for (this tool\'s answer says what it found); use the variables rather than your own hex so the sketch stays on-brand, and match the project\'s layout, density and components as you saw them in its code. Where the project has no colours, Glassbox\'s are used. A chart palette --cat-1 to --cat-8 (for categories, in order) is there too. Every colour (accent, ok, warn, err, info, cat-1 to cat-8) has classes .text-<colour> (coloured text), .fill-<colour> (a soft tint with a matching border, e.g. a card or row) and .solid-<colour> (a strong fill, e.g. a button or tag). Set scheme to match, dark or light (Glassbox\'s look) only when the sketch is about Glassbox itself or the user asks. Keep it rough and quick: it is a sketch, not the product. Classes ready to use: .row (side by side, wrapping) and .col (stacked), .grow, .card (a panel), .box (a dashed placeholder for "image here", "chart here"), .note (an annotation), .bad and .good (mark a problem or the fix), .label (a small tag), .muted, .small, button.primary.\n\n' +
          'To let the user choose, put data-pick="Option A" (a short name) on each option\'s container: clicking one sends you "I pick Option A". Lay options side by side in a .row at the given width, each with a heading saying what is different.\n\n' +
          'Make it work when that helps (the user clicks through it): attributes need no script. data-open="#refund" on a button opens the element with that id (a .modal with a .panel inside, a .drawer, a .popover menu, or a <dialog>); data-close closes the one it is in (or the selector given); Esc and a click on a modal\'s backdrop close it too. data-toggle="#menu" shows or hides. Tabs: a data-tabs bar of buttons each with data-tab="panel-id". Flows across screens: sections with data-screen="checkout" (the first shows) and buttons with data-goto="confirm". data-toast="Saved" shows a toast. Overlays start hidden. Write a script for anything else. Check each state with sketch_snapshot and click.\n\n' +
          'Glassbox\'s styles below sit underneath the sketch\'s own, so a class you define (.note, .card…) always wins; bare: true drops them altogether. Real images and fonts: refer to files on disk in src, href or CSS url() (a path relative to the project, an absolute path, or file://), e.g. a screenshot you took or the app\'s own font files; Glassbox brings them along (nothing loads from the network). Revisions: send html_file (a file you wrote) or edits (find and replace on the previous version) instead of the whole page again. stylesheet picks which CSS file the project colours come from. bare: true leaves out Glassbox\'s plain-element styles and classes. Check your work with sketch_snapshot.',
        {
          id: z.string().describe('Stable slug, e.g. "settings-layout"; the same id again is a new version'),
          title: z.string().describe('What it shows, e.g. "Settings: three layouts"'),
          html: z.string().optional().describe('The sketch: an HTML fragment with any inline <style> and <script>'),
          html_file: z.string().optional().describe('Or a file with the HTML (relative to the project, or absolute)'),
          edits: z.array(z.object({ find: z.string(), replace: z.string() })).optional().describe('Or changes to the previous version of this id: each find (exact text, once) becomes replace'),
          width: z.number().int().min(320).optional().describe('Page width in px it is drawn at (default 1200; 390 for a phone; as wide as you need for frames side by side)'),
          stylesheet: z.string().optional().describe('The CSS file (or Tailwind config) the project colours come from, if not the one Glassbox picks'),
          bare: z.boolean().optional().describe("true: leave out Glassbox's styles for plain elements and its classes (.card, .row…)"),
          look: z.boolean().optional().describe('The answer includes a picture of the sketch as drawn, and any console errors (default true); false to skip it'),
          note: z.string().optional().describe('One line on what changed in this version'),
          scheme: z.enum(['project', 'match', 'dark', 'light']).optional().describe("Leave out (the project's own colours, else the user's scheme); match, dark or light for Glassbox's look"),
          accent: z.enum(['match', 'teal', 'blue', 'violet', 'green', 'amber', 'rose']).optional().describe("Leave out (the user's accent) unless the user asks for another")
        },
        async ({ id, title, html, html_file, edits, width, note, scheme, accent, stylesheet, bare, look }) => {
          const root = cwd ?? process.cwd()
          const prev = latestSketch(root, id)
          // The page: given, read from a file, or the previous version with edits made to it.
          let page = html?.trim() ? html : undefined
          if (page == null && html_file) {
            try {
              page = readFileSync(isAbsolute(html_file) ? html_file : resolvePath(root, html_file), 'utf8')
            } catch (e) {
              return { ...ok(`Couldn't read ${html_file}: ${(e as Error).message}`), isError: true }
            }
          }
          if (page == null && edits?.length) {
            const base = prev ? readSketch(prev.ref) : null
            if (base == null) return { ...ok(`There's no earlier version of "${id}" to edit; send html (or html_file) once.`), isError: true }
            page = base
            const missed: string[] = []
            for (const e of edits) {
              const at = page.indexOf(e.find)
              if (at < 0) missed.push(e.find.slice(0, 80))
              else page = page.slice(0, at) + e.replace + page.slice(at + e.find.length)
            }
            if (missed.length) return { ...ok(`No change made: not found in the previous version: ${missed.map((m) => JSON.stringify(m)).join(', ')}`), isError: true }
          }
          if (page == null || !page.trim()) return { ...ok(html != null ? 'The html was empty, so nothing was saved. Send the page as html or html_file, or change the previous version with edits.' : 'Send html, html_file or edits.'), isError: true }
          const w = width ?? prev?.width
          const sheet = stylesheet ?? prev?.stylesheet
          const plain = bare ?? prev?.bare
          const ref = keepSketch(page)
          setLatestSketch(root, id, { ref, width: w ?? 1200, stylesheet: sheet, bare: plain })
          const assets = withAssets(page, root)
          emit({ type: 'sketch', id, title, html: page, ref, width: w, note, scheme, accent, stylesheet: sheet, bare: plain })
          const style = projectStyle(root, sheet)
          const drawnIn = !scheme || scheme === 'project' ? describeStyle(style) : null
          // What it looks like, so Claude sees what it drew (and any script errors) without asking.
          let picture: Awaited<ReturnType<typeof sketchSnapshot>> | null = null
          if (look !== false) {
            const set = style.light ?? style.dark
            const vars = set && (!scheme || scheme === 'project') ? { base: style.light ? 'light' : 'dark', ...set } : {}
            picture = await sketchSnapshot(`${sketchUrl(page, root)}?t=${encodeURIComponent(JSON.stringify(vars))}${plain ? '&b=1' : ''}`, w ?? 1200).catch(() => null)
          }
          const cut =
            (picture?.next ? ` The picture stops at ${picture.next}px of ${picture.height}px; see the rest with sketch_snapshot and top.` : '') +
            (picture && picture.width > (w ?? 1200) ? ` Its content spills to ${picture.width}px wide, past the page's ${w ?? 1200}px (the picture and the Sketches view show all of it).` : '') +
            (picture && picture.scale < 0.75 ? ` The picture is scaled to ${Math.round(picture.scale * 100)}%; to read small text, look at a part with sketch_snapshot (selector, or top and height).` : '')
          const text =
            `Sketch "${title}" (id ${id}) is in the Sketches view${drawnIn ? `, drawn in ${drawnIn}` : !scheme || scheme === 'project' ? ", in Glassbox's colours (no project colours were found)" : ''}.` +
              (assets.found ? ` ${assets.found} local file${assets.found === 1 ? '' : 's'} brought along.` : '') +
              (assets.missing.length ? ` Not found (shown broken): ${assets.missing.slice(0, 5).join(', ')}.` : '') +
              (picture ? ` The picture is how it draws, ${Math.max(w ?? 1200, picture.width)}px wide and ${picture.height}px tall.${cut}${picture.logs.length ? ` Console: ${picture.logs.join(' | ')}` : ' No console errors.'}` : '') +
              ` Revise with edits or html_file, not the whole page (if your show_sketch has no edits parameter, look it up again with tool search). [sketch-ref:${ref}]`
          return picture ? { content: [{ type: 'text' as const, text }, { type: 'image' as const, data: picture.png.toString('base64'), mimeType: 'image/png' }] } : ok(text)
        },
        READ_ONLY
      ),
      tool(
        'pr_overview',
        'Write the overview of a pull request that Glassbox shows the user and reviewers in its PR overview view. Use it only when the user (or Glassbox for them) asks for a PR overview. Base everything on the actual diff (`git diff <base>...HEAD`) and what you know from this session.\n\n' +
          'Size it to the change. It is an overview, not a file list: only summary and size are required; leave out every other part when it has nothing real to say. A one-line text change is just a one-sentence summary, the one file in changes, and that line as code. A large feature can use every part. Never pad.\n\n' +
          'Parts: changes (only for a change of one or two files: each with a line on what changed); areas and links (required unless the change is tiny: the 3 to 6 parts of the system the change touches, each with its kind, whether it is added, changed or removed, its files and a short note, and links between them for how one calls, renders or feeds another; Glassbox draws them as boxes with arrows); code (one or two diff excerpts worth reading, each titled with what it shows, e.g. "How a Chat page link takes the conversation into the pane"; never a dump of the change); screens (REQUIRED whenever the change alters anything a person sees: sketch each screen that looks or behaves differently, as it looks after the change, and before and after side by side when the look changed; pass html (or an id from show_sketch), drawn as the real screen looks, in the project colours and layout); assets (images, icons, fonts, media added or changed); notes (at most 3, only what a reviewer must know: breaking changes, migrations, config or environment variables, new dependencies, security, performance, follow-ups left for later); deviations (at most 2: where this code does something differently from how the rest of the codebase does it: the usual way, what this does, and why; check against similar code in the repo before claiming one); risks (at most 3 real ones: what could go wrong, how likely, and what limits it; one sentence of detail each); diagrams (Mermaid, only where structure or a flow changed); testing (up to 4 of each: what was tested, and how a reviewer can check it); reviewFocus (at most 3: where to look hardest). Keep every line short: a title of a few words, a detail of one sentence.',
        {
          pr: z.object({ number: z.number().int().optional(), url: z.string().optional(), title: z.string() }).optional(),
          size: z.enum(['tiny', 'small', 'medium', 'large']),
          headline: z.string().optional().describe('One plain sentence a new joiner would understand, about what people will notice (no code names), e.g. "The Chat menu now opens the full Chat page, and links in a chat keep the conversation beside the page"'),
          summary: z.string().describe('What changed and why, for a developer: two or three sentences'),
          changes: z.array(z.object({ path: z.string().describe('Relative to the repo root'), what: z.string().describe('One line on what changed in it') })).optional().describe('Only for a change of one or two files; otherwise use areas'),
          areas: z.array(z.object({ id: z.string(), title: z.string().describe('Two or three words, e.g. "Sidebar nav", "Answer library API"'), kind: z.enum(['ui', 'ai', 'api', 'logic', 'data', 'infra', 'config', 'tests', 'docs']), change: z.enum(['added', 'changed', 'removed']), files: z.array(z.string()).optional(), note: z.string().optional().describe('What changed there, in a few words') })).optional(),
          links: z.array(z.object({ from: z.string().describe('An area id'), to: z.string().describe('An area id'), label: z.string().optional().describe('e.g. "calls", "renders", "writes"') })).optional(),
          code: z.array(z.object({ title: z.string().optional().describe('What this code shows, as a heading'), path: z.string(), note: z.string().optional(), diff: z.string().describe('A short unified diff excerpt (lines starting with +, - or space; @@ headers allowed)') })).max(3).optional(),
          screens: z.array(z.object({ title: z.string(), sketch: z.string().optional().describe('Id of a sketch already shown with show_sketch'), html: z.string().optional().describe('Or the sketch itself, as for show_sketch'), width: z.number().int().min(320).max(2400).optional() })).optional().describe('Required when anything a person sees changed'),
          assets: z.array(z.object({ path: z.string(), note: z.string().optional() })).optional(),
          notes: z.array(z.object({ kind: z.enum(['breaking', 'migration', 'config', 'dependency', 'security', 'performance', 'follow-up', 'other']), title: z.string(), detail: z.string().optional() })).optional(),
          deviations: z.array(z.object({ title: z.string(), where: z.string().optional().describe('path or path:line'), usual: z.string().describe('How the codebase usually does this'), here: z.string().describe('What this change does instead'), why: z.string() })).optional(),
          risks: z.array(z.object({ level: z.enum(['low', 'medium', 'high']), title: z.string(), detail: z.string().optional(), mitigation: z.string().optional() })).optional(),
          diagrams: z.array(z.object({ title: z.string(), mermaid: z.string() })).optional(),
          testing: z.object({ done: z.array(z.string()).optional(), howTo: z.array(z.string()).optional() }).optional(),
          reviewFocus: z.array(z.string()).optional()
        },
        async (overview) => {
          emit({ type: 'overview', overview })
          return ok('The PR overview is in Glassbox\'s PR overview view. The user can copy it or add it to the pull request description from there.')
        },
        READ_ONLY
      ),
      tool(
        'sketch_snapshot',
        'See a sketch you made, as it is drawn (in the project colours), and anything its console or scripts reported while it loaded. With no area: the whole page in one picture, scaled to fit. To read detail (a diagram\'s labels, small text), look at one part at full size: selector (one element, e.g. "svg" or "#erd"), or top, left, height and area_width in page pixels. Use it to check layout, overflow and that images and fonts loaded.',
        {
          id: z.string().describe('The sketch id'),
          width: z.number().int().min(320).optional().describe('Draw the page at this width instead of its own'),
          selector: z.string().optional().describe('Show just this element (the first match), at full size'),
          click: z.array(z.string()).optional().describe('CSS selectors to click first, in order (e.g. ["#open-refund"] to see the modal open, or a data-goto button to see the next screen)'),
          top: z.number().int().min(0).optional().describe('Show the part from this many px down (2400px of it unless height is given)'),
          left: z.number().int().min(0).optional().describe('Show the part from this many px across'),
          height: z.number().int().min(50).optional().describe('How tall a part to show, in px'),
          area_width: z.number().int().min(50).optional().describe('How wide a part to show, in px (default: to the right edge)')
        },
        async ({ id, width, selector, click, top, left, height, area_width }) => {
          const root = cwd ?? process.cwd()
          const v = latestSketch(root, id)
          const page = v ? readSketch(v.ref) : null
          if (!v || page == null) return { ...ok(`No sketch "${id}" in this project.`), isError: true }
          const style = projectStyle(root, v.stylesheet)
          const set = style.light ?? style.dark
          const vars = set ? { base: style.light ? 'light' : 'dark', ...set } : {}
          const url = `${sketchUrl(page, root)}?t=${encodeURIComponent(JSON.stringify(vars))}${v.bare ? '&b=1' : ''}`
          const shot = await sketchSnapshot(url, width ?? v.width, { selector, top, left, height, width: area_width }, click ?? []).catch((e: unknown) => (e instanceof Error ? e.message : String(e)))
          if (typeof shot === 'string') return { ...ok(shot), isError: true }
          const r = shot.region
          const whole = r.x === 0 && r.y === 0 && r.w >= shot.width && r.h >= shot.height
          return {
            content: [
              { type: 'image' as const, data: shot.png.toString('base64'), mimeType: 'image/png' },
              {
                type: 'text' as const,
                text:
                  `Drawn at ${width ?? v.width}px wide; the page is ${shot.width}×${shot.height}px. ` +
                  (whole ? 'This picture is all of it' : `This picture shows x ${r.x}–${r.x + r.w}, y ${r.y}–${r.y + r.h}`) +
                  (shot.scale < 1 ? `, scaled to ${Math.round(shot.scale * 100)}% (look at a smaller part to read detail).` : ', at full size.') +
                  (shot.next ? ` Pass top: ${shot.next} for the next part.` : '') +
                  (click?.length ? ` Clicked ${click.length - shot.missed.length} of ${click.length} first${shot.missed.length ? `; not found: ${shot.missed.join(', ')}` : ''}.` : '') +
                  (shot.logs.length ? `\nConsole:\n${shot.logs.join('\n')}` : ' Nothing in the console.')
              }
            ]
          }
        },
        READ_ONLY
      ),
      // The project's component library (in Glassbox, not the repo): copies of the app's real components, for building screens.
      tool(
        'save_component',
        "Save a copy of one of the app's real components to the project's component library in Glassbox (kept outside the repo), so the user can build screens from it in the Screens view. Read the component's source first and recreate it faithfully as one HTML fragment with its own <style> (class names prefixed so they don't clash), using the project's colours as CSS variables (var(--accent), var(--bg), var(--surface), var(--fg), var(--muted), var(--border), var(--radius)) and real copy. Nothing loads from the network. kind 'shell' is the app's frame (header, sidebar, page padding) with the empty content area marked data-slot; screens can start from it. Saving the same name again replaces it. Only when the user asks for components.",
        {
          name: z.string().min(1).describe('What developers call it, e.g. "Primary button", "Order card"'),
          html: z.string().min(1).describe('The component as an HTML fragment with its own <style>'),
          kind: z.enum(['component', 'shell', 'icon']).optional().describe("'shell' for the app's frame (with a data-slot element for the content); 'icon' for one of the app's icons (an inline SVG using currentColor, width 24)"),
          variants: z.array(z.object({ name: z.string(), html: z.string() })).optional().describe('Other looks of it (secondary, disabled, error…), each as its own HTML'),
          source: z.string().optional().describe('The source file it copies, relative to the project'),
          usage: z.string().optional().describe('How code uses it, e.g. "<Button variant=\"primary\">" from "@/components/Button"'),
          width: z.number().int().min(16).max(4000).optional().describe('The width it is usually drawn at (a shell: the app width, e.g. 1440)'),
          height: z.number().int().min(16).max(6000).optional().describe("A shell's height, e.g. 900")
        },
        async ({ name, html, kind, variants, source, usage, width, height }) => {
          const root = cwd ?? process.cwd()
          if (kind === 'shell' && !/\bdata-slot\b/.test(html)) return { ...ok('A shell needs the element where a screen\'s content goes marked data-slot. Nothing was saved.'), isError: true }
          const saved = saveLibrary(root, 'components', { id: kind === 'shell' || kind === 'icon' ? `${kind}-${componentId(name)}` : componentId(name), name, kind: kind ?? 'component', html: withAssets(html, root).html, variants: variants?.map((v) => ({ ...v, html: withAssets(v.html, root).html })), source, sourceHash: sourceHash(root, source), usage, width, height })
          // What it looks like in the project's colours, so Claude can check it against the real one.
          const style = projectStyle(root)
          const set = style.light ?? style.dark
          const vars = set ? { base: style.light ? 'light' : 'dark', ...set } : {}
          const page = `<style>body { margin: 0; padding: 16px; }</style>${html}${(variants ?? []).map((v) => `<div style="margin-top: 16px">${v.html}</div>`).join('')}`
          const picture = await sketchSnapshot(`${sketchUrl(page, root)}?t=${encodeURIComponent(JSON.stringify(vars))}&b=1`, Math.max(320, (width ?? 600) + 32)).catch(() => null)
          const text = `Saved "${name}" (${saved.kind}${variants?.length ? `, ${variants.length} variant${variants.length === 1 ? '' : 's'}` : ''}) to the component library. It's in the Screens view.${picture ? ` The picture is how it draws.${picture.logs.length ? ` Console: ${picture.logs.join(' | ')}` : ''}` : ''}`
          return picture ? { content: [{ type: 'text' as const, text }, { type: 'image' as const, data: picture.png.toString('base64'), mimeType: 'image/png' }] } : ok(text)
        }
      ),
      tool(
        'list_components',
        "The project's component library in Glassbox: each component's name, kind, variants and the source file it copies.",
        {},
        async () => {
          const list = listLibrary(cwd ?? process.cwd(), 'components')
          if (!list.length) return ok('The component library is empty.')
          return ok(list.map((c) => `- ${c.name} (${c.kind}${c.variants?.length ? `; variants: ${c.variants.map((v) => v.name).join(', ')}` : ''})${c.source ? ` from ${c.source}` : ''}`).join('\n'))
        }
      ),
      tool(
        'delete_component',
        'Remove a component from the project\'s component library, by name.',
        { name: z.string() },
        async ({ name }) => {
          const root = cwd ?? process.cwd()
          const hit = listLibrary(root, 'components').find((c) => c.name.toLowerCase() === name.toLowerCase())
          if (!hit) return { ...ok(`No component called "${name}".`), isError: true }
          deleteLibrary(root, 'components', hit.id)
          return ok(`Removed "${hit.name}".`)
        }
      ),
      tool(
        'delete_sketch',
        'Remove a sketch from the Sketches view, e.g. a test or one that is no longer relevant.',
        { id: z.string() },
        async ({ id }) => {
          if (!latestSketch(cwd ?? process.cwd(), id)) return { ...ok(`No sketch "${id}" in this project, so nothing was removed.`), isError: true }
          setLatestSketch(cwd ?? process.cwd(), id, null)
          emit({ type: 'sketch-delete', id })
          return ok(`Sketch "${id}" removed.`)
        },
        READ_ONLY
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
        READ_ONLY
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
        READ_ONLY
      ),
      tool(
        'pin_file',
        'Pin a file in the Glassbox Changes panel so the user can review it.',
        { path: z.string().describe('Absolute path, or relative to the working directory'), reason: z.string().optional() },
        async ({ path, reason }) => {
          emit({ type: 'pin', path, reason })
          return ok(`Pinned ${path}.`)
        },
        READ_ONLY
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
        READ_ONLY
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
        READ_ONLY
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
        READ_ONLY
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
        READ_ONLY
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
        READ_ONLY
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
        READ_ONLY
      ),
      tool(
        'open_diff',
        "Open the diff of a file you changed, so the user can review exactly what changed.",
        { path: z.string(), why: z.string().optional().describe('One short line shown above the diff') },
        async ({ path, why }) => {
          emit({ type: 'open', target: { view: 'diff', path }, why })
          return ok(`Opened the diff of ${path} for the user.`)
        },
        READ_ONLY
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
        READ_ONLY
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
        READ_ONLY
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
        READ_ONLY
      ),
      tool(
        'show_progress',
        "Show (or update) a named loader just above the user's message box, for work that runs several minutes: watching a deploy or CI run (steps for its stages, or watch its log), a full test suite or build (watch its log for a percent or done line), a service starting (watch its url), a migration or a multi-file change (step N of M). Use it ONLY where there's real progress to show. Starting one needs step and steps (e.g. step 1 of 4), a known percent, or watch; without one of those it's refused. Move it along with step (or percent) and detail as each part finishes, or pass watch and Glassbox moves it: done when a url answers or a file appears, or percent and done read from a log file. Not for ordinary commands or quick checks.",
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
        READ_ONLY
      ),
      tool(
        'open_preview',
        'Show the user a page (usually of the running app) in the Glassbox Browser. To read or use the page yourself, use browser_open instead.',
        { url: z.string().describe('http(s) URL, usually a local dev server'), why: z.string().optional() },
        async ({ url, why }) => {
          emit({ type: 'open', target: { view: 'preview', url }, why })
          return ok(`Opened ${url} in the Browser.`)
        },
        READ_ONLY
      ),
      tool(
        'open_tab',
        'Bring one of the Glassbox views to the front: overview (the PR overview, after pr_overview); conversation; plan (your plan, to approve or reread); map (the parts of the project this work touches); database (tables and how they connect; use show_database to focus an area); diagrams (after show_diagram); sketches (after show_sketch); flows (after show_flow); live (each file as you edit it); terminal (the user\'s own shell in this folder, for a command they should run themselves); browser (web pages; use open_preview for a URL); attachments (files they attached and files you made); replay (step back through the session).',
        { tab: z.enum(['conversation', 'plan', 'map', 'database', 'diagrams', 'sketches', 'flows', 'live', 'terminal', 'browser', 'attachments', 'replay', 'overview']), why: z.string().optional() },
        async ({ tab, why }) => {
          emit({ type: 'open', target: { view: 'tab', tab }, why })
          return ok(`Showing ${tab}.`)
        },
        READ_ONLY
      ),
      ...(app ? appTools(app, emit) : []),
      // How the project's services start: Glassbox keeps it, so Claude reads and changes it here, not as a file in the repo.
      tool(
        'get_services',
        "How this project's services are set up in Glassbox (what the Run button and start_app start), as JSON; or that none are yet.",
        {},
        async () => {
          const f = servicesFile(cwd ?? process.cwd())
          return ok(existsSync(f) ? readFileSync(f, 'utf8') : 'No services are set up for this project yet. Set them up with save_services.')
        }
      ),
      tool(
        'save_services',
        "Save how this project's services start (the whole list, replacing what was there). Glassbox keeps it outside the repo, per project folder. Give every app service its usual port and write ${port} (its own) and ${port:name} (another service's) in command, env and url instead of fixed ports; leave shared infrastructure (databases, docker compose) without one.",
        {
          services: z
            .array(
              z.object({
                name: z.string().min(1),
                command: z.string().min(1).describe('The command to run, e.g. "npm run dev -- --port ${port}"'),
                cwd: z.string().optional().describe('Folder to run it in, relative to the project'),
                port: z.number().int().positive().optional().describe('The port it normally uses'),
                env: z.record(z.string(), z.string()).optional(),
                url: z.string().optional().describe('Where to open it, e.g. "http://localhost:${port}"'),
                readyPattern: z.string().optional().describe('A regular expression its output matches once it is ready'),
                dependsOn: z.array(z.string()).optional().describe('Services to start first'),
                autostart: z.boolean().optional()
              })
            )
            .describe('Every service, in order')
        },
        async ({ services }) => {
          const names = new Set(services.map((x) => x.name))
          const missing = services.flatMap((x) => (x.dependsOn ?? []).filter((d) => !names.has(d)).map((d) => `${x.name} depends on "${d}", which isn't in the list`))
          if (missing.length) return { ...ok(`Not saved: ${missing.join('; ')}.`), isError: true }
          const f = servicesFile(cwd ?? process.cwd())
          writeFileSync(f, JSON.stringify({ services }, null, 2))
          app?.().load()
          return ok(`Saved ${services.length} service${services.length === 1 ? '' : 's'}: ${services.map((x) => x.name).join(', ')}. The Run button and start_app use them now.`)
        }
      ),
      ...(browser ? browserTools(browser.bridge, browser.shotsDir, browser.hooks) : []),
      ...(ux
        ? [
            tool(
              'review_ux',
              "The UX reviewer: a separate agent that looks over screenshots for bad UX, inconsistencies between screens and AI slop, in the background so you carry on meanwhile; its findings appear in the user's Findings as they're ready. Pass images (screenshot or image file paths) to send them for review (browser_screenshot with review does the same for a screenshot it takes). Pass wait to wait for everything sent so far to be reviewed and get all its findings back, e.g. before writing a report.",
              {
                images: z.array(z.string()).optional().describe('Image files to review (png, jpg, webp)'),
                note: z.string().optional().describe('What these screens are, for the reviewer'),
                reference: z.string().optional().describe('Instead of reviewing them, keep these images as the reference for a kind of screen (e.g. "list page"): established pages new screens of that kind are compared with'),
                wait: z.boolean().optional().describe('Wait for the reviews to finish and return every finding so far')
              },
              async ({ images, note, reference, wait }) => {
                if (reference) {
                  const kept = (images ?? []).filter((p) => ux.addReference({ path: p, note, kind: reference })).length
                  return ok(`Kept ${kept} as the reference for "${reference}": screens sent for review from now on are compared with it.`)
                }
                const queued = (images ?? []).filter((p) => ux.add({ path: p, note })).length
                if (!wait) return ok(images?.length ? `Sent ${queued} of ${images.length} for review${queued < images.length ? ' (the rest were already sent, missing, or not images)' : ''}. Findings arrive in Findings as they're ready; carry on.` : `Reviewed ${ux.status().reviewed} screenshots so far, ${ux.status().pending} waiting.`)
                await ux.flush()
                const st = ux.status()
                const list = st.findings.map((f) => `- [${f.severity}] ${f.title}${f.page ? ` (${f.page})` : ''}${f.detail ? `: ${f.detail}` : ''}${f.suggestion ? ` Suggested: ${f.suggestion}` : ''}${f.image ? ` [screenshot: ${f.image}]` : ''}`).join('\n')
                return ok(`${st.reviewed} screenshots reviewed${st.pending ? `, ${st.pending} still waiting (stopped waiting)` : ''}. ${st.findings.length ? `UX findings:\n${list}` : 'No UX findings.'}`)
              },
              READ_ONLY
            )
          ]
        : []),
    ]
  })
}

/** The session's services as a short status list, with each one's URL. */
function describeServices(p: ProjectServices): string {
  const snap = p.snapshot()
  if (!snap.exists) return "This project has no services set up in Glassbox yet, so it doesn't know how to run it. Set them up with save_services (see your instructions), then call start_app."
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
      READ_ONLY
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
      READ_ONLY
    ),
    tool(
      'app_logs',
      "Read a service's recent output (build errors, stack traces, request logs).",
      { service: z.string(), lines: z.number().int().positive().max(400).optional().describe('How many of the latest lines (default 80)') },
      async ({ service, lines }) => {
        const out = app().logs(service)
        return ok(out.length ? out.slice(-(lines ?? 80)).join('\n') : `No output from ${service} yet.`)
      },
      READ_ONLY
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
      READ_ONLY
    )
  ]
}
