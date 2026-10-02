import { useMemo, useState } from 'react'
import { useSession } from '../views/SessionView'
import type { SlashCommand } from '../../../shared/events'
import { Empty, Icon, PanelHeader, Segmented } from '../components/ui'

type Scope = 'all' | 'project' | 'user' | 'plugin' | 'builtin'
const SCOPE_ORDER: Record<Scope, number> = { project: 0, user: 1, plugin: 2, builtin: 3, all: 4 }

/** Claude Code appends the source in parentheses, e.g. "… (project)" or "… (plugin:shopify)". */
function sourceOf(c: SlashCommand): { scope: Scope; label: string; description: string } {
  if (c.builtin) return { scope: 'builtin', label: 'built-in', description: c.description }
  const m = c.description.match(/\s*\(([^()]+)\)\s*$/)
  const raw = m?.[1] ?? ''
  const description = m ? c.description.slice(0, m.index) : c.description
  if (raw === 'project') return { scope: 'project', label: 'project', description }
  if (raw === 'user') return { scope: 'user', label: 'user', description }
  if (raw.startsWith('plugin') || c.name.includes(':')) return { scope: 'plugin', label: raw || 'plugin', description }
  return { scope: 'builtin', label: raw || 'built-in', description }
}

export function SkillsPanel() {
  const { s, send, updateRequirements } = useSession()
  const [scope, setScope] = useState<Scope>('all')
  const [filter, setFilter] = useState('')
  const [armed, setArmed] = useState<string | null>(null)
  const [args, setArgs] = useState('')
  const canSend = s.status === 'ready' || s.status === 'running'
  const pinned = new Set(s.requirements.skills)

  const commands = useMemo(
    () =>
      s.commands
        .map((c) => ({ ...c, ...sourceOf(c) }))
        .filter((c) => (scope === 'all' ? c.scope !== 'builtin' : c.scope === scope))
        .filter((c) => !filter || `${c.name} ${c.description}`.toLowerCase().includes(filter.toLowerCase()))
        .sort((a, b) => Number(pinned.has(b.name)) - Number(pinned.has(a.name)) || SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || a.name.localeCompare(b.name)),
    [s.commands, scope, filter, s.requirements.skills]
  )

  const run = (name: string, a: string) => {
    void send(`/${name}${a.trim() ? ' ' + a.trim() : ''}`)
    setArmed(null)
    setArgs('')
  }

  return (
    <div className="panel">
      <PanelHeader title="Skills and commands" />
      <div className="panel-toolbar wrap">
        <div className="search grow">
          <Icon name="search" />
          <input placeholder={`Search ${s.commands.length} skills and commands`} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <Segmented<Scope>
          value={scope}
          onChange={setScope}
          options={[
            { value: 'all', label: 'All' },
            { value: 'project', label: 'Project' },
            { value: 'user', label: 'Mine' },
            { value: 'plugin', label: 'Plugins' },
            { value: 'builtin', label: 'Built-in' }
          ]}
        />
      </div>
      <div className="panel-scroll flush">
        {s.commands.length === 0 && <Empty icon="sparkle" title="Loading skills…" />}
        {s.commands.length > 0 && commands.length === 0 && <Empty icon="search" title="No matching skills" />}
        {commands.map((c) => (
          <div key={c.name} className={armed === c.name ? 'skill armed' : 'skill'}>
            <div className="skill-main" onDoubleClick={() => canSend && (c.argumentHint ? setArmed(c.name) : run(c.name, ''))}>
              <div className="skill-title">
                <span className="mono">/{c.name}</span>
                <span className={`tag scope-${c.scope}`}>{c.label}</span>
                {c.argumentHint && <span className="muted mono small">{c.argumentHint}</span>}
              </div>
              <div className="muted small clamp-2">{c.description}</div>
            </div>
            <div className="skill-actions">
              <button
                className={pinned.has(c.name) ? 'icon-btn active' : 'icon-btn'}
                title={pinned.has(c.name) ? 'Preferred for this session. Click to remove' : 'Prefer this skill for the session'}
                onClick={() =>
                  updateRequirements((r) => ({ ...r, skills: r.skills.includes(c.name) ? r.skills.filter((x) => x !== c.name) : [...r.skills, c.name] }))
                }
              >
                <Icon name={pinned.has(c.name) ? 'pinned' : 'pin'} />
              </button>
              <button className="primary run" disabled={!canSend} title={`Run /${c.name}`} onClick={() => (c.argumentHint ? setArmed(armed === c.name ? null : c.name) : run(c.name, ''))}>
                <Icon name="play" /> Run
              </button>
            </div>
            {armed === c.name && (
              <div className="skill-args">
                <input autoFocus placeholder={c.argumentHint || 'arguments (optional)'} value={args} onChange={(e) => setArgs(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run(c.name, args)} />
                <button className="primary" onClick={() => run(c.name, args)}>Run</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
