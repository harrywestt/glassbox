<p align="center">
  <img src="resources/icon.png" width="96" alt="Glassbox logo: code brackets around a red on-air lamp">
</p>

<h1 align="center">Glassbox</h1>

<p align="center"><b>Watch Claude Code work, and steer it while it does.</b><br>
A desktop app for Claude Code that shows every plan, edit, command and agent as it happens, so there are no surprises at review time.</p>

<p align="center">
  <a href="https://github.com/harrywestt/glassbox/releases/latest"><b>Download for Windows</b></a> ·
  <a href="#install">Install</a> ·
  <a href="#how-to-use-it">How to use it</a> ·
  <a href="#run-it-from-source">Run from source</a>
</p>

## Why

The Claude Code CLI gives you a scrolling transcript, and your editor shows you the result. Glassbox is the layer in between. You approve the plan before anything changes, watch edits land on a map of your code, comment on a step mid-turn, and run several sessions side by side without them tripping over each other.

It runs on your machine with your existing Claude Code sign-in and settings. Your `CLAUDE.md`, skills, MCP servers and claude.ai connectors all apply.

## Install

**Windows:** download `Glassbox-Setup-<version>.exe` from the [latest release](https://github.com/harrywestt/glassbox/releases/latest) and run it.

- It installs for your user only (no admin rights needed) into `%LOCALAPPDATA%\Programs\Glassbox`, adds Start menu and desktop shortcuts, and is removed like any other app from **Settings > Apps**.
- The installer isn't code-signed yet, so Windows SmartScreen may warn about an unknown publisher. Choose **More info**, then **Run anyway**.
- A new release is built automatically on every push to `main`. Running a newer installer upgrades in place and keeps your sessions and settings.

**You'll also need:**

- **Claude Code**, signed in on this machine: `npm install -g @anthropic-ai/claude-code`, then `claude auth login`. Glassbox uses the same account and plan.
- **Git**, for branches, diffs, worktrees and automatic commits. Git for Windows also provides the Bash used by `!` commands.
- *Optional:* the **GitHub CLI** (`gh auth login`) for pull requests, reviews and the dashboard's GitHub section.

**macOS and Linux:** there's no packaged build yet; [run it from source](#run-it-from-source).

## How to use it

1. **Open a session** in your project folder with **+** (or Ctrl+T). Pick what you're doing: build from a ticket, review a pull request, plan an idea, write a PRD, or start blank.
2. **Ask for a change.** Turn on **Plan first** and Claude plans the work before it touches anything.
3. **Approve the plan.** It opens in its own **Plan** tab. Read it, request changes or approve it. The rest of the app stays usable while it waits.
4. **Watch it work.** The conversation shows every step. **Map** shows which parts of your code it's in, **Live changes** follows each edit with its diff, and **Changes** keeps the running diff against your base branch.
5. **Step in whenever you like.** Comment on any step, message, decision or line of a diff, and Claude reads it during the current turn. Press Stop to halt it.
6. **Run a command yourself.** Start a message with `!` (for example `! git status`) to run it in the session's folder. Claude sees the command and its output with your next message.
7. **Run sessions side by side.** When a second session opens in a repo already in use, Glassbox offers it its own git worktree (kept inside the repo under `.claude/worktrees`). Each session runs its own copy of your services on its own random ports.

## What's in it

**Views** (tabs next to the conversation; open any of them from **+**, and keep the ones you want for a project with the pin)

| View | What it shows |
|---|---|
| Plan | Claude's plan to approve, or to read again later |
| Map | The parts of the project this conversation works in, how they connect, and which ones Claude has edited. Switch to the whole project, fold groups and search |
| Live changes | Each file as Claude edits it, with its full diff and an "Ask why" on any edit |
| Ripple | What a change could affect, and what's covered by tests |
| Flow | How a request moves through the system, before and after the change |
| Database | Tables and how they connect, read from your migrations or schema. Ask for an area to focus on |
| Diagrams | Diagrams Claude draws in the conversation |
| Browser | Web pages inside Glassbox, in tabs that keep your sign-ins. Claude browses here too |
| Terminal | Your own shell in the session's folder |
| Attachments | Files you attached and files Claude made |
| Showcase, Replay | A shareable deck of the work, and a step-through of the whole session |

**Side panels:** Route (what's happening now, running agents, services), Decisions (choices, assumptions and questions Claude logged, which you can challenge), Changes, Ticket, Git, Guardrails, Explorer, Context, Connectors, Skills and Raw events.

**Also**

- **Guardrails** on every tool call, whatever your permission mode: block or ask for things like force pushes, `terraform apply`, recursive deletes, SQL drops, and connector actions that send or change things. Add your own rules.
- **Check-ins and questions:** when Claude isn't sure about something consequential it asks, and genuinely waits for your answer.
- **Everyday or Engineering view:** keep the conversation, diagrams and decisions, or add the engineering side (map, changes, flows).
- **Voice:** hold Space to dictate. Transcribed on your machine, so audio never leaves it.
- **Pinned sessions:** pin a session to keep its history even after Claude Code would clear it.
- **Share:** a read-only live view for teammates on your network, or a two-line handoff message with the PR link.
- **Dashboard:** plan usage and limits, tokens per day, searchable session history and your GitHub pull requests.
- **Tray and notifications:** see at a glance which session needs you.

## Services

Put `.glassbox/services.json` in your project (or ask Claude to "set up services" and it will write one). **Run all** starts them in dependency order.

```json
{
  "services": [
    { "name": "db", "command": "docker compose up postgres", "readyPattern": "ready to accept connections" },
    { "name": "api", "command": "npm run api -- --port ${port}", "port": 3000, "readyPattern": "listening", "dependsOn": ["db"] },
    { "name": "web", "command": "npm run web -- --port ${port}", "port": 5173,
      "env": { "API_URL": "http://localhost:${port:api}" }, "url": "http://localhost:${port}", "dependsOn": ["api"] }
  ]
}
```

Only `name` and `command` are required. A service with a `port` gets a random free port in each session. `${port}` is its own port and `${port:api}` is another service's, so each session's web app talks to that session's API. `PORT` is set too. Shared infrastructure, such as a database, can leave `port` out.

## Run it from source

You need Node 20 or newer, plus Claude Code signed in (see [Install](#install)).

```sh
git clone https://github.com/harrywestt/glassbox
cd glassbox
npm install
npm run dev
```

| Script | What it does |
|---|---|
| `npm run dev` | Hot-reloading development build (uses its own "Glassbox Dev" profile) |
| `npm run typecheck` | TypeScript check |
| `npm run dist:installer` | Builds the Windows installer into `release/` |
| `npm run install:local` | Builds and installs the app on this Windows machine |
| `npm run icons` | Renders `icon.png` and `icon.ico` from `resources/icon.svg` |

## How it works

```
Renderer (React)  ⇄ IPC ⇄  Main process
                            ├─ AgentHost (one per tab) ── query() ── Claude Agent SDK
                            │    ├─ canUseTool / PreToolUse hook → approvals, plan review, guardrails
                            │    ├─ checkpoints                  → enableFileCheckpointing + rewindFiles
                            │    └─ glassbox MCP server          → plans on the map, diagrams, decisions, loaders, browser tools
                            ├─ ServiceRegistry ── .glassbox/services.json processes, per-session ports, logs
                            ├─ UsageService    ── plan limits + token history from local transcripts
                            ├─ GitHub          ── gh CLI (PRs, reviews, workflow runs)
                            └─ git / files     ── branches, diffs, worktrees, file tree
```

- `src/main/agentHost.ts`: session lifecycle, resume, permissions and guardrails.
- `src/renderer/src/session.ts`: turns SDK events into the timeline, tool calls, agents, files and usage. The same code rebuilds a resumed session.
- `src/renderer/src/work/*` and `src/renderer/src/panels/*`: one file per view and side panel.

## Known limits

- Windows is the only packaged platform so far. The code allows for macOS, but it hasn't been built or tested there.
- The installer isn't code-signed, so SmartScreen warns on first run.
- Plan limits come from an experimental SDK API. If it changes, the dashboard shows the error and keeps the local token history.
