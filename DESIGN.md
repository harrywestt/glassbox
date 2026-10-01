---
name: Glassbox
description: A control-room gallery for watching and steering Claude Code sessions live.
colors:
  dark-desk: "#16181b"
  dark-screen: "#1c1f24"
  dark-surface: "#22262c"
  dark-elevated: "#2b3037"
  dark-bezel: "#31363e"
  dark-fg: "#e6e8eb"
  dark-strong: "#ffffff"
  dark-muted: "#9aa1ab"
  dark-subtle: "#7c838d"
  dark-accent: "#6ea8fe"
  dark-accent-fg: "#0b1524"
  dark-selection: "#26395a"
  dark-user-bubble: "#282c33"
  dark-tally-live: "#ff4f3f"
  dark-warn: "#e5a53c"
  dark-ok: "#43b96f"
  dark-err: "#f0604f"
  dark-info: "#6aa6e8"
  dark-cat-1: "#3987e5"
  dark-cat-2: "#d95926"
  dark-cat-3: "#199e70"
  dark-cat-4: "#9085e9"
  dark-cat-5: "#d55181"
  dark-cat-6: "#c98500"
  dark-cat-7: "#008300"
  dark-cat-8: "#e66767"
  light-desk: "#e9ecef"
  light-screen: "#ffffff"
  light-surface: "#f5f6f8"
  light-elevated: "#e6e9ed"
  light-bezel: "#d7dbe0"
  light-fg: "#15181c"
  light-strong: "#05070a"
  light-muted: "#535b66"
  light-subtle: "#6c7480"
  light-accent: "#2563c9"
  light-accent-fg: "#ffffff"
  light-selection: "#d6e3f7"
  light-user-bubble: "#eef0f3"
  light-tally-live: "#e2301f"
  light-warn: "#a66a00"
  light-ok: "#1c8649"
  light-err: "#c8352b"
  light-info: "#2563c9"
  light-cat-1: "#2a78d6"
  light-cat-2: "#eb6834"
  light-cat-3: "#1baf7a"
  light-cat-4: "#4a3aa7"
  light-cat-5: "#e87ba4"
  light-cat-6: "#eda100"
  light-cat-7: "#008300"
  light-cat-8: "#e34948"
typography:
  display:
    fontFamily: "'Archivo Variable', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "'Archivo Variable', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
  title:
    fontFamily: "'Archivo Variable', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "'Archivo Variable', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  conversation:
    fontFamily: "'Archivo Variable', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: "'Archivo Variable', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1
    fontVariation: "'wdth' 88"
  meta:
    fontFamily: "'Archivo Variable', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.2
    fontFeature: "'tnum' 1"
  mono:
    fontFamily: "'IBM Plex Mono', 'Cascadia Code', Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  lamp: "50%"
spacing:
  s-1: "4px"
  s-2: "8px"
  s-3: "12px"
  s-4: "16px"
  s-5: "24px"
  s-6: "32px"
