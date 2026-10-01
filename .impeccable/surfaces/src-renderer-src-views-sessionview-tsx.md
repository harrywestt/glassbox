---
version: 1
slug: "src-renderer-src-views-sessionview-tsx"
primary_target: "src/renderer/src/views/SessionView.tsx"
related_targets: ["src/renderer/src/styles.css","src/renderer/src/App.tsx","src/renderer/src/work/MapTab.tsx"]
---

# Session window

Scope: the whole app shell and session window (titlebar session strip, session header, conversation, composer, side panel), plus the dashboard and dialogs inheriting the same world. Visitor mode: Operate.

Audience and job: developers running one or more Claude Code sessions for hours. In priority order: watch and steer live, juggle several sessions, review the changes. The ticket (Jira via Claude's Atlassian connector) is secondary.

Constraints: keep VS Code familiarity (tabs across the top, a side panel, editor density); keep light/dark themes, the accent picker and text-size settings; keep hold-Space voice, Tab-to-send prediction and Esc-to-stop. Anti-goals: unfamiliar or clever navigation; anything that reads as generated (pills, badges, stripes, helper paragraphs, glows).

Unresolved: Jira tab content depends on what the connector returns; ticket targeting defaults to the branch key.

## Direction contract

THESIS: Glassbox is a control-room gallery. Each session is a live monitor with a tally lamp, so you can tell at a glance which is on air, which needs you and which is done. It refuses the grey editor clone with icon rails, badge pills and helper text.

OWN-WORLD: matte bezel neutrals (dark: graphite ground, charcoal monitors, hairline bezels; light: pale grey desk, white monitors, grey bezels). Tally colours are reserved for state and never used as decoration: red means on air (working), amber means needs you, green means ready or done. The user's accent marks selection and focus. Monitors are framed panels with a label strip; keys are flat 6px buttons that light by fill. One UI face with tabular figures; mono for code only; no glow.

STORY: glance at the session strip or the fleet board to see which session needs you; watch Claude's crew move across the map of your system; answer or stop from the message box docked under every tab; open Ripple to see what an edit reaches and Flow to see how a request changed.

FIRST VIEWPORT: a titlebar strip of session monitors (tally lamp, name, live verb); a program label strip (repo, branch, ticket, state, access, share, usage); the program monitor on the left opening on the Map tab (layers as bands, modules as boxes, the crew on the module it's touching, the route as numbered steps), with Conversation one tab away and Ripple and Flow appearing as tabs when relevant; the question box and message box docked under all of them with Stop in Send's place; the preview monitor on the right with one row of named tabs: Route, Decisions, Changes, Ticket, Git, More. The dashboard's first card is a fleet board (Plan, Build, Test, Review, Ready).

FORM: Gallery, ranked first of seven grounded candidates; seed key de274518.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
