import { useMemo, useState } from 'react'
import { useSession } from '../views/SessionView'
import { saveGuardrails, sideEffectOf, useGuardrails, type Risk, type SideEffect } from '../review'
import { timeAgo } from '../lib'
import { toolLabel } from '../session-ui/Timeline'
import { Empty, Icon, PanelHeader, Segmented } from '../components/ui'
import type { GuardAction, GuardRule, GuardScope } from '../../../shared/events'
import { Select } from '../components/Select'
import { tr } from '../../../shared/i18n'

type View = 'effects' | 'rules'

export function GuardrailsPanel() {
  const [view, setView] = useState<View>('effects')
  return (
    <div className="panel">
      <PanelHeader title={tr('guardrailsPanel.title')} />
      <div className="panel-toolbar">
        <Segmented<View> value={view} onChange={setView} options={[{ value: 'effects', label: tr('guardrailsPanel.sideEffects') }, { value: 'rules', label: tr('guardrailsPanel.rules') }]} />
      </div>
      {view === 'effects' ? <SideEffects /> : <Rules />}
    </div>
  )
}

const RISK_ORDER: Record<Risk, number> = { high: 0, medium: 1, low: 2 }

function SideEffects() {
  const { tab, s } = useSession()
  const [risk, setRisk] = useState<'all' | Risk>('all')
  const effects = useMemo(
    () =>
      Object.values(s.toolCalls)
        .map((c) => sideEffectOf(c, tab.cwd))
        .filter((e): e is SideEffect => !!e)
        .sort((a, b) => b.call.at - a.call.at),
    [s.toolCalls, tab.cwd]
  )
  const shown = effects.filter((e) => risk === 'all' || e.risk === risk).sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || b.call.at - a.call.at)

  return (
    <div className="panel-scroll">
      {s.guardHits.length > 0 && (
        <section className="card">
          <div className="card-title">{tr('guardrailsPanel.stoppedBy')}</div>
          {[...s.guardHits].reverse().map((h) => (
            <div key={h.toolUseId + h.at} className="effect">
              <Icon name="shield" className={h.action === 'block' ? 'err' : 'warn'} />
              <div className="grow">
                <div>
                  {h.action === 'block' ? tr('guardrailsPanel.blocked', { label: h.label }) : tr('guardrailsPanel.askedYou', { label: h.label })} <span className="muted small">{timeAgo(h.at)}</span>
                </div>
                <div className="mono small muted ellipsis" title={h.detail}>{h.detail}</div>
              </div>
            </div>
          ))}
        </section>
      )}
      <section className="card">
        <div className="card-title">
          {tr('guardrailsPanel.outsideConversation')}
          <span className="spacer" />
          <Segmented
            value={risk}
            onChange={setRisk}
            options={[
              { value: 'all', label: tr('guardrailsPanel.riskAll') },
              { value: 'high', label: tr('guardrailsPanel.riskHigh') },
              { value: 'medium', label: tr('guardrailsPanel.riskMedium') },
              { value: 'low', label: tr('guardrailsPanel.riskLow') }
            ]}
          />
        </div>
        {shown.length === 0 ? (
          <Empty icon="shield" title={tr('guardrailsPanel.emptyTitle')}>{tr('guardrailsPanel.emptyBody')}</Empty>
        ) : (
          shown.map((e) => (
            <div key={e.call.id} className="effect">
              <span className={`risk risk-${e.risk}`} title={tr(`guardrailsPanel.riskTitle.${e.risk}`)} />
              <div className="grow">
                <div>
                  {e.category} <span className="muted small">{toolLabel(e.call.name)}, {timeAgo(e.call.at)}</span>
                  {e.call.status === 'error' && <span className="tag">{tr('guardrailsPanel.failed')}</span>}
                </div>
                <div className="mono small muted ellipsis" title={e.detail}>{e.detail}</div>
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  )
}

const ACTIONS: { value: GuardAction; label: string }[] = [
  { value: 'block', label: tr('guardrailsPanel.actionBlock') },
  { value: 'ask', label: tr('guardrailsPanel.actionAsk') },
  { value: 'off', label: tr('guardrailsPanel.actionOff') }
]

function Rules() {
  const rules = useGuardrails()
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<{ label: string; scope: GuardScope; pattern: string; action: GuardAction }>({ label: '', scope: 'shell', pattern: '', action: 'ask' })
  const [error, setError] = useState<string | null>(null)

  const update = (id: string, patch: Partial<GuardRule>) => saveGuardrails(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const add = () => {
    try {
      new RegExp(draft.pattern)
    } catch {
      return setError(tr('guardrailsPanel.invalidPattern'))
    }
    if (!draft.label.trim() || !draft.pattern.trim()) return setError(tr('guardrailsPanel.needNameAndPattern'))
    saveGuardrails([...rules, { id: `custom-${crypto.randomUUID().slice(0, 8)}`, ...draft, label: draft.label.trim() }])
    setDraft({ label: '', scope: 'shell', pattern: '', action: 'ask' })
    setAdding(false)
    setError(null)
  }

  return (
    <div className="panel-scroll">
      <div className="hint small muted">
        {tr('guardrailsPanel.hintIntro')} <strong>{tr('guardrailsPanel.hintBlock')}</strong> {tr('guardrailsPanel.hintBlockBody')} <strong>{tr('guardrailsPanel.hintAsk')}</strong> {tr('guardrailsPanel.hintAskBody')}
      </div>
      {rules.map((r) => (
        <div key={r.id} className="rule">
          <div className="grow">
            <div className="rule-label">{r.label}</div>
            <div className="muted small">
              {r.scope === 'shell' ? tr('guardrailsPanel.scopeShell') : r.scope === 'edit' ? tr('guardrailsPanel.scopeEdit') : tr('guardrailsPanel.scopeMcp')}
              {r.pattern && !r.id.startsWith(':') && <span className="mono"> /{r.pattern.length > 48 ? r.pattern.slice(0, 46) + '…' : r.pattern}/</span>}
            </div>
          </div>
          <Segmented<GuardAction> value={r.action} onChange={(action) => update(r.id, { action })} options={ACTIONS} />
          {!r.builtin && (
            <button className="icon-btn" title={tr('guardrailsPanel.deleteRule')} onClick={() => saveGuardrails(rules.filter((x) => x.id !== r.id))}>
              <Icon name="trash" />
            </button>
          )}
        </div>
      ))}
      <div className="pad-x">
        {adding ? (
          <div className="rule-form">
            <input placeholder={tr('guardrailsPanel.namePlaceholder')} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
            <div className="form-row">
              <Select<GuardScope>
                value={draft.scope}
                onChange={(scope) => setDraft({ ...draft, scope })}
                aria-label={tr('guardrailsPanel.whatRuleChecks')}
                options={[
                  { value: 'shell', label: tr('guardrailsPanel.matchShell') },
                  { value: 'edit', label: tr('guardrailsPanel.matchEdit') },
                  { value: 'mcp', label: tr('guardrailsPanel.matchMcp') }
                ]}
              />
              <Segmented<GuardAction> value={draft.action} onChange={(action) => setDraft({ ...draft, action })} options={ACTIONS.slice(0, 2)} />
            </div>
            <input className="mono" placeholder={tr('guardrailsPanel.patternPlaceholder')} value={draft.pattern} onChange={(e) => setDraft({ ...draft, pattern: e.target.value })} />
            {error && <div className="err small">{error}</div>}
            <div className="row-actions">
              <button onClick={() => (setAdding(false), setError(null))}>{tr('guardrailsPanel.cancel')}</button>
              <button className="primary" onClick={add}>{tr('guardrailsPanel.addRule')}</button>
            </div>
          </div>
        ) : (
          <button className="chip-btn" onClick={() => setAdding(true)}>
            <Icon name="add" /> {tr('guardrailsPanel.addARule')}
          </button>
        )}
      </div>
    </div>
  )
}