components:
  button:
    backgroundColor: "transparent"
    textColor: "{colors.dark-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "28px"
  button-hover:
    backgroundColor: "{colors.dark-elevated}"
  button-primary:
    backgroundColor: "{colors.dark-accent}"
    textColor: "{colors.dark-accent-fg}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "28px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.dark-muted}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "28px"
  button-dialog:
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "32px"
  send:
    backgroundColor: "{colors.dark-accent}"
    textColor: "{colors.dark-accent-fg}"
    rounded: "{rounded.md}"
    size: "32px"
  send-stop:
    backgroundColor: "{colors.dark-fg}"
    textColor: "{colors.dark-screen}"
    rounded: "{rounded.md}"
    size: "32px"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.dark-muted}"
    rounded: "{rounded.md}"
    size: "28px"
  input:
    backgroundColor: "{colors.dark-screen}"
    textColor: "{colors.dark-fg}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "28px"
  segmented:
    backgroundColor: "{colors.dark-desk}"
    textColor: "{colors.dark-muted}"
    rounded: "{rounded.md}"
    height: "24px"
  segmented-active:
    backgroundColor: "{colors.dark-screen}"
    textColor: "{colors.dark-fg}"
    rounded: "{rounded.sm}"
  switch:
    backgroundColor: "{colors.dark-elevated}"
    rounded: "8px"
    height: "16px"
    width: "28px"
  switch-on:
    backgroundColor: "{colors.dark-accent}"
    textColor: "{colors.dark-accent-fg}"
  monitor:
    backgroundColor: "{colors.dark-screen}"
    rounded: "{rounded.lg}"
  label-strip:
    textColor: "{colors.dark-muted}"
    typography: "{typography.label}"
    padding: "0 16px"
    height: "36px"
  label-strip-tab-active:
    textColor: "{colors.dark-fg}"
  session-monitor-tab:
    backgroundColor: "transparent"
    textColor: "{colors.dark-muted}"
    rounded: "{rounded.md}"
    padding: "0 4px 0 12px"
    height: "32px"
    width: "212px"
  session-monitor-tab-active:
    backgroundColor: "{colors.dark-screen}"
    textColor: "{colors.dark-fg}"
  tally-lamp:
    rounded: "{rounded.lamp}"
    size: "8px"
  tally-lamp-live:
    backgroundColor: "{colors.dark-tally-live}"
  tally-lamp-wait:
    backgroundColor: "{colors.dark-warn}"
  tally-lamp-ok:
    backgroundColor: "{colors.dark-ok}"
  list-row:
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "28px"
  list-row-selected:
    backgroundColor: "{colors.dark-selection}"
  popover:
    backgroundColor: "{colors.dark-elevated}"
    rounded: "{rounded.lg}"
    padding: "4px"
  dialog:
    backgroundColor: "{colors.dark-surface}"
    rounded: "{rounded.xl}"
    padding: "24px"
  tooltip:
    backgroundColor: "{colors.dark-fg}"
    textColor: "{colors.dark-screen}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
  user-message:
    backgroundColor: "{colors.dark-user-bubble}"
    textColor: "{colors.dark-fg}"
    rounded: "{rounded.xl}"
    padding: "8px 12px"
  claude-note:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-fg}"
    typography: "{typography.body}"
    padding: "0 8px 0 24px"
    height: "32px"
  map-module:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-fg}"
    rounded: "{rounded.md}"
    height: "124px"
  map-module-context:
    backgroundColor: "{colors.dark-screen}"
    textColor: "{colors.dark-muted}"
    rounded: "{rounded.md}"
    height: "64px"
  map-inspector:
    backgroundColor: "{colors.dark-elevated}"
    rounded: "{rounded.lg}"
    padding: "12px 16px 16px"
    width: "380px"
  map-replay-bar:
    backgroundColor: "{colors.dark-screen}"
    padding: "0 16px 0 12px"
    height: "40px"
  fleet-card:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-fg}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    height: "64px"
  dashboard-card:
    backgroundColor: "{colors.dark-screen}"
    rounded: "{rounded.lg}"
    padding: "16px"
---

# Design System: Glassbox

## Overview

**Creative North Star: "The Gallery"**

Glassbox is a broadcast control-room gallery. The window is a desk; the program and preview panes are monitors set on it, framed by a hairline bezel with the desk showing between them. Every session is a small monitor with a tally lamp, so one glance at the session strip or the fleet board shows which is on air, which needs you and which is done. The room is matte and quiet. Only the lamps are lit.

Density is editor density: VS Code's tabs across the top, a side monitor on the right, 28px controls, 12 to 13px UI type. Hierarchy comes from the frame (desk, monitor, label strip) and from weight, never from coloured chrome. The user's own accent marks where they are: selection, focus, the active tab's underline, the primary action. Tally colours say what a session is doing and nothing else.

The user has rejected anything that reads as generated: pills and badges, coloured left stripes, helper paragraphs, glows, and the grey editor clone with an icon rail. The interface shows rather than explains. An empty area says one plain line or hides.

