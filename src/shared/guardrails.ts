import type { GuardRule } from './events'

/**
 * Built-in guardrails. `pattern` is a case-insensitive regex tested against the shell command
 * (shell), the file path (edit) or the tool name (mcp). The rules with a `:` id are
 * evaluated in code instead of by pattern.
 */
export const DEFAULT_GUARDRAILS: GuardRule[] = [
  { id: 'terraform-apply', label: 'Terraform apply or destroy', scope: 'shell', pattern: '\\bterraform\\s+(apply|destroy)\\b', action: 'block', builtin: true },
  { id: 'force-push', label: 'Force push', scope: 'shell', pattern: '\\bgit\\s+push\\b.*(\\s--force\\b|\\s-f\\b|--force-with-lease)', action: 'block', builtin: true },
  { id: 'git-push', label: 'Git push', scope: 'shell', pattern: '\\bgit\\s+push\\b', action: 'ask', builtin: true },
  { id: 'git-history', label: 'Rewrite git history (reset --hard, rebase, branch -D)', scope: 'shell', pattern: '\\bgit\\s+(reset\\s+--hard|rebase|branch\\s+-D|clean\\s+-f)', action: 'ask', builtin: true },
  { id: 'rm-rf', label: 'Recursive delete', scope: 'shell', pattern: '(\\brm\\s+-[a-z]*r[a-z]*f|\\brm\\s+-[a-z]*f[a-z]*r|Remove-Item\\b.*-Recurse|\\brd\\s+/s|\\brmdir\\s+/s)', action: 'ask', builtin: true },
  { id: 'drop-sql', label: 'Drop or truncate database objects', scope: 'shell', pattern: '\\b(drop\\s+(table|database|schema)|truncate\\s+table)\\b', action: 'block', builtin: true },
  { id: 'cloud-delete', label: 'Delete cloud or cluster resources', scope: 'shell', pattern: '\\b(kubectl\\s+delete|aws\\s+\\S+\\s+(delete|terminate|remove)|az\\s+\\S+\\s+delete|gcloud\\s+.*\\sdelete)\\b', action: 'block', builtin: true },
  { id: 'install', label: 'Install packages', scope: 'shell', pattern: '\\b(npm\\s+(i|install|add)\\s+\\S|pnpm\\s+(add|install)\\s+\\S|yarn\\s+add|pip\\s+install|dotnet\\s+add\\s+.*package|cargo\\s+add|go\\s+get)', action: 'ask', builtin: true },
  { id: 'pr-merge', label: 'Merge, close or post reviews on pull requests', scope: 'shell', pattern: '\\bgh\\s+pr\\s+(merge|close|review)\\b', action: 'ask', builtin: true },
  { id: 'external-write', label: 'Connector actions that send or change things (Slack, Jira, email…)', scope: 'mcp', pattern: '^mcp__(?!glassbox__).*(send|create|update|delete|post|add|edit|transition|reply|forward|trash|share|publish)', action: 'ask', builtin: true },
  {
    id: 'open-browser',
    label: 'Opening a browser window',
    scope: 'shell',
    pattern: '(\\bstart\\s+(""\\s+)?["\']?https?://|\\bStart-Process\\b.*(https?://|chrome|msedge|firefox)|\\bexplorer(\\.exe)?\\s+["\']?https?://|\\bxdg-open\\b|\\bopen\\s+(-a\\s+\\S+\\s+)?["\']?https?://|\\b(chrome|msedge|firefox)(\\.exe)?\\b.*https?://|\\brundll32\\b.*url\\.dll|\\bwebbrowser\\b|--headed\\b|(?<![\\w-])--open\\b(?!=false)|\\bhyperframes\\s+preview\\b(?!.*--no-open))',
    action: 'block',
    builtin: true,
    hint: "Glassbox has its own browser: run the app with mcp__glassbox__start_app, open any page with mcp__glassbox__browser_open and read or use it with browser_snapshot, browser_click and browser_type. For a tool's preview server, start it with its no-open flag (e.g. --no-open), then browser_open its URL. Show a rendered video or image with mcp__glassbox__open_file."
  },
  {
    id: 'other-browser-tools',
    label: 'Driving a browser outside Glassbox (Playwright, Puppeteer or Chrome connectors)',
    scope: 'mcp',
    pattern: '^mcp__(?!glassbox__).*(playwright|puppeteer|chrome|browser|browserbase|chromium)',
    action: 'block',
    builtin: true,
    hint: 'Use the Glassbox Browser instead, so the user sees it and their sign-ins are kept: mcp__glassbox__browser_open, then browser_snapshot, browser_click, browser_type, browser_eval and browser_screenshot.'
  },
  { id: ':protected-files', label: "Edits to files you marked don't touch", scope: 'edit', pattern: '', action: 'block', builtin: true },
  { id: ':ask-files', label: 'Edits to parts you asked to approve first', scope: 'edit', pattern: '', action: 'ask', builtin: true },
  {
    id: ':api-only',
    label: "Reaching into a module's internals (you allowed its public API only)",
    scope: 'edit',
    pattern: '',
    action: 'block',
    builtin: true,
    hint: "Import from that module's public entry point instead (its index file, __init__.py, a contracts folder, or the project itself). If what you need isn't exported there, export it from the entry point first and say so, or ask the user."
  },
  { id: ':outside-project', label: 'Writes outside the project folder', scope: 'edit', pattern: '', action: 'ask', builtin: true }
]
