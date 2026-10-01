import { useState } from 'react'
import { useSession } from '../views/SessionView'
import type { McpServerStatus } from '../../../shared/events'
import { Empty, Icon, IconButton, PanelHeader, Toggle } from '../components/ui'

const STATUS: Record<McpServerStatus['status'], { label: string; cls: string }> = {
  connected: { label: 'Connected', cls: 'ok' },
  pending: { label: 'Connecting…', cls: 'muted' },
  'needs-auth': { label: 'Needs sign-in', cls: 'warn' },
  failed: { label: 'Failed', cls: 'err' },
  disabled: { label: 'Off', cls: 'muted' }
}

export const connectorName = (name: string) => name.replace(/^claude\.ai /, '')

export function ConnectorsPanel() {
  const { tab, s, updateRequirements } = useSession()
  const [open, setOpen] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const rank: Record<string, number> = { connected: 0, pending: 1, 'needs-auth': 2, failed: 3, disabled: 4 }
  const servers = s.mcp
    .filter((m) => m.source !== 'sdk' && connectorName(m.name).toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name))
  const groups: [string, McpServerStatus[]][] = [
    ['claude.ai connectors', servers.filter((m) => m.source === 'claudeai')],
    ['MCP servers', servers.filter((m) => m.source !== 'claudeai')]
  ]
  const required = new Set(s.requirements.connectors)

  const toggle = async (name: string, enabled: boolean) => {
    setBusy(name)
    try {
      await window.glassbox.session.toggleMcp(tab.id, name, enabled)
    } finally {
      setBusy(null)
    }
  }
  const require = (name: string) =>
    updateRequirements((r) => ({
      ...r,
      connectors: r.connectors.includes(name) ? r.connectors.filter((c) => c !== name) : [...r.connectors, name]
    }))

  return (
    <div className="panel">
      <PanelHeader title="Connectors">
        <IconButton icon="refresh" title="Refresh" onClick={() => void window.glassbox.session.refresh(tab.id)} />
      </PanelHeader>
      <div className="panel-toolbar">
        <div className="search grow">
          <Icon name="search" />
          <input placeholder="Filter connectors" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      </div>
      <div className="hint small muted">
        <Icon name="pin" /> <strong>Require</strong> tells Claude to use a connector for this session. The switch turns a connector on or off for this session only.
      </div>
      <div className="panel-scroll flush">
        {s.mcp.length === 0 && <Empty icon="plug" title="Loading connectors…" />}
        {groups.map(([title, list]) =>
          list.length ? (
            <section key={title}>
              <div className="group-title">
                {title} <span className="count">{list.length}</span>
              </div>
              {list.map((m) => {
                const st = STATUS[m.status]
                const isReq = required.has(m.name)
                return (
                  <div key={m.name} className="connector">
                    <div className="connector-row">
                      <button className="icon-btn" onClick={() => setOpen(open === m.name ? null : m.name)} title="Show tools">
                        <Icon name={open === m.name ? 'chevron-down' : 'chevron-right'} />
                      </button>
                      <span className={`dot dot-${st.cls}`} />
                      <span className="grow connector-name">
                        <span className="ellipsis">{connectorName(m.name)}</span>
                        <span className={`small ${m.status === 'connected' ? 'muted' : st.cls}`}>{m.status === 'connected' && m.tools?.length ? `${m.tools.length} tools` : st.label}</span>
                        
                      </span>
                      <button
                        className={isReq ? 'chip-btn on' : 'chip-btn'}
                        disabled={m.status !== 'connected' && !isReq}
                        onClick={() => require(m.name)}
                        title={isReq ? 'Required for this session. Click to remove' : 'Require Claude to use this connector'}
                      >
                        <Icon name={isReq ? 'pinned' : 'pin'} /> {isReq ? 'Required' : 'Require'}
                      </button>
                      <Toggle checked={m.status !== 'disabled'} onChange={(on) => void toggle(m.name, on)} title={busy === m.name ? 'Updating…' : 'On for this session'} />
                    </div>
                    {open === m.name && (
                      <div className="connector-tools">
                        {m.error && <div className="note note-error">{m.error}</div>}
                        {m.status === 'needs-auth' && (
                          <div className="muted small">Sign in to this connector in claude.ai (Settings → Connectors) or with <span className="mono">/mcp</span> in the Claude Code CLI, then refresh.</div>
                        )}
                        {m.tools?.map((t) => (
                          <div key={t.name} className="tool-def">
                            <span className="mono small">{t.name}</span>
                            {t.annotations?.readOnly && <span className="tag">read-only</span>}
                            {t.description && <div className="muted small clamp-2">{t.description}</div>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </section>
          ) : null
        )}
      </div>
    </div>
  )
}