**Key Characteristics:**
- A desk ground (`desk`) with framed monitors (`screen`) sitting on it, 8px apart.
- Tally lamps: red on air, amber needs you, green ready or done, hollow ring idle or stopped.
- One accent, chosen by the user, for selection and focus only.
- One UI face (Archivo, variable width) narrowed to 88% for label strips; IBM Plex Mono only for code and paths.
- Flat at rest; a shadow only on things that float above the desk.
- Motion reports state (a lamp breathing, the playhead moving, the fleet sliding), never decorates.

## Colors

Matte bezel neutrals in two themes, a user-chosen accent, a tally set reserved for state, and one categorical set for charts only. All colours are applied as CSS custom properties from the theme token map; `--strong` and the `--cat-*` series are set per theme in the stylesheet.

### Primary
- **Operator Accent** (dark `dark-accent`, light `light-accent`; default Blue): the user's colour. Selection outlines on map modules, the 2px underline under the active tab, focus rings (75% mix), primary buttons, Send and switches that are on, links, the text caret, the map replay playhead, heat and usage fills, chart bars. The user picks it from six presets, each tuned per theme: Teal, Blue, Violet, Green, Amber, Rose. `accent-soft` is derived at runtime as the accent mixed 16% (dark) or 12% (light) into transparent, used for armed or toggled-on controls.
- **Accent Ink** (`dark-accent-fg`, `light-accent-fg`): text on accent fills, and the knob of an on switch.

### Tally (state only)
- **On Air Red** (`dark-tally-live`, `light-tally-live`): Claude is working in this session. Lamps breathe; the map's module being edited is framed in it; the map footer lamp beside "Claude editing …" breathes in it.
- **Needs You Amber** (`dark-warn`, `light-warn`): Claude is waiting on you (a permission, a check-in, an open question), or an account needs signing in. Also the severity word for major findings.
- **Ready Green** (`dark-ok`, `light-ok`): ready or done. Also diff additions.
- **Stopped Red** (`dark-err`, `light-err`): stopped sessions (as a 2px hollow ring, not a fill), failures, blocker severity, diff deletions.
- **Idle**: no colour of its own; a 1.5px hollow ring in `subtle`.
- **Info Blue** (`dark-info`, `light-info`): minor severity and read markers.

### Categorical (charts only)
- **Series 1 to 8** (`dark-cat-1`..`dark-cat-8`, `light-cat-1`..`light-cat-8`): the Context breakdown's series, always in this fixed order: blue, orange, teal, violet, pink, amber, green, red. The red, amber and green hues come last so the first series never read as session state. Each theme's set was stepped for its own screen colour and checked with the dataviz validator (lightness, chroma, colour-vision deficiency, contrast). A chart that uses them always carries its legend table (swatch, name, value), so identity is never carried by colour alone.

### Neutral
- **Desk** (`dark-desk` graphite / `light-desk` pale grey): the window ground, title bar, session header, dashboard floor. The native title bar is set to it.
- **Screen** (`dark-screen` / `light-screen` white): the monitor face. Both monitors share it; inputs sit on it; the active session tab lights to it; Monaco code and diff views use it as their background.
- **Surface** (`dark-surface` / `light-surface`): raised areas inside a monitor: map modules, fleet cards, the composer box, the ask dock, Claude's reason note, side columns in Ripple and Flow, dialogs.
- **Elevated** (`dark-elevated` / `light-elevated`): popovers, menus, the map inspector, the off switch track, hover fills.
- **Bezel** (`dark-bezel` / `light-bezel`): every hairline: monitor frames, rules between sections, tab-strip underlines, column dividers, Monaco borders.
- **Foreground, Strong, Muted, Subtle**: text in four steps. Strong for markdown emphasis and table heads; muted for secondary text and inactive tabs; subtle for meta, placeholders and map path lines.
- **Selection** (`dark-selection` / `light-selection`): the selected row and text selection, in the UI and in Monaco.
- **Talkback Grey** (`dark-user-bubble` / `light-user-bubble`): the user's own messages.

