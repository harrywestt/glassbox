import { useMemo, useState } from 'react'
import { useSession } from '../views/SessionView'
import { approxTokens, EDIT_TOOLS, searchHits } from '../session'
import { formatTokens, relPath } from '../lib'
import { Empty, Icon, IconButton, PanelHeader, Section } from '../components/ui'

/** The categorical series colours, per theme (styles.css --cat-1…8), in their fixed order. */
const PALETTE = Array.from({ length: 8 }, (_, i) => `var(--cat-${i + 1})`)
const CONTEXT_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** Group key for a path: its first three directory segments, e.g. api/modules/Documents. */
const moduleOf = (rel: string) => {
  const dirs = rel.split('/').slice(0, -1)
  return dirs.length ? dirs.slice(0, 3).join('/') : '(project root)'
}

export function ContextPanel() {
  const { tab, s, openFile } = useSession()
  const [openModule, setOpenModule] = useState<string | null>(null)
  const ctx = s.context

  const modules = useMemo(() => {
    const byModule = new Map<string, { files: Map<string, { tokens: number; tools: Set<string> }>; tokens: number }>()
    const add = (raw: string, how: string, tokens: number) => {
      const rel = relPath(tab.cwd, raw)
      if (/^([a-z]:)?\//i.test(rel)) return // outside the project
      const key = moduleOf(rel)
      const m = byModule.get(key) ?? { files: new Map(), tokens: 0 }
      const f = m.files.get(rel) ?? { tokens: 0, tools: new Set<string>() }
      f.tokens += tokens
      f.tools.add(how)
      m.tokens += tokens
      m.files.set(rel, f)
      byModule.set(key, m)
    }
    for (const call of Object.values(s.toolCalls)) {
      // Files that came up in search results: seen by Claude even if never opened.
      const hits = searchHits(call)
      if (hits.length) {
        // Share the result's size across the files it listed.
        const each = Math.round(approxTokens(call.result) / hits.length)
        for (const h of hits) add(h, 'found in search', each)
        continue
      }
      if (!CONTEXT_TOOLS.has(call.name)) continue
      const raw = call.input.file_path ?? call.input.notebook_path
      if (typeof raw !== 'string') continue
      add(raw, call.name === 'Read' ? 'read' : EDIT_TOOLS.has(call.name) ? 'edited' : call.name, call.name === 'Read' ? approxTokens(call.result) : 0)
    }
    return [...byModule.entries()].sort((a, b) => b[1].tokens - a[1].tokens)
  }, [s.toolCalls, tab.cwd])

  const used = ctx?.categories.filter((c) => c.kind === 'used') ?? []
  const free = ctx?.categories.find((c) => c.kind === 'free')
  const buffer = ctx?.categories.find((c) => c.kind === 'buffer')

  return (
    <div className="panel">
      <PanelHeader title="Context" />
      <div className="panel-scroll">
        {!ctx ? (
          <Empty icon="layers" title="Context not loaded yet">The breakdown appears once the session has started.</Empty>
        ) : (
          <>
            <section className="card">
              <div className="context-hero">
                <div>
                  <div className="big">{formatTokens(ctx.totalTokens)}</div>
                  <div className="muted small">of {formatTokens(ctx.maxTokens)} used</div>
                </div>
                <div className="right">
                  {/* On the summary's own row, so it's there whether or not the panel shows its heading. */}
                  <div className="context-hero-top">
                    <IconButton icon="refresh" title="Refresh the context breakdown" onClick={() => void window.glassbox.session.refresh(tab.id)} />
                    <div className="big">{(100 - ctx.percentage).toFixed(0)}%</div>
                  </div>
                  <div className="muted small">left{ctx.isAutoCompactEnabled && ctx.autoCompactThreshold ? `, compacts at ${formatTokens(ctx.autoCompactThreshold)}` : ''}</div>
                </div>
              </div>
              <div className="stacked" title="Share of the context window">
                {used.map((c, i) => (
                  <div key={c.name} style={{ width: `${(c.tokens / ctx.maxTokens) * 100}%`, background: PALETTE[i % PALETTE.length] }} title={`${c.name}: ${c.tokens.toLocaleString()}`} />
                ))}
              </div>
              <table className="legend">
                <tbody>
                  {used.map((c, i) => (
                    <tr key={c.name}>
                      <td><span className="swatch" style={{ background: PALETTE[i % PALETTE.length] }} /> {c.name}</td>
                      <td className="num">{c.tokens.toLocaleString()}</td>
                      <td className="num muted">{((c.tokens / ctx.maxTokens) * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
                  {buffer && (
                    <tr className="muted"><td><span className="swatch hatch" /> {buffer.name}</td><td className="num">{buffer.tokens.toLocaleString()}</td><td /></tr>
                  )}
                  {free && (
                    <tr className="muted"><td><span className="swatch empty" /> {free.name}</td><td className="num">{free.tokens.toLocaleString()}</td><td /></tr>
                  )}
                </tbody>
              </table>
            </section>

            {modules.length > 0 && (
            <Section id="context-modules" title="Brought in this session, by module">
              {modules.map(([name, m]) => (
                <div key={name}>
                  <div className="list-row clickable" onClick={() => setOpenModule(openModule === name ? null : name)}>
                    <Icon name={openModule === name ? 'chevron-down' : 'chevron-right'} />
                    <Icon name="package" className="accent" />
                    <span className="grow mono small ellipsis">{name}</span>
                    <span className="muted small">{m.files.size} file{m.files.size > 1 ? 's' : ''}</span>
                    <span className="num small">~{formatTokens(m.tokens)}</span>
                  </div>
                  {openModule === name &&
                    [...m.files.entries()].map(([file, f]) => (
                      <div key={file} className="list-row clickable indent" onClick={() => openFile(file)}>
                        <Icon name="file" />
                        <span className="grow mono small ellipsis" title={file}>{file.split('/').pop()}</span>
                        <span className="muted small">{[...f.tools].join(', ')}</span>
                        <span className="num small">{f.tokens ? `~${formatTokens(f.tokens)}` : ''}</span>
                      </div>
                    ))}
                </div>
              ))}
            </Section>
            )}

            {ctx.messageBreakdown && ctx.messageBreakdown.toolCallsByType.length > 0 && (
              <Section id="context-tools" title="Tool traffic in context">
                {[...ctx.messageBreakdown.toolCallsByType]
                  .sort((a, b) => b.callTokens + b.resultTokens - (a.callTokens + a.resultTokens))
                  .slice(0, 10)
                  .map((t) => (
                    <div key={t.name} className="list-row">
                      <span className="grow mono small">{t.name}</span>
                      <span className="num small">{formatTokens(t.callTokens + t.resultTokens)}</span>
                    </div>
                  ))}
              </Section>
            )}

            {(ctx.memoryFiles.length > 0 || (ctx.systemPromptSections?.length ?? 0) > 0) && (
            <Section id="context-memory" title="Memory and instructions">
              {ctx.memoryFiles.map((f) => (
                <div key={f.path} className="list-row clickable" onClick={() => openFile(f.path)} title={f.path}>
                  <Icon name="book" />
                  <span className="grow mono small ellipsis">{f.path}</span>
                  <span className="tag">{f.type}</span>
                  <span className="num small">{formatTokens(f.tokens)}</span>
                </div>
              ))}
              {ctx.systemPromptSections?.map((p) => (
                <div key={p.name} className="list-row">
                  <Icon name="symbol-namespace" />
                  <span className="grow small">{p.name}</span>
                  <span className="num small">{formatTokens(p.tokens)}</span>
                </div>
              ))}
            </Section>
            )}

            <Section id="context-capabilities" title="Capabilities loaded">
              {ctx.skills && (
                <div className="list-row"><Icon name="sparkle" /><span className="grow small">Skills: {ctx.skills.includedSkills} of {ctx.skills.totalSkills} listed</span><span className="num small">{formatTokens(ctx.skills.tokens)}</span></div>
              )}
              {ctx.agents.length > 0 && (
                <div className="list-row"><Icon name="organization" /><span className="grow small">Agent definitions: {ctx.agents.length}</span><span className="num small">{formatTokens(ctx.agents.reduce((n, a) => n + a.tokens, 0))}</span></div>
              )}
              <div className="list-row">
                <Icon name="plug" />
                <span className="grow small">Connector tools: {ctx.mcpTools.filter((t) => t.isLoaded !== false).length} loaded of {ctx.mcpTools.length}</span>
                <span className="num small">{formatTokens(ctx.mcpTools.filter((t) => t.isLoaded !== false).reduce((n, t) => n + t.tokens, 0))}</span>
              </div>
              {ctx.slashCommands && (
                <div className="list-row"><Icon name="terminal" /><span className="grow small">Commands: {ctx.slashCommands.includedCommands} of {ctx.slashCommands.totalCommands}</span><span className="num small">{formatTokens(ctx.slashCommands.tokens)}</span></div>
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  )
}

