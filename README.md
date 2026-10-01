# Glassbox

A desktop app that runs Claude Code sessions (through the Claude Agent SDK) and shows everything they do: context, tools, subagents, code changes, diagrams, connectors, skills and your plan usage.

## Run

```sh
npm install
node node_modules/electron/install.js   # only if the Electron binary didn't download (npm may skip install scripts)
npm run dev                             # hot-reloading dev build
npm run build && npx electron .         # production build
npm run typecheck
```

Auth works the same way as the Claude Code CLI (your existing login, or `ANTHROPIC_API_KEY`). Sessions load your user, project and local settings, so your CLAUDE.md files, skills, MCP servers and claude.ai connectors all apply.

## What's in it

**Dashboard (home tab, full width)**
- Plan usage: 5-hour and weekly limits, per-model limits and extra usage, with reset times. This comes from an idle SDK session, so no model call is made.
- Tokens per day for the last 14 days, broken down by model and by project. Read from local Claude Code transcripts, so CLI sessions are included.
- History of every past session, searchable. Click one to resume it in a tab.
- GitHub (through the `gh` CLI): your open PRs with check status, PRs awaiting your review or assigned to you, workflow runs you started, and open PR counts for the repos you work in.

**Review while Claude works** (the point of Glassbox: no surprises at PR time)
- **Comments mid-task.** Comment on a tool call, a message, a plan step, a decision or selected lines in any file or diff. Comments are sent with priority `now`, so Claude reads them during the current turn, not after it.
- **Plan first.** Toggle it in the composer: Claude plans in plan mode, you approve or request changes in a plan review, and each step lists the files it expects to touch. Edits outside the plan are flagged as drift.
- **Decisions log.** Claude records decisions, assumptions and questions (`log_decision`) as it makes them. Questions pull focus; anything can be challenged in one click.
- **Guardrails.** Enforced rules on every tool call, whatever your permission settings: block or ask for terraform apply, force push, git push, recursive deletes, SQL drops, cloud deletes, installs, PR merges, connector actions that send or change things, don't-touch files and writes outside the project. Add your own regex rules. The side-effects view classifies everything Claude did outside the conversation by risk.
- **Rolling review.** Changeset against the base branch, what needs a look (open assumptions, drift, risky actions), the latest test, lint and build results Claude ran, and checkpoints: rewind files to before any message (with a dry-run preview).
- **Acceptance criteria.** A live checklist Claude keeps up to date; a criterion only counts as tested with evidence, and "done but untested" is flagged.
- **Check-ins.** When Claude isn't confident about a consequential step it calls `check_in`, which genuinely pauses it until you pick an option or reply.
- **Background reviewer.** A fast second model (Haiku) reviews each batch of edits and flags likely bugs inline; send any flag to Claude in one click. Can be switched off per session.
- **Blast radius.** For every edited file, the files that import it and may be affected.
- **Heatmap.** The Explorer shades files by how much attention Claude gave them.
- **Replay.** Scrub through a session event by event, with the diff at each edit and what was true at that point.
- **Share.** A read-only live view teammates on your network can open (activity and decisions, never file contents), or have Claude draft a status update to a Slack channel or Jira ticket.
- **Tray.** A system-tray icon shows whether any session needs you, is working or failed.
- **Alerts and live output.** Desktop notifications when Claude needs approval, finishes, errors, loops on the same call or goes quiet for 3 minutes. Text and thinking summaries stream in as they're written. Coming back to a tab after a while shows a "While you were away" digest.

**New session launcher** (the + button or Ctrl+T). Pick the project, then what you're doing:
- **Build from a ticket:** a Jira key, GitHub issue or description. Claude fetches it, sets up an acceptance-criteria checklist, optionally creates the branch, then plans first or starts coding.
- **Review a pull request:** pick from the repo's open PRs (yours to review first). Optionally check it out into a separate worktree so Claude can run it. Claude reports findings by severity and drafts the review; nothing is posted without you.
- **Plan or explore an idea:** plan mode, so nothing changes; Claude asks questions, draws options and recommends one.
- **Write a PRD:** Claude interviews you, researches the codebase and writes `docs/prd/<name>.md`, optionally publishing to Confluence once you approve.
- **Blank session.**

**Session tabs.** Chrome-style: drag to reorder, middle-click to close, Ctrl+Tab to switch, Ctrl+W to close. Open tabs are restored and resumed on the next launch. Each session header shows the folder, git branch (with uncommitted and ahead/behind counts), status, context left, tokens, cost and a **Run** button for project services.

**Side panels** (activity bar on the right):