### Named Rules
**The Tally Rule.** Red, amber and green mean working, needs you, and ready or done. They appear on lamps, on the map's lit module frame and footer lamp, on status and severity words, and on diff lines. They never tint a border, fill, tab, badge, count or banner. Where state needs emphasis without a lamp (the current plan step, an urgent count), it is carried by weight.

**The Operator Rule.** The accent marks where the user is (selection, focus, the current tab, the primary action) and never a session's state.

**The Matte Rule.** No glows, no gradients on chrome, no coloured shadows. The only gradient in chrome is the loading skeleton's sweep.

**The Categorical Rule.** The `cat` series live only inside charts, in their fixed order, with a legend table beside them. They never mark state, selection or chrome.

## Typography

**Display Font:** Archivo Variable, width axis (with Segoe UI Variable Text, Segoe UI, system-ui)
**Body Font:** Archivo Variable (same stack)
**Label/Mono Font:** IBM Plex Mono 400/500 (with Cascadia Code, Consolas), for code, paths, diffs and key caps only

**Character:** one grotesque doing every job, narrowed to 88% width (`font-stretch`) wherever a label has to fit a strip: session names, tab labels, fleet column heads, map band labels, ticket keys. The narrowing reads as broadcast labelling, not a second face.

### Hierarchy
- **Display** (600, 20px, 1.25, -0.01em): page and dialog-level titles only, such as Dashboard and the Stand-up title.
- **Headline** (600, 15px, 1.3): dialog titles, the open question's heading, the map inspector's module name, ticket and flow titles, markdown headings.
- **Title** (600, 13px): card and panel titles, pull request titles, map module and connection names (650 at 92% width in the SVG).
- **Body** (400, 13px, 1.5): UI text, rows, menus, inputs, setting labels, Claude's connection sentences in the inspector.
- **Conversation** (400, 15px, 1.7): Claude's replies and the user's messages. The user sets 13 to 18px; code inside scales to 88%.
- **Label** (500, 12px, 88% width): tabs, session monitor names, buttons, column heads.
- **Meta** (400 to 600, 11px, tabular figures): the live verb under a session name, decision kind and time, fleet card footers, band labels, map footer lines, Ripple labels.
- **Mono** (400, 12px, 1.55): code blocks, diffs, file paths in the map and inspector (11px inside map boxes), commit hashes and PR numbers.

### Named Rules
**The One Face Rule.** Archivo carries all UI text; mono is for code and paths, never for labels or numbers.

**The Tabular Rule.** Counts, costs, times, ticket keys and step numbers use tabular figures.

**The Plain Numbers Rule.** Dashboard figures are 13px/600 values in plain label-value rows, not hero tiles.

**The Legible Diagram Rule.** Diagram labels stay at 11px on screen at any drawn scale: Ripple divides its label size and halo by the scale it is drawn at, and the map lays out at a fixed type scale rather than shrinking.

## Layout

The window is a desk with a 40px title bar strip of session monitors, a 40px program label strip (repo, branch, ticket, state, access, share, usage), then two monitors side by side with 8px of desk around and between them. The gap between monitors is the resize handle; it shows a 2px accent line on hover. The program monitor is at least 480px wide.

A session opens on the Conversation tab. Conversation and Map are the fixed program tabs and cannot be closed. Ripple and Flow open on demand and then stay without a close control. File, diff, commit, app preview and media tabs open as closeable tabs after a 1px bezel divider. The side monitor holds Route, Decisions, Changes, Ticket, Git and More.

Spacing runs on one scale: 4, 8, 12, 16, 24, with 32 reserved. Control heights are 24 inside rows, 28 for controls and rows, 32 for Send, dialog actions, session monitor tabs, Claude's reason note and the Changes summary row. Label strips inside monitors are 36px; bars (title bar, program strip, preview bar, map replay bar) are 40px.

The program monitor holds one inset: tab labels, conversation, map and dock start on the same 24px line (16px for tab labels). The conversation and composer share a reading width the user sets (Full width, Wide 1200px, Narrow 860px).

