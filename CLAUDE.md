# Glassbox: rules for working on this project

## Tokens: only the conversation spends them on its own

Glassbox must never use a model (any `query()`, any extra turn, any nudge that makes Claude do more) unless the user explicitly asked for it. The only thing that may call a model automatically is the session's conversation, working on the task the user gave it.

- Anything that generates with a model (map grouping, category names, connection explanations, Jira reads, ERD focus, stand-up, hand-off, reviews, quick answers, commit messages, summaries) runs only when the user presses a button, or after they've turned the feature on in Settings. A saved result can be shown without asking; making a new one needs the button.
- Every feature that calls a model on its own is a setting under Settings → Background Claude, marked "Uses tokens", and off by default. The one exception is prompt suggestions (a small call per turn), which the user chose to keep on.
- No hooks that push Claude into extra turns or tool calls (Stop hooks that block, "show a diagram"/"show progress" nudges, prompt-time additions beyond the user's own requirements).
- Keep the Glassbox MCP lean: short instructions that don't ask Claude to do unrequested work, and tool schemas deferred behind tool search (no `alwaysLoad`).
- SDK options that make background model calls (`promptSuggestions`, `agentProgressSummaries`) follow those settings; nudging hooks only act when "Remind Claude to show its work" is on.
- Agents start fresh with a written brief: "fork" agents (a copy of the whole conversation, on the session's model) are denied unless Settings → Models and effort allows them.
- Effort follows what the user picks in the model menu (none picked: the model's default, as in the CLI). Never force a higher effort.

When adding a feature, check it against this before shipping: if it calls a model, it needs a button or an opt-in setting.