| Panel | What it does |
|---|---|
| Now | Current task and plan steps (with drift), the approved plan, alerts, tool calls and agents in flight, recent activity |
| Review | Rolling PR preview: changeset, what needs a look, checks run, checkpoints to rewind |
| Decisions | Decisions, assumptions and questions Claude logged, with Challenge and Answer |
| Guardrails | Side effects by risk, guardrail stops, and the rules (block, ask, off, or your own) |
| Services | Start and stop the project's services from `.glassbox/services.json`, with live logs. "Ask Claude" writes the config for you |
| Explorer | Project file tree. Mark files **must read**, **must edit** or **don't touch**, and Claude gets the marks with every message |
| Context | Real context-window breakdown (`getContextUsage`), files brought in grouped by module, memory files, loaded capabilities |
| Changes | Every file Claude edited, with a diff per change, or compare the working tree with any branch (since branching, or directly) |
| Agents | Subagent tree with each agent's brief and report. Follow one to filter the chat to what it did |
| Diagrams | Mermaid diagrams Claude pushes, plus "generate a diagram of…" |
| Connectors | claude.ai connectors and MCP servers with status and tools. Toggle per session, or **Require** one for the session |
| Skills | Every skill and command. Click **Run**, add arguments, or pin one as preferred. Also available by typing `/` in the composer |
| Showcase | Claude builds a shareable HTML deck of the session's work and publishes it as a Claude Artifact when the Artifact tool is available |
| Raw | Every SDK event and hook, filterable, plus stderr |

Light and dark themes follow the system until you toggle. Themes are token maps in `src/renderer/src/theme.ts`, so adding a custom theme means adding one entry.

## Services config

`.glassbox/services.json` in the project folder. Glassbox watches it, and Claude is told about it, so asking it to "set up services" works.

```json
{
  "services": [
    { "name": "db", "command": "docker compose up postgres", "readyPattern": "ready to accept connections" },
    { "name": "api", "command": "dotnet run --project api/App.Api", "cwd": ".", "env": { "ASPNETCORE_ENVIRONMENT": "Development" },
      "url": "http://localhost:5000", "readyPattern": "Now listening", "dependsOn": ["db"] },
    { "name": "web", "command": "pnpm dev", "cwd": "ui/web", "url": "http://localhost:3000", "dependsOn": ["api"] }
  ]
}
```

Only `name` and `command` are required. **Run all** starts services in `dependsOn` order, waiting for each `readyPattern` (up to 90 seconds). Set `"autostart": false` to leave a service out of Run all. Every service is stopped when Glassbox quits.

## How it works

```
Renderer (React)  ⇄ IPC ⇄  Main process
                            ├─ AgentHost (one per tab) ── query() ── Claude Agent SDK
                            │    ├─ starts idle, so skills/connectors/context are inspectable before the first message
                            │    ├─ canUseTool        → approval dialog and plan review (ExitPlanMode)
                            │    ├─ PreToolUse hook   → guardrails (deny / ask), enforced in every permission mode
                            │    ├─ other hooks       → subagent/compaction events; UserPromptSubmit attaches your requirements
                            │    ├─ checkpoints       → enableFileCheckpointing + rewindFiles
                            │    └─ glassbox MCP      → show_diagram, set_current_task, log_decision, pin_file, showcase_ready
                            ├─ UsageService   ── idle SDK session (plan limits) + transcript scan (token history)
                            ├─ ServiceRegistry ── .glassbox/services.json processes and logs
                            ├─ GitHub          ── gh CLI (PRs, reviews, workflow runs), cached 60s
                            └─ git / files    ── branch info, diffs, file tree
```

- `src/main/agentHost.ts`: session lifecycle, resume, permissions, requirement injection.
- `src/renderer/src/session.ts`: reducer from SDK events to timeline, tool calls, agent tree, files and usage. The same code rebuilds a resumed transcript.
- `src/renderer/src/panels/*`: one file per side panel.

## Icon

`resources/icon.svg` is the source. `npm run icons` renders `icon.png` and `icon.ico` from it.

## Dev: screenshots

`GLASSBOX_SNAPSHOTS=<steps.json>` runs a list of `{ "wait": ms, "script": "js to run in the page", "out": "file.png" }` steps against the live window, then quits. Useful for checking UI changes without clicking through them.

## Known limits

- The system prompt text isn't exposed by the SDK. The Context panel shows its size and sections, not its content.
- `usage_EXPERIMENTAL…` (plan limits) is an unstable SDK API. If it changes, the dashboard shows the error and keeps the local token history.
- Showcase publishing depends on the Artifact tool being available in SDK sessions; otherwise you get a local HTML file with a preview.