The dashboard is a desk capped at 1680px with 24px padding. A header row carries the Display title with the account line beneath (email, organisation, plan as muted text), then Stand-up, Accounts, "Updated …" and refresh at the right. The fleet board spans the full width beneath it. Then a three-column grid (1.35fr, 1.2fr, min 300px 0.9fr) with 24px gaps: Plan usage, Tokens per day and Settings; GitHub and History; Today, Start a session (recent folders and open tabs), and Models this fortnight with busiest projects. Under 1500px it drops to two columns, with the third column spread across the width below them; under 1000px it drops to one.

Sections inside a monitor are divided by space and a hairline rule, never boxed.

## Elevation & Depth

Depth comes from the frame, not from shadows: desk below, monitor faces on top with a 1px bezel, surfaces a tone up inside them. Everything that sits on the desk is flat. Only layers that float above it cast a shadow.

### Shadow Vocabulary
- **Pop** (`box-shadow: 0 12px 32px rgba(0,0,0,.28), 0 2px 6px rgba(0,0,0,.12)`): popovers, menus, dropdowns, the Accounts popover, the map inspector, tooltips, chart tips, suggestion lists, pan-zoom controls, the app preview's load-failure notice.
- **Dialog** (`box-shadow: 0 24px 64px rgba(0,0,0,.35)`): modal dialogs (New session, Stand-up, permissions) over a 55% scrim.

### Named Rules
**The Flat Desk Rule.** Monitors, cards, rows and buttons have no shadow. A shadow means the layer floats and will go away.

## Shapes

Four corners, each with one job: 4px for key caps, code, images and small inner buttons; 6px for controls, rows, session monitor tabs, map modules and fleet cards; 8px for monitors, dashboard cards, popovers, task cards and the composer box; 12px for dialogs and the user's message (whose sending corner drops to 4px). Lamps, switch knobs and accent swatches are circles; the switch track is a full capsule. Borders are 1px hairlines in the bezel colour; a selected map module takes a 2px accent stroke. External modules use dashed strokes; layer bands use a 2/4 dotted outline.

Allowed exceptions, not drift: micro marks take 1 to 2px radii (tab and splitter underlines, the text caret, replay ticks and playhead, test-trend bars, legend swatches, the Stop square), and 4px meters and bars take 2px capsule ends. Codicon glyphs sit at 14px in tabs, notes and chevrons (12 to 13px inside dense meta, 18px on task cards).

## Components

### Buttons
Keys on a desk: flat, hairline-framed, lit by fill.
- **Shape:** gently rounded (6px), 28px high, 12px side padding, 12px/500 label.
- **Default:** a hairline bezel border and no fill. Hover fills with elevated; press mixes 8% foreground into it.
- **Primary:** fills with the accent, accent ink text, no border; hover mixes the accent 86% with foreground. Disabled primary falls back to an outlined key.
- **Quiet:** no border, muted text, fills on hover. Icon buttons are 28px quiet squares; toggled on, they take the accent at `accent-soft`.
- **Send / Stop:** a 32px square in Send's place. While Claude works it becomes Stop: a foreground-filled key with a 10px screen-coloured square.
- **Focus:** a 2px ring of the accent at 75%, offset 1px, on every focusable element.

### Segmented controls, chips and switches
A desk-coloured track with a 1px bezel and 1px inset; 24px segments; the active one lights to the screen colour. Filter and folder chips are 24px quiet keys whose on state is `accent-soft` with accent text: a toggle, not a badge. The toggle switch is a 28 by 16px capsule: elevated track with a muted 12px knob when off, accent track with an accent-ink knob when on, the knob sliding over 150ms.

### Inputs / Fields
- **Style:** screen fill, 1px bezel, 6px corners, 28px high, 13px text, subtle placeholder, accent caret.
- **Focus:** the border turns accent; no ring or glow. The composer box is a surface panel at 8px whose border mixes 65% accent on focus.
- **Dropdowns:** themed select buttons open an elevated popover (4px padding, 8px corners, pop shadow) with 28px options, a selection fill for the active option and an accent check for the chosen one.

