import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DiffFile, PrOverview } from '../../../shared/events'
import { useSession } from '../views/SessionView'
import { absPath, mediaKind, mediaUrl, renderMarkdown, timeOfDay } from '../lib'
import { Empty, Icon, IconButton } from '../components/ui'
import { useThemeTokens } from '../App'
import { useAppearance } from '../appearance'
import { enhance } from '../markdownDoc'
import { DiffBlock, SketchBlock, SketchFrame } from './planBlocks'
import { runSummary, testRuns } from '../tests'
import { toolSummary } from '../session'
import { WorkingMark } from '../session-ui/WorkingMark'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { tr } from '../../../shared/i18n'

/** What Glassbox sends Claude for an overview (from the button here, the PR card, or the opt-in setting). */
export const OVERVIEW_ASK =
  "Write the PR overview for this branch's pull request with the pr_overview tool, based on its diff against the base branch and what you know from this session. Size it to the change. If it changes anything people see, sketch those screens in screens."

type Area = NonNullable<PrOverview['areas']>[number]
type Link = NonNullable<PrOverview['links']>[number]

/** Columns of the change map, left to right: what people see, then what serves it, then what it rests on. */
const LAYERS: Area['kind'][] = ['ui', 'ai', 'api', 'logic', 'data', 'infra', 'config', 'tests', 'docs']
const KIND_ICON: Record<Area['kind'], string> = { ui: 'browser', ai: 'sparkle', api: 'plug', logic: 'symbol-method', data: 'database', infra: 'cloud', config: 'settings-gear', tests: 'beaker', docs: 'book' }
const LEVEL = { high: 0, medium: 1, low: 2 } as const

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
const firstSentence = (text: string) => text.match(/^.*?[.!?](\s|$)/)?.[0].trim() ?? text

/** Folder names that say where code lives rather than what it is; a change is grouped under the first name that isn't one. */
const GENERIC = new Set(['api', 'ui', 'src', 'app', 'apps', 'lib', 'libs', 'modules', 'services', 'packages', 'features', 'components', 'pages', 'tests', 'test', 'web', 'server', 'client'])
function groupOf(path: string): string {
  const dirs = path.split('/').slice(0, -1)
  const name = dirs.find((d) => !GENERIC.has(d.toLowerCase()) && !/-(ui|app|api)$/i.test(d)) ?? dirs.at(-1) ?? ''
  const base = name.split('.')[0]
  return base.charAt(0).toUpperCase() + base.slice(1)
}
/** Text with its code names (file.ts, Name.Method(), camelCase, `quoted`) shown as code. */
function withCode(text: string): ReactNode {
  const parts = text.split(/(`[^`]+`|\b[\w./-]+\.(?:cs|tsx?|jsx?|json|tf|md|sql|py|css)\b|\b[\w.]+\(\)|\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b)/)
  return parts.map((part, i) => (i % 2 ? <code key={i}>{part.replace(/^`|`$/g, '')}</code> : part))
}

type Change = NonNullable<PrOverview['changes']>[number]
/** Changes grouped by the module they're in, the biggest group first. */
function groupChanges(changes: Change[]): [string, Change[]][] {
  const groups = new Map<string, Change[]>()
  for (const c of changes) groups.set(groupOf(c.path), [...(groups.get(groupOf(c.path)) ?? []), c])
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
}

/** The overview as Markdown, for the pull request's description or anywhere else. */
function asMarkdown(o: PrOverview): string {
  const out: string[] = [o.headline ? `**${o.headline}**\n\n${o.summary}` : o.summary, '']
  if (o.areas?.length) out.push('### How it works', ...o.areas.map((a) => `- **${a.title}** (${a.change})${a.note ? `: ${a.note}` : ''}`), '')
  else if (o.changes?.length) out.push('### What changed', ...o.changes.map((c) => `- \`${c.path}\`: ${c.what}`), '')
  if (o.risks?.length) out.push('### Risks', ...o.risks.map((r) => `- **${r.level}**: ${r.title}${r.detail ? `. ${r.detail}` : ''}${r.mitigation ? ` Limited by: ${r.mitigation}` : ''}`), '')
  if (o.notes?.length) out.push('### Things to know', ...o.notes.map((n) => `- **${n.title}**${n.detail ? `: ${n.detail}` : ''}`), '')
  if (o.deviations?.length) out.push('### Different from the rest of the codebase', ...o.deviations.map((d) => `- **${d.title}**: usually ${d.usual}; here ${d.here}. ${d.why}`), '')
  if (o.testing?.done?.length || o.testing?.howTo?.length) out.push('### Testing', ...(o.testing.done ?? []).map((t) => `- [x] ${t}`), ...(o.testing.howTo ?? []).map((t) => `- [ ] ${t}`), '')
  if (o.reviewFocus?.length) out.push('### Where to look', ...o.reviewFocus.map((f) => `- ${f}`), '')
  return out.join('\n').trim() + '\n'
}

