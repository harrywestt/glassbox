# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(An Electron desktop app for Windows first; the interface is HTML/CSS rendered by Chromium, so web design rules apply. It should still feel like a native desktop tool, not a website.)

## Users

Developers who use Claude Code for real work. Today that's the author; the aim is to make it public, so it must make sense to someone who has never seen it, without a walkthrough.

They sit with Glassbox open next to (or instead of) their editor while Claude works on a task in their repo. Their jobs, in priority order:

1. **Watch and steer live.** Follow what Claude is doing and step in before it goes wrong: answer a question, comment on a step, stop it.
2. **Juggle several sessions.** Run a few sessions at once and see at a glance which one needs them.
3. **Review the changes.** Read the diffs, decisions and risks as they happen, so there are no surprises at PR time.

Tracking the linked ticket (e.g. Jira) is useful but secondary.

## Product Purpose

Glassbox hosts Claude Code sessions (through the Claude Agent SDK) and makes everything they do visible and steerable while it happens: context, tool calls, subagents, edits, decisions, tests and usage. Success is that the user trusts what Claude did without having to reconstruct it afterwards, and catches problems mid-task rather than at review.

## Positioning

The Claude Code CLI shows a scrolling transcript; editors show the result. Glassbox is the review-while-it-works layer in between: comments reach Claude mid-turn, Claude logs its decisions and questions as structured items, a second model reviews edits as they land, guardrails enforce rules on every tool call, and check-ins genuinely pause Claude until the user answers.

## Operating Context

- Runs locally with the user's existing Claude Code login and settings (CLAUDE.md, skills, MCP servers, claude.ai connectors all apply).
- Sessions work inside git repos; branches often carry a ticket key (e.g. `NSD-1234-slug`).
- Long sessions: the window stays open for hours, often on a second monitor, glanced at rather than read continuously.
- Multiple sessions run in parallel in tabs; a tray icon and desktop notifications pull the user back when one needs them.
- Users switch between this and their editor, terminal and browser constantly, so familiarity with VS Code conventions (tabs, side panels, command-like density) lowers the learning cost.

## Capabilities and Constraints

- Conversation timeline with streaming text and thinking, grouped tool calls, inline edit diffs, tests, service errors.
- Composer with slash commands, hold-Space voice input (local Whisper), predicted next message, plan-first mode, attachments, and a Stop action.
- Questions and check-ins answered from the composer; a decisions log (decisions, assumptions, questions) that can be challenged.
- Changes against the base branch, live follow of Claude's edits, single-edit undo, automatic commits and git history, checkpoints and rewind.
- Rolling review: background reviewer findings, change radar (dependencies, env vars, config, migrations, contracts, secrets), blast radius, guardrails and side effects.
- Services per session with their own ports, app preview, test signals, loop detection.
- Context view and heatmap, subagents, diagrams, replay, showcase publishing, share view, connectors and skills, raw events.
- Dashboard: plan usage, token history, session history, GitHub activity.
- Per-command admin elevation on Windows (UAC).
- Light and dark themes via CSS tokens; user-set accent, text sizes, chat width and table style.
- Undecided: how a Jira/ticket view connects (API token vs Claude connector), and how tickets are targeted beyond the branch-name convention.

## Brand Commitments

- Name: Glassbox. The metaphor is transparency: nothing Claude does is hidden.
- Voice: plain, direct, specific. Name things by what the user recognises; no cute copy, no over-explaining.
- The author has explicitly rejected UI that "looks AI generated": decorative left-border stripes, pills everywhere, cluttered rows, inconsistent spacing. Spacing must be even and consistent; the interface should be clean, simple to use and uncluttered.

## Evidence on Hand

- The working app itself (`src/renderer`), and current screenshots of every screen in dark theme from the design tour.
- A written design audit of the current UI (header overload, five tab styles, eleven control heights, 23 radii, helper-text clutter).
- No users, testimonials or metrics yet; don't invent any.

## Product Principles

1. **The conversation is the work; everything else supports it.** Nothing should compete with following and steering Claude.
2. **What needs you comes to you.** Questions, check-ins, failures and blocked steps surface where the user is already looking, with a clear way to act.
3. **Everything is findable in one step.** No feature hides two levels deep behind an icon; rarely used things can live one click away.
4. **Show, don't explain.** The UI should be legible without helper paragraphs; empty things hide or say one line.
5. **Calm by default, loud only when it matters.** Colour and motion signal state changes that need attention, not decoration.