### Monitors
The two panes are monitors: screen fill, 1px bezel, 8px corners, clipped content. Each opens with a label strip: a 36px row of plain text tabs (12px/500, 88% width, muted, with a 14px subtle glyph) over a bezel hairline. The current tab turns foreground with a 2px accent underline inset 8px from its edges. A newly opened, unseen tab is marked by bold weight (700), not a dot. Side-tab counts are plain numbers after the label; an urgent count turns bold foreground, not amber.

### Claude's reason note
When Claude opens something for you (a file, a map module, a tab), a 32px surface bar sits above it with a hairline beneath: "Claude" at 650 and its one-line reason in body text. It carries no colour and goes when you move on.

### Session monitor tabs (title bar strip)
A small monitor per session: 32px high, 212px wide (shrinking to 112px), 6px corners, with a lamp, the session name (12px/500, 88% width) and its live verb beneath (11px, muted). Inactive tabs are transparent on the desk; hover half-lights them; the active one lights to the screen colour with a bezel border. The close button appears on hover or when active.

### Tally lamps
An 8px circle, the one place session state colour lives. Live: a solid red fill that breathes (opacity to .55 over 2.4s). Wait: solid amber. Ok: solid green. Idle: a 1.5px hollow ring in subtle. Stopped: a 2px hollow ring in the error red. Every lamp in the app (title bar, program strip, fleet board, map footer, question box, the dashboard's open tabs) is derived from the same tally function.

Beside a lamp in the title-bar tabs, the program strip and fleet cards, the words are the live verb: what the session is doing now ("Writing handler.js", "Editing Checkout.js", "Asked you a question", "Needs your approval", "Done", "Stopped"). Where a single state word is needed (a lamp's tooltip, a label), it comes from the five-word vocabulary: Working, Needs you, Done, Ready, Stopped.

### Question box and message box
Docked under every program tab. On any tab other than Conversation, an open question starts as a one-row collapsed dock: a lamp, "A question is waiting: …" and a quiet Answer key; Answer opens it in place. Open, the question box is a surface panel with a bezel border, 8px corners: a lamp, the question as a 15px/600 heading, one muted detail block, and answer options as outlined keys whose border turns accent on hover. Later collapses it again and lets you send a normal message; the question stays open. Inside the conversation, an unanswered question is one quiet line ("Asked you: … Answer it below") until answered, when it becomes a normal decision card. While a question is open the message box shrinks to one line.

### Conversation
The user's messages sit right-aligned in a talkback-grey bubble (max 78% width). Claude's replies are unboxed markdown at the conversation size. Tool steps are quiet 28px rows that fill with surface on hover and open into a surface body. Inline edits are bezel-framed cards with a surface head row and a mono diff whose added and deleted lines are tinted 12% green and red. Media the steps touched appear inline as a strip of thumbnails: 6px bezel-framed surface tiles (images up to 280px high, video with controls, audio as a player) with the mono file name beneath; clicking one opens it in a media tab.

### Code, diff and media tabs
Code and diff views use a Monaco theme built from the tokens: the screen colour behind code and gutter, subtle line numbers, the accent caret, the selection colour, elevated widgets with bezel borders, and diff lines tinted 12% ok and err (22% for changed text), with unchanged regions on surface. The media viewer shows a file as itself: images fitted to the tab on a quiet 16px surface checkerboard so transparency reads, click for actual size and click again to fit; SVGs add a Source toggle to read them as code; video and audio play with native controls. A meta row beneath gives the size in tabular figures.

### App preview
An Electron webview in a tab under a 40px preview bar whose address field fills the spare width. If the page fails to load, a floating elevated notice (bezel, 6px corners, pop shadow) says why beside an amber glyph, with Try again.

### Map
The architect map is an SVG laid out at the width it has and a fixed type scale: it never scrolls sideways, only down. It opens scoped to this conversation: the modules Claude read, edited or planned, plus up to 8 of their most-connected neighbours drawn as compact 64px context boxes (screen fill, muted name) so the modules Claude works in lead. A "This conversation / Whole project" segmented control sits above it beside a one-line muted summary ("4 modules Claude has worked in, and 5 connected to them").

Categories come from the code's folder structure; Claude only renames them. They are dotted bands with 11px/600 subtle labels. Module boxes are 124px surface boxes with a bezel stroke: name, mono path, touched files (a `~` prefix, new files in foreground), an edit count, and a footer strip under a hairline showing who is there (a lamp and "Claude editing Checkout.js"; subagents muted; other sessions in the same project as a hollow ring) and which plan steps land there (the current one bold foreground, done ones struck through). Hover darkens the stroke to muted; selection draws a 2px accent stroke; a module Claude pointed at takes a 1.5px accent stroke; the module being edited is framed in on-air red, the one waiting on you in amber. Heat is a foreground-tinted overlay by opacity. Fenced modules are hatched.

Connections are 16% foreground lines: imports solid, HTTP calls (a frontend calling a backend's routes) dashed 5/4; a hot edge is a 1.8px accent line. Selecting a module brings its lines up to 55% foreground and dims the rest to 35%, and opens an elevated 380px inspector with the pop shadow; the map re-flows left of it so nothing hides underneath. The inspector gives the module name and path, one line of what Claude did there, then Uses and Used by: each connection's name, a sentence Claude wrote about why they are connected, and the file-level imports behind it in mono.

A 40px replay bar at the bottom scrubs the session's key moments on a hairline track: your messages as tall 16px ticks, edits as 9px ticks, Claude's decisions as 5px dots; seen moments turn foreground, the hovered one and the playhead take the accent, and the status text says what happened then.

### Ripple
Rings of dependents around a changed module, with a 272px aside of counts. Encoding is by fill, not colour: changed is a solid foreground node, covered by tests is muted, untested is a dashed hollow ring. Labels stay 11px on screen at any drawn scale, haloed in the screen colour. Edges are accent lines that fade in; one accent wave expands once each time the tab opens.

### Flow
A sequence diagram of how a request moves: dashed bezel lifelines under desk-filled lane boxes. Hops are encoded by line, not colour: plain (subtle, 1.5px), new (foreground, 2.5px, bold label), changed (foreground, 6/3 dash), removed (subtle, dotted, struck-through label). A 272px surface side column holds the title and counts, each with its line sample.

### Changes panel
Opens on a 32px summary row: the file and line counts, one select for the comparison ("vs main, since branching" or "vs main, direct") and a refresh icon button. A filter field appears only when more than 10 files changed. Files are 28px rows beneath.

### Git panel
A pull request card leads the tab: the PR title at 13px/600 with its mono number, then plain facts in muted 12px (state in bold foreground, merged in accent, failed checks in the error colour as a status word). With no PR it offers to open one. Commit rows carry their meta as plain text: "abc1234, 5m ago, by Glassbox, not pushed".

### Fleet board
The dashboard's first card: five columns (Plan, Build, Test, Review, Ready) divided by bezel hairlines under 28px 12px/600 heads at 88% width. Each session is a 64px surface card with a lamp, the title, the live verb and a meta footer (steps, ticket, cost in GBP), sliding between columns as it progresses. Sessions touching the same area are joined by a dashed muted connector with an 11px label.

### Dashboard cards
Monitors on the desk: screen fill, bezel border, 8px corners, 16px padding, a 13px/600 title. Figures are label-value rows divided by hairlines. Open tabs in Start a session are list rows led by the shared tally lamp.

### Settings card
A dashboard card of 13px setting labels on the left and controls on the right, divided by hairlines, with a Reset to defaults link in the title row: Desktop notifications (a switch, off by default), Theme (Match Windows, Dark, Light), Accent colour (six 22px swatches; the chosen one ringed in its own colour), Conversation text (13 to 18px), Interface size (90 to 125%), Conversation width (Full width, Wide, Narrow) and Tables (Striped, Grid, Minimal), all as segmented controls, followed by a live sample of a reply.

### New session dialog
Task cards in an auto-fill grid (min 150px): 8px screen-filled keys with an 18px muted glyph, a 13px/600 title and a one-line muted blurb (clamped at two lines); the chosen one takes an accent border on `accent-soft`. Recent projects appear as a row of folder chips. When something is missing, a muted one-line hint sits beside the disabled Start button rather than a paragraph above it.

### Stand-up dialog
A 680px dialog with a 20px/650 title, groups under 15px/650 heads, plain bulleted lines with subtle markers, and ticket keys as mono subtle links that underline on hover. A hairline-topped footer holds its actions.

### Accounts popover
Opened from the Accounts key in the dashboard header: a 340px popover of 44px rows, each with a status mark, the account name and a muted detail line. A connected account shows a muted check; only an account that needs signing in shows an amber lamp, and the Accounts key carries that lamp when any does.

### Popovers, menus, tooltips
Elevated fill, bezel border, 8px corners, the pop shadow, a 120ms pop-in. Menu items are 28px rows that fill with selection on hover; the current item is accent text. Tooltips invert: foreground fill, screen text, 6px corners.

### Charts
Bars and usage fills take the accent. The Context breakdown uses the categorical series in fixed order with its legend table (8px swatch, name, right-aligned tabular value) always present.

### Motion
One easing, `cubic-bezier(.2, .7, .2, 1)`. State changes (hover, border, colour) take 120ms; popovers pop in over 120ms from 2px above. Motion carries state: the on-air lamp breathes over 2.4s; the map footer fades in over 300ms; the replay playhead moves over 250ms; a read flashes a module outline once over 1.6s; fleet cards slide over 500ms ease-out; Ripple's wave plays once over 2.6s. Nothing animates per frame. Under reduced motion every animation and transition stops.

## Do's and Don'ts

### Do:
- **Do** put session state on a tally lamp with the live verb beside it ("Writing handler.js", "Asked you a question", "Done", "Stopped"); use the five state words (Working, Needs you, Done, Ready, Stopped) where a single word is needed, such as a lamp's tooltip.
- **Do** use the user's accent for selection, focus, the current tab's underline and the primary action, and for nothing else.
- **Do** frame panes as monitors (screen fill, 1px bezel, 8px corners) on the desk, with a label strip of plain text tabs.
- **Do** keep to the scales: spacing 4/8/12/16/24, heights 24/28/32, corners 4/6/8/12 (with 1 to 2px only on micro marks and capsule ends).
- **Do** narrow labels with the 88% width axis instead of shrinking them below 11px, and keep diagram labels at 11px on screen at any scale.
- **Do** encode diagram meaning by fill, stroke weight and dash (Ripple, Flow, map) so it reads without colour.
- **Do** mark new, unseen, current or urgent things by weight, not a dot or a tally colour.
- **Do** divide sections by space and a hairline rule.
- **Do** give every categorical chart its legend table and keep the series in their fixed order.

### Don't:
- **Don't** use pills or badges: counts are plain numbers after the label; tags and meta are plain text, not filled lozenges.
- **Don't** use coloured left stripes or coloured borders to signal state; neutral hairline dividers are fine.
- **Don't** write helper paragraphs; an empty area says one plain line or hides.
- **Don't** add glows, coloured shadows or gradients to chrome.
- **Don't** put tally colours on tabs, frames, fills, counts, banners or buttons; status colour lives only on lamps, the map's lit module frame and footer lamp, status and severity words, and diff lines.
- **Don't** use the accent to mean a session is working; working is on-air red.
- **Don't** use the categorical series outside charts.
- **Don't** use mono for labels, numbers or UI text.
- **Don't** show dashboard figures as hero tiles.
- **Don't** add an icon rail or other unfamiliar navigation; tabs across the top and a side monitor are the navigation.
