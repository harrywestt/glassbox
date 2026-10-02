import { useState } from 'react'
import { useSession } from '../views/SessionView'
import type { McpServerStatus } from '../../../shared/events'
import { Empty, Icon, IconButton, PanelHeader, Toggle } from '../components/ui'
import { tr } from '../../../shared/i18n'

const STATUS: Record<McpServerStatus['status'], { label: string; cls: string }> = {
  connected: { label: tr('connectorsPanel.statusConnected'), cls: 'ok' },
  pending: { label: tr('connectorsPanel.statusConnecting'), cls: 'muted' },
  'needs-auth': { label: tr('connectorsPanel.statusNeedsAuth'), cls: 'warn' },
  failed: { label: tr('connectorsPanel.statusFailed'), cls: 'err' },
  disabled: { label: tr('connectorsPanel.statusOff'), cls: 'muted' }
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
    [tr('connectorsPanel.claudeAiConnectors'), servers.filter((m) => m.source === 'claudeai')],
    [tr('connectorsPanel.mcpServers'), servers.filter((m) => m.source !== 'claudeai')]
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
      <PanelHeader title={tr('connectorsPanel.title')} />
      <div className="panel-toolbar">
        <div className="search grow">
          <Icon name="search" />
          <input placeholder={tr('connectorsPanel.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <IconButton icon="refresh" title={tr('connectorsPanel.refresh')} onClick={() => void window.glassbox.session.refresh(tab.id)} />
      </div>
      <div className="hint small muted">
        <Icon name="pin" /> <strong>{tr('connectorsPanel.hintRequire')}</strong> {tr('connectorsPanel.hintBody')}
      </div>
      <div className="panel-scroll flush">
        {s.mcp.length === 0 && <Empty icon="plug" title={tr('connectorsPanel.loading')} />}
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
                      <button className="icon-btn" onClick={() => setOpen(open === m.name ? null : m.name)} title={tr('connectorsPanel.showTools')}>
                        <Icon name={open === m.name ? 'chevron-down' : 'chevron-right'} />
                      </button>
                      <span className={`dot dot-${st.cls}`} />
                      <span className="grow connector-name">
                        <span className="ellipsis">{connectorName(m.name)}</span>
                        <span className={`small ${m.status === 'connected' ? 'muted' : st.cls}`}>{m.status === 'connected' && m.tools?.length ? tr('connectorsPanel.tools', { n: m.tools.length }) : st.label}</span>
                        
                      </span>
                      <button
                        className={isReq ? 'chip-btn on' : 'chip-btn'}
                        disabled={m.status !== 'connected' && !isReq}
                        onClick={() => require(m.name)}
                        title={isReq ? tr('connectorsPanel.requiredTitle') : tr('connectorsPanel.requireTitle')}
                      >
                        <Icon name={isReq ? 'pinned' : 'pin'} /> {isReq ? tr('connectorsPanel.required') : tr('connectorsPanel.require')}
                      </button>
                      <Toggle checked={m.status !== 'disabled'} onChange={(on) => void toggle(m.name, on)} title={busy === m.name ? tr('connectorsPanel.updating') : tr('connectorsPanel.onForSession')} />
                    </div>
                    {open === m.name && (
                      <div className="connector-tools">
                        {m.error && <div className="note note-error">{m.error}</div>}
                        {m.status === 'needs-auth' && (
                          <div className="muted small">{tr('connectorsPanel.signInBefore')} <span className="mono">/mcp</span> {tr('connectorsPanel.signInAfter')}</div>
                        )}
                        {m.tools?.map((t) => (
                          <div key={t.name} className="tool-def">
                            <span className="mono small">{t.name}</span>
                            {t.annotations?.readOnly && <span className="tag">{tr('connectorsPanel.readOnly')}</span>}
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