/** One block: its title, an icon and tint, a count beside the title, its face, and what it shows blown up. */
type Card = { id: string; title: string; icon: string; tint: string; grow: number; count?: number; /** Its face always fits, so it isn't faded at the bottom. */ whole?: boolean; face: ReactNode; full?: ReactNode }

/** One thing to check before merging, from the risks, the things to know and where the code departs from the codebase. */
type Check = { level: 'high' | 'medium' | 'low' | 'info'; kind: string; title: string; text?: string; limit?: string; detail?: ReactNode }

/**
 * The pull request on one screen, in the order you'd want to learn it: what it does (in plain words)
 * and its numbers; then the screens it changes and how it works (the parts it touches, with arrows);
 * then what to check before merging, how it was tested and where to look. Written by Claude
 * (pr_overview), sized to the change; a block shows only when there's something in it, and blows up
 * when clicked.
 */
export function OverviewTab() {
  const { tab, s, send, openDiff } = useSession()
  const o = s.overview
  const theme = useThemeTokens()
  const spinner = useAppearance().spinner
  const zoomRef = useRef<HTMLElement>(null)
  const [diff, setDiff] = useState<{ base: string; files: DiffFile[] } | null>(null)
  const [zoom, setZoom] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [pressedAt, setPressedAt] = useState(0)
  const [now, setNow] = useState(Date.now())

  // What the pull request holds: the branch's commits against its base, not whatever else is in the folder.
  useEffect(() => {
    if (!o) return
    let live = true
    void window.glassbox.git
      .branches(tab.cwd)
      .then(({ branches, defaultBase }) => {
        const base = defaultBase ?? branches[0]
        return base ? window.glassbox.git.diff(tab.cwd, base, 'merge-base', true) : null
      })
      .then((d) => live && d && setDiff(d))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [o?.at, tab.cwd, s.git?.head])

  // Writing one: from the last time it was asked for (here, the PR card or the setting) until it arrives or the turn ends.
  const asked = Math.max(pressedAt, ...s.timeline.filter((t) => t.kind === 'user' && t.text.includes('pr_overview')).map((t) => t.at))
  const working = s.status === 'running' || s.status === 'starting'
  const writing = asked > (o?.at ?? 0) && (working || Date.now() - pressedAt < 8000)
  useEffect(() => {
    if (!writing) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [writing])
  const doing = writing ? Object.values(s.toolCalls).filter((c) => c.status === 'running' && c.at >= asked).sort((a, b) => b.at - a.at)[0] : undefined

  // Diagrams and code inside a blown-up block are drawn and coloured as in the Markdown viewer.
  useLayoutEffect(() => {
    if (zoomRef.current) enhance(zoomRef.current, theme, { copy: tr('markdownView.copyCode'), copied: tr('markdownView.copied'), alert: (k: string) => tr(`markdownView.alert.${k}`) })
  }, [o, theme, zoom])

  // Escape closes the sheet; the arrow keys step to the block before or after.
  const stepRef = useRef<(d: number) => void>(() => {})
  useEffect(() => {
    if (!zoom) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoom(null)
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') stepRef.current(e.key === 'ArrowRight' ? 1 : -1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoom])

  const files = diff?.files ?? []
  // Only Claude's own named parts: folders on their own told you nothing about how the change works.
  const areas = o?.areas ?? []
  const assets = useMemo(() => {
    if (!o) return []
    const list = new Map((o.assets ?? []).map((a) => [norm(a.path), a]))
    for (const f of files) if (f.status !== 'D' && mediaKind(f.path) && !list.has(norm(f.path))) list.set(norm(f.path), { path: f.path })
    return [...list.values()]
  }, [o, files])

  const canSend = s.status === 'ready' || s.status === 'running'
  const write = () => (setPressedAt(Date.now()), void send(OVERVIEW_ASK, tr('overviewTab.writeDisplay')))
  const progress = (big?: boolean) => (
    <div className={big ? 'ovd-writing big' : 'ovd-writing'} role="status">
      <WorkingMark kind={spinner} />
      <span className="ovd-writing-title">{tr('overviewTab.writing')}</span>
      <span className="ovd-writing-step ellipsis">{doing ? toolSummary(doing) : tr('overviewTab.reading')}</span>
      <span className="ovd-writing-time">{tr('overviewTab.elapsed', { s: Math.max(0, Math.round((now - asked) / 1000)) })}</span>
    </div>
  )

  if (!o)
    return (
      <div className="panel overview-empty">
        {writing ? (
          progress(true)
        ) : (
          <Empty title={tr('overviewTab.emptyTitle')} center>
            <p>{tr('overviewTab.emptyBody')}</p>
            <button className="btn primary" disabled={!canSend} onClick={write}>
              <Icon name="git-pull-request" /> {tr('overviewTab.write')}
            </button>
            <span className="set-tokens">{tr('settings.usesTokens')}</span>
          </Empty>
        )}
      </div>
    )

  const flash = (what: string) => (setDone(what), setTimeout(() => setDone(null), 1600))
  const copy = () => void navigator.clipboard.writeText(asMarkdown(o)).then(() => flash('copied'))
  const toPr = async () => flash((await window.glassbox.plan.toPr(tab.cwd, asMarkdown(o))).error ? 'failed' : 'added')
  const total = files.reduce((n, f) => ({ add: n.add + (f.additions ?? 0), del: n.del + (f.deletions ?? 0) }), { add: 0, del: 0 })
  const fileCount = files.length || o.changes?.length || 0
  const lastRun = testRuns(s).at(-1)
  const decisions = s.decisions.filter((d) => d.kind === 'decision' && !d.dismissed)
  const tiny = o.size === 'tiny'
  const openPath = (p: string) => openDiff({ path: absPath(tab.cwd, p), base: diff?.base ?? null, diffMode: 'merge-base', source: 'branch' })
  const links = o.areas?.length ? (o.links ?? []) : []
  const screens = (o.screens ?? []).filter((sc) => sc.sketch && s.sketches?.[sc.sketch]?.versions.length)
  const headline = o.headline ?? firstSentence(o.summary)
  const rest = o.headline ? o.summary : o.summary.slice(headline.length).trim()

  // Everything to check before merging, the most serious first.
  const checks: Check[] = [
    ...(o.risks ?? []).map((r) => ({ level: r.level, kind: tr('overviewTab.riskKind'), title: r.title, text: r.detail, limit: r.mitigation })),
    ...(o.notes ?? []).map((n) => ({ level: n.kind === 'breaking' || n.kind === 'security' ? ('high' as const) : n.kind === 'migration' || n.kind === 'config' ? ('medium' as const) : ('info' as const), kind: tr(`overviewTab.noteKind.${n.kind}`), title: n.title, text: n.detail })),
    ...(o.deviations ?? []).map((d) => ({
      level: 'info' as const,
      kind: tr('overviewTab.deviation'),
      title: d.title,
      detail: (
        <div className="ovd-dev-compare">
          <div><span className="ovd-sub">{tr('overviewTab.usually')}</span><p>{d.usual}</p></div>
          <Icon name="arrow-right" />
          <div><span className="ovd-sub">{tr('overviewTab.here')}</span><p>{d.here}</p></div>
          <p className="muted ovd-dev-why">{d.why}</p>
        </div>
      )
    }))
  ].sort((a, b) => (a.level === 'info' ? 3 : LEVEL[a.level]) - (b.level === 'info' ? 3 : LEVEL[b.level]))
  const worst = checks.find((c) => c.level !== 'info')?.level

  const code = (o.code ?? []).map((c, i) => (
    <div key={i} className="ovd-code-full">
      <div className="ovd-sub">{c.title ?? c.note ?? c.path}</div>
      {c.note && c.title && <p className="muted">{c.note}</p>}
      <DiffBlock file={c.path} body={c.diff} />
    </div>
  ))
  const diagrams = (o.diagrams ?? []).map((d, i) => <div key={i} className="ovd-diagram" dangerouslySetInnerHTML={{ __html: renderMarkdown(`**${d.title}**\n\n\`\`\`mermaid\n${d.mermaid}\n\`\`\``, tab.cwd) }} />)

  // Top row: what it does, and its numbers.
  const top: Card[] = [
    {
      id: 'what',
      title: tr('overviewTab.whatItDoes'),
      icon: 'lightbulb',
      tint: 'accent',
      grow: 2,
      face: (
        <div className="ovd-what">
          <p className="ovd-headline">{headline}</p>
          {rest && <p className="ovd-detail-text">{rest}</p>}
        </div>
      ),
      full: (
        <>
          <div className="ovs-facts">
            {o.pr?.number != null && <span>#{o.pr.number}</span>}
            <span>{tr(`overviewTab.size.${o.size}`)}</span>
            {!!fileCount && <span>{tr('overviewTab.filesCount', { count: fileCount })}</span>}
            {(total.add > 0 || total.del > 0) && <span><span className="ok">+{total.add}</span> <span className="err">−{total.del}</span></span>}
          </div>
          <p className="ovs-lead">{headline}</p>
          {rest && <p className="ovs-text">{withCode(rest)}</p>}
          {!!decisions.length && (
            <section className="ovs-section">
              <h4 className="ovs-label">{tr('overviewTab.decisions')}</h4>
              <ul className="ovs-ticks">
                {decisions.map((d) => (
                  <li key={d.id}><Icon name="check" />{d.title}</li>
                ))}
              </ul>
            </section>
          )}
        </>
      )
    },
    {
      id: 'glance',
      title: tr('overviewTab.numbers'),
      icon: 'pulse',
      tint: 'info',
      grow: 1,
      whole: true,
      face: (
        <div className="ovd-stats">
          <div className="ovd-stat">
            <span className="ovd-stat-value">{fileCount}</span>
            <span className="ovd-stat-label">{tr('overviewTab.filesChanged', { count: fileCount })}</span>
          </div>
          <div className="ovd-stat">
            <span className="ovd-stat-value"><span className="ok">+{total.add}</span> <span className="err">−{total.del}</span></span>
            <span className="ovd-stat-bar"><span className="add" style={{ flexGrow: total.add || 1 }} /><span className="del" style={{ flexGrow: total.del || (total.add ? 0 : 1) }} /></span>
            <span className="ovd-stat-label">{tr('overviewTab.linesChanged')}</span>
          </div>
          <div className={`ovd-stat${lastRun ? (lastRun.ok ? ' good' : ' bad') : ''}`}>
            <span className="ovd-stat-value"><Icon name={!lastRun ? 'circle-slash' : lastRun.ok ? 'pass-filled' : 'error'} /></span>
            <span className="ovd-stat-label">{!lastRun ? tr('overviewTab.noTestRun') : lastRun.ok ? tr('overviewTab.testsPassed') : tr('overviewTab.testsFailed')}</span>
          </div>
          <div className={`ovd-stat${worst ? ` level-${worst}` : ' good'}`}>
            <span className="ovd-stat-value">{worst ? tr(`overviewTab.risk.${worst}`) : tr('overviewTab.noRisk')}</span>
            <span className="ovd-stat-label">{tr('overviewTab.riskLevel')}</span>
          </div>
        </div>
      )
    }
  ]

  // Middle row: what people will see, and how it works.
  const middle: Card[] = []
  if (screens.length) {
    const v = s.sketches![screens[0].sketch!].versions.at(-1)!
    middle.push({
      id: 'screens',
      title: screens.length > 1 ? tr('overviewTab.screensCount', { count: screens.length }) : screens[0].title,
      icon: 'device-desktop',
      tint: 'accent',
      grow: areas.length ? 1.2 : 2,
      count: screens.length > 1 ? screens.length : undefined,
      face: (
        <div className="ovd-sketch-face">
          <SketchFrame version={v} />
        </div>
      ),
      full: screens.map((sc, i) => (
        <ErrorBoundary key={i} where="overview:sketch">
          <SketchBlock id={sc.sketch!} caption={sc.title} />
        </ErrorBoundary>
      ))
    })
  }
  if (areas.length) {
    middle.push({
      id: 'how',
      title: tr('overviewTab.howItWorks'),
      icon: 'type-hierarchy',
      tint: 'violet',
      grow: screens.length ? 1.6 : 2,
      count: areas.length,
      face: <ChangeMap areas={areas} links={links} />,
      full: (
        <>
          <ChangeMap areas={areas} links={links} full onFile={openPath} />
          {code}
          {diagrams}
        </>
      )
    })
  } else if (o.changes?.length || o.code?.length) {
    // A small change: the change itself, big.
    middle.push({
      id: 'change',
      title: tr('overviewTab.theChange'),
      icon: 'diff',
      tint: 'violet',
      grow: 2,
      count: o.changes?.length || undefined,
      face: (
        <div className="ovd-change">
          {(o.changes?.length ?? 0) > 3
            ? groupChanges(o.changes ?? []).slice(0, 5).map(([group, list]) => (
                <div key={group} className="ovd-module">
                  <span className="ovd-module-name">{group}</span>
                  <span className="ovd-module-count">{tr('overviewTab.changesCount', { count: list.length })}</span>
                  <span className="ovd-module-what">{list[0].what}</span>
                </div>
              ))
            : (o.changes ?? []).map((c) => (
                <div key={c.path} className="ovd-change-row">
                  <span className="ovd-change-what">{c.what}</span>
                  <span className="ovd-change-file" title={c.path}>{c.path.split('/').pop()}</span>
                </div>
              ))}
          {o.code?.[0] && (
            <pre className="ovd-code">
              {o.code[0].diff
                .split('\n')
                .filter((l) => !l.startsWith('@@'))
                .slice(0, 24)
                .map((l, i) => <div key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}>{l || ' '}</div>)}
            </pre>
          )}
        </div>
      ),
      full: (
        <>
          <div className="ovc-groups">
            {groupChanges(o.changes ?? []).map(([group, list]) => (
              <section key={group} className="ovc-group">
                <header className="ovc-group-head">
                  <span className="ovc-group-name">{group}</span>
                  <span className="ovd-count">{list.length}</span>
                </header>
                <ul className="ovc-rows">
                  {list.map((c) => (
                    <li key={c.path}>
                      <button className="ovc-row" onClick={() => openPath(c.path)} title={c.path}>
                        <span className="ovc-what">{c.what}</span>
                        <span className="ovc-file">{c.path.split('/').pop()}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          {code}
          {diagrams}
        </>
      )
    })
  }

  // Bottom row: what to check before merging, how it was tested, where to look.
  const bottom: Card[] = []
  if (checks.length)
    bottom.push({
      id: 'check',
      title: tr('overviewTab.checkBefore'),
      icon: 'shield',
      tint: worst === 'high' ? 'err' : worst === 'medium' ? 'warn' : 'ok',
      grow: 1.6,
      count: checks.length,
      face: (
        <ul className="ovd-checklist">
          {checks.slice(0, 3).map((c, i) => (
            <li key={i}>
              <span className={`ovd-dot level-${c.level}`} />
              <span className="ovd-check-title">{c.title}</span>
              <span className="ovd-check-kind">{c.kind}</span>
            </li>
          ))}
          {checks.length > 3 && <li className="ovd-more">{tr('overviewTab.andMore', { count: checks.length - 3 })}</li>}
        </ul>
      ),
      full: (
        <>
          {(['high', 'medium', 'rest'] as const).map((band) => {
            const list = checks.filter((c) => (band === 'rest' ? c.level === 'low' || c.level === 'info' : c.level === band))
            if (!list.length) return null
            return (
              <section key={band} className={`ovs-section band-${band}`}>
                <h4 className="ovs-label">{tr(`overviewTab.band.${band}`)}<span className="ovd-count">{list.length}</span></h4>
                <ul className="ovs-items">
                  {list.map((c, i) => (
                    <li key={i}>
                      <div className="ovs-item-head">
                        <span className={`ovd-dot level-${c.level}`} />
                        <strong>{c.title}</strong>
                        <span className="ovs-kind">{c.kind}</span>
                      </div>
                      {c.text && <p className="ovs-item-text">{withCode(c.text)}</p>}
                      {c.limit && <p className="ovs-item-limit"><span>{tr('overviewTab.limitedBy')}</span>{withCode(c.limit)}</p>}
                      {c.detail}
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </>
      )
    })
  const tests = [...(o.testing?.done ?? []).map((t) => ({ t, done: true })), ...(o.testing?.howTo ?? []).map((t) => ({ t, done: false }))]
  if (tests.length)
    bottom.push({
      id: 'testing',
      title: tr('overviewTab.testing'),
      icon: 'beaker',
      tint: 'ok',
      grow: 1,
      count: tests.length,
      face: (
        <ul className="ovd-tests">
          {tests.map((c, i) => (
            <li key={i} className={c.done ? 'done' : ''}>
              <Icon name={c.done ? 'pass-filled' : 'circle-large'} />
              <span>{c.t}</span>
            </li>
          ))}
        </ul>
      ),
      full: (
        <>
          {lastRun && (
            <div className={`ovs-run ${lastRun.ok ? 'ok' : 'err'}`}>
              <Icon name={lastRun.ok ? 'pass-filled' : 'error'} />
              <span>{lastRun.ok ? tr('overviewTab.testsPassed') : tr('overviewTab.testsFailed')}</span>
              <span className="ovs-run-meta">{runSummary(lastRun)}</span>
            </div>
          )}
          {!!o.testing?.done?.length && (
            <section className="ovs-section">
              <h4 className="ovs-label">{tr('overviewTab.alreadyTested')}<span className="ovd-count">{o.testing.done.length}</span></h4>
              <ul className="ovs-ticks done">
                {o.testing.done.map((t, i) => (
                  <li key={i}><Icon name="pass-filled" />{withCode(t)}</li>
                ))}
              </ul>
            </section>
          )}
          {!!o.testing?.howTo?.length && (
            <section className="ovs-section">
              <h4 className="ovs-label">{tr('overviewTab.checkYourself')}<span className="ovd-count">{o.testing.howTo.length}</span></h4>
              <ol className="ovs-steps">
                {o.testing.howTo.map((t, i) => (
                  <li key={i}><span className="ovs-box" />{withCode(t)}</li>
                ))}
              </ol>
            </section>
          )}
        </>
      )
    })
  if (o.reviewFocus?.length)
    bottom.push({
      id: 'focus',
      title: tr('overviewTab.focus'),
      icon: 'eye',
      tint: 'info',
      grow: 1,
      count: o.reviewFocus.length,
      face: <ol className="ovd-focus">{o.reviewFocus.map((f, i) => <li key={i}>{withCode(f)}</li>)}</ol>,
      full: <ol className="ovs-numbered">{o.reviewFocus.map((f, i) => <li key={i}><span className="ovs-n">{i + 1}</span><span>{withCode(f)}</span></li>)}</ol>
    })
  if (assets.length)
    bottom.push({
      id: 'assets',
      title: tr('overviewTab.assets'),
      icon: 'file-media',
      tint: 'accent',
      grow: 1,
      count: assets.length,
      face: <div className="ovd-thumbs">{assets.slice(0, 6).map((a) => (mediaKind(a.path) === 'image' ? <img key={a.path} src={mediaUrl(absPath(tab.cwd, a.path))} alt="" /> : <span key={a.path} className="ovd-thumb-icon"><Icon name="file-media" /></span>))}</div>,
      full: (
        <div className="ovd-assets">
          {assets.map((a) => (
            <figure key={a.path}>
              {mediaKind(a.path) === 'image' ? <img src={mediaUrl(absPath(tab.cwd, a.path))} alt="" /> : <span className="ovd-thumb-icon"><Icon name="file-media" /></span>}
              <figcaption><span className="mono small">{a.path}</span>{a.note && <span className="muted small">{a.note}</span>}</figcaption>
            </figure>
          ))}
        </div>
      )
    })

  const rows = [
    { cards: top, weight: tiny ? 1 : 1.05 },
    { cards: middle, weight: 2.3 },
    { cards: bottom.slice(0, 3), weight: 1.4 },
    { cards: bottom.slice(3), weight: 1.2 }
  ].filter((r) => r.cards.length)
  const zoomable = [...top, ...middle, ...bottom].filter((c) => c.full)
  const at = zoomable.findIndex((c) => c.id === zoom)
  const open = at >= 0 ? zoomable[at] : undefined
  const step = (d: number) => zoomable.length && setZoom(zoomable[(at + d + zoomable.length) % zoomable.length].id)
  stepRef.current = step

  return (
    <div className="ovd">
      <div className="plan-bar">
        <Icon name="git-pull-request" />
        <strong className="ellipsis">{o.pr?.title ?? tr('overviewTab.title')}</strong>
        {o.pr?.number != null && (
          <button className="link small" onClick={() => o.pr?.url && void window.glassbox.openExternal(o.pr.url)} disabled={!o.pr.url}>
            #{o.pr.number}
          </button>
        )}
        <span className={`ovd-size size-${o.size}`}>{tr(`overviewTab.size.${o.size}`)}</span>
        <span className="muted small">{timeOfDay(o.at)}</span>
        <span className="spacer" />
        {done && <span className="muted small">{tr(`overviewTab.done.${done}`)}</span>}
        <IconButton icon="copy" title={tr('overviewTab.copy')} onClick={copy} />
        <IconButton icon="git-pull-request-go-to-changes" title={tr('overviewTab.toPr')} onClick={() => void toPr()} />
        <IconButton icon="refresh" title={tr('overviewTab.again')} disabled={!canSend || writing} onClick={write} />
      </div>
      {writing && progress()}
      <div className={writing ? 'ovd-grid stale' : 'ovd-grid'}>
        {rows.map((row, r) => (
          <div key={r} className={r === 0 ? 'ovd-row top' : 'ovd-row'} style={{ flexGrow: row.weight }}>
            {row.cards.map((c) => (
              <section
                key={c.id}
                className={`ovd-card tint-${c.tint}${c.full ? ' zoomable' : ''}`}
                style={{ flexGrow: c.grow }}
                onClick={() => c.full && setZoom(c.id)}
                role={c.full ? 'button' : undefined}
                tabIndex={c.full ? 0 : undefined}
                onKeyDown={(e) => c.full && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setZoom(c.id))}
              >
                <header className="ovd-card-head">
                  <Icon name={c.icon} />
                  <span className="ovd-card-title ellipsis">{c.title}</span>
                  {c.count != null && <span className="ovd-count">{c.count}</span>}
                  {c.full && <Icon name="screen-full" className="ovd-expand" />}
                </header>
                <div className={c.whole ? 'ovd-face whole' : 'ovd-face'}>{c.face}</div>
              </section>
            ))}
          </div>
        ))}
      </div>
      {open && (
        <div className="ovs-scrim" onMouseDown={(e) => e.target === e.currentTarget && setZoom(null)}>
          <aside key={open.id} className={`ovs tint-${open.tint}${open.id === 'screens' || open.id === 'how' || open.id === 'change' ? ' wide' : ''}`} role="dialog" aria-label={open.title} ref={zoomRef}>
            <header className="ovs-head">
              <Icon name={open.icon} />
              <span className="ovs-title">{open.title}</span>
              {open.count != null && <span className="ovd-count">{open.count}</span>}
              <span className="spacer" />
              <span className="ovs-pos">{tr('overviewTab.position', { n: at + 1, total: zoomable.length })}</span>
              <IconButton icon="chevron-left" title={tr('overviewTab.previous')} onClick={() => step(-1)} />
              <IconButton icon="chevron-right" title={tr('overviewTab.next')} onClick={() => step(1)} />
              <IconButton icon="close" title={tr('overviewTab.close')} onClick={() => setZoom(null)} />
            </header>
            <div className="ovs-body">{open.full}</div>
          </aside>
        </div>
      )}
    </div>
  )
}

/**
 * The parts of the system a change touches, as boxes in columns (what people see on the left, what it
 * rests on to the right) with arrows for how they feed each other. Blown up, each box lists its files.
 */
function ChangeMap({ areas, links, full, onFile }: { areas: Area[]; links: Link[]; full?: boolean; onFile?: (path: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [paths, setPaths] = useState<{ d: string; label?: string; x: number; y: number }[]>([])
  const columns = LAYERS.map((k) => areas.filter((a) => (LAYERS.includes(a.kind) ? a.kind : 'logic') === k)).filter((c) => c.length)
  const marker = full ? 'ovd-arrow-full' : 'ovd-arrow'

  // Arrows drawn between the boxes where they actually are, again whenever the map changes size.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const draw = () => {
      const origin = el.getBoundingClientRect()
      const rect = (id: string) => el.querySelector<HTMLElement>(`[data-area="${CSS.escape(id)}"]`)?.getBoundingClientRect()
      setPaths(
        links.flatMap((l) => {
          const a = rect(l.from)
          const b = rect(l.to)
          if (!a || !b) return []
          const forward = b.left >= a.right - 1
          const back = b.right <= a.left + 1
          let x1: number, y1: number, x2: number, y2: number, d: string
          if (forward || back) {
            x1 = (forward ? a.right : a.left) - origin.left
            x2 = (forward ? b.left : b.right) - origin.left
            y1 = a.top + a.height / 2 - origin.top
            y2 = b.top + b.height / 2 - origin.top
            const bend = (x2 - x1) / 2
            d = `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`
          } else {
            // Same column: from the bottom of one to the top of the other.
            const down = b.top >= a.bottom
            x1 = a.left + a.width / 2 - origin.left
            x2 = b.left + b.width / 2 - origin.left
            y1 = (down ? a.bottom : a.top) - origin.top
            y2 = (down ? b.top : b.bottom) - origin.top
            d = `M${x1},${y1} L${x2},${y2}`
          }
          return [{ d, label: l.label, x: (x1 + x2) / 2, y: (y1 + y2) / 2 }]
        })
      )
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(el)
    return () => ro.disconnect()
  }, [areas, links, full])

  return (
    <div className={full ? 'ovd-map full' : 'ovd-map'} ref={box}>
      <svg className="ovd-map-links" aria-hidden>
        <defs>
          <marker id={marker} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" />
          </marker>
        </defs>
        {paths.map((p, i) => (
          <path key={i} d={p.d} markerEnd={`url(#${marker})`} />
        ))}
      </svg>
      {paths.map((p, i) =>
        p.label ? (
          <span key={i} className="ovd-map-label" style={{ left: p.x, top: p.y }}>
            {p.label}
          </span>
        ) : null
      )}
      {columns.map((col, i) => (
        <div key={i} className="ovd-map-col">
          {col.map((a) => (
            <div key={a.id} className={`ovd-node kind-${a.kind} change-${a.change}`} data-area={a.id}>
              <div className="ovd-node-head">
                <Icon name={KIND_ICON[a.kind] ?? 'symbol-method'} />
                <span className="ovd-node-title">{a.title}</span>
              </div>
              {a.change !== 'changed' && <span className={`ovd-node-change ${a.change}`}>{tr(`overviewTab.change.${a.change}`)}</span>}
              {a.note && <div className="ovd-node-note">{a.note}</div>}
              {full && !!a.files?.length && (
                <ul className="ovd-node-files">
                  {a.files.map((f) => (
                    <li key={f}>
                      <button className="link mono" onClick={() => onFile?.(f)} title={f}>
                        {f.split('/').pop()}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
