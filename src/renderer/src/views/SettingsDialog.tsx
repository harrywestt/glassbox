import { useEffect, useState, type ReactNode } from 'react'
import { ColourWheel } from '../components/ColourWheel'
import { isHex } from '../colour'
import { ACCENTS, accentFor, CHAT_SIZES, UI_SCALES, resetAppearance, setAppearance, useAppearance, type ChatWidth, type TableStyle, type ThemePreference } from '../appearance'
import { useThemeTokens } from '../App'
import { Icon, IconButton, Segmented, Toggle } from '../components/ui'
import { loadEffort, saveEffort } from '../session-ui/ModelPicker'
import type { Automation, Effort, HoldPolicy } from '../../../shared/events'
import { tr } from '../../../shared/i18n'

type SectionId = 'appearance' | 'conversation' | 'notifications' | 'models' | 'background' | 'editing' | 'voice'
const SECTIONS: { id: SectionId; icon: string }[] = [
  { id: 'appearance', icon: 'symbol-color' },
  { id: 'conversation', icon: 'comment-discussion' },
  { id: 'notifications', icon: 'bell' },
  { id: 'models', icon: 'sparkle' },
  { id: 'background', icon: 'zap' },
  { id: 'editing', icon: 'edit' },
  { id: 'voice', icon: 'mic' }
]

/** One setting: what it is (and a line on what it does) on the left, its control on the right. */
function Row({ label, note, children, sub, tokens }: { label: string; note?: string; children: ReactNode; sub?: boolean; tokens?: boolean }) {
  return (
    <div className={sub ? 'set-row sub' : 'set-row'}>
      <div className="set-text">
        <div className="set-label">
          {label}
          {tokens && <span className="set-tokens" title={tr('settings.usesTokensTip')}>{tr('settings.usesTokens')}</span>}
        </div>
        {note && <div className="set-note">{note}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

/**
 * Settings, as a page of its own (from the dashboard's gear, or Ctrl+,): sections down the side,
 * each a group of rows. Everything that makes Claude spend tokens by itself is together under
 * "Background Claude", marked, and off unless you turn it on.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const a = useAppearance()
  const auto = a.automation
  const set = (next: Partial<Automation>) => setAppearance({ automation: { ...auto, ...next } })
  const base = useThemeTokens().base
  const custom = isHex(a.accent)
  const [wheel, setWheel] = useState(false)
  const [section, setSection] = useState<SectionId>(() => (sessionStorage.getItem('glassbox.settingsSection') as SectionId) || 'appearance')
  const [effort, setEffort] = useState<Effort | null>(loadEffort)
  const go = (id: SectionId) => {
    setSection(id)
    sessionStorage.setItem('glassbox.settingsSection', id)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !wheel && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, wheel])

  const backgroundOn = (['promptSuggestions', 'agentSummaries', 'nudges', 'autoMap', 'autoTicket', 'autoCommit', 'quickAnswers', 'watchdog'] as const).filter((k) => auto[k]).length

  const body: Record<SectionId, ReactNode> = {
    appearance: (
      <>
        <Row label={tr('appearanceCard.theme')}>
          <Segmented<ThemePreference>
            value={a.theme}
            onChange={(theme) => setAppearance({ theme })}
            options={[
              { value: 'system', label: tr('appearanceCard.themeSystem') },
              { value: 'dark', label: tr('appearanceCard.themeDark') },
              { value: 'light', label: tr('appearanceCard.themeLight') }
            ]}
          />
        </Row>
        <Row label={tr('appearanceCard.accentColour')}>
          <div className="accent-swatches" role="radiogroup" aria-label={tr('appearanceCard.accentColour')}>
            {ACCENTS.map((c) => (
              <button
                key={c.id}
                role="radio"
                aria-checked={a.accent === c.id}
                className={a.accent === c.id ? 'accent-swatch on' : 'accent-swatch'}
                style={{ ['--swatch' as string]: c[base] }}
                title={c.label}
                onClick={() => (setAppearance({ accent: c.id }), setWheel(false))}
              />
            ))}
            <span className="accent-custom">
              <button
                role="radio"
                aria-checked={custom}
                aria-expanded={wheel}
                className={custom ? 'accent-swatch custom on' : 'accent-swatch custom'}
                style={custom ? { ['--swatch' as string]: accentFor(a, base) } : undefined}
                title={tr('appearanceCard.customColour')}
                onClick={() => setWheel((w) => !w)}
              />
              {wheel && (
                <>
                  <div className="menu-scrim" onMouseDown={() => setWheel(false)} />
                  <div className="accent-wheel" role="dialog" aria-label={tr('appearanceCard.customColour')} onKeyDown={(e) => e.key === 'Escape' && setWheel(false)}>
                    <ColourWheel value={custom ? a.accent : '#4f8ff7'} onChange={(accent) => setAppearance({ accent })} />
                    <p className="setting-note">{tr('appearanceCard.customColourNote')}</p>
                  </div>
                </>
              )}
            </span>
          </div>
        </Row>
        <Row label={tr('appearanceCard.interfaceSize')} note={tr('settings.interfaceSizeNote')}>
          <Segmented<string>
            value={String(a.uiScale)}
            onChange={(v) => setAppearance({ uiScale: Number(v) })}
            options={UI_SCALES.map((n) => ({ value: String(n), label: tr('appearanceCard.percent', { n: Math.round(n * 100) }) }))}
          />
        </Row>
      </>
    ),
    conversation: (
      <>
        <Row label={tr('appearanceCard.conversationText')}>
          <Segmented<string>
            value={String(a.chatSize)}
            onChange={(v) => setAppearance({ chatSize: Number(v) })}
            options={CHAT_SIZES.map((n) => ({ value: String(n), label: tr('appearanceCard.pixels', { n }) }))}
          />
        </Row>
        <Row label={tr('appearanceCard.conversationWidth')}>
          <Segmented<ChatWidth>
            value={a.chatWidth}
            onChange={(chatWidth) => setAppearance({ chatWidth })}
            options={[
              { value: 'full', label: tr('appearanceCard.widthFull') },
              { value: 'wide', label: tr('appearanceCard.widthWide') },
              { value: 'comfortable', label: tr('appearanceCard.widthNarrow') }
            ]}
          />
        </Row>
        <Row label={tr('appearanceCard.tables')}>
          <Segmented<TableStyle>
            value={a.tableStyle}
            onChange={(tableStyle) => setAppearance({ tableStyle })}
            options={[
              { value: 'striped', label: tr('appearanceCard.tableStriped') },
              { value: 'grid', label: tr('appearanceCard.tableGrid') },
              { value: 'minimal', label: tr('appearanceCard.tableMinimal') }
            ]}
          />
        </Row>
        <div className="set-preview">
          <div className="set-preview-label">{tr('settings.preview')}</div>
          <div className="markdown" style={{ fontSize: a.chatSize }}>
            <p>
              {tr('appearanceCard.previewBefore')}<strong>{tr('appearanceCard.previewBold')}</strong>{tr('appearanceCard.previewMiddle')}<code>{tr('appearanceCard.previewCode')}</code>{tr('appearanceCard.previewAfter')}
            </p>
            <table>
              <thead>
                <tr><th>{tr('appearanceCard.previewFile')}</th><th>{tr('appearanceCard.previewChange')}</th><th>{tr('appearanceCard.previewLines')}</th></tr>
              </thead>
              <tbody>
                <tr><td>api.js</td><td>{tr('appearanceCard.previewAddedJsdoc')}</td><td>+12</td></tr>
                <tr><td>shipping.js</td><td>{tr('appearanceCard.previewNewModule')}</td><td>+8</td></tr>
                <tr><td>api.test.js</td><td>{tr('appearanceCard.previewNewTests')}</td><td>+24</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </>
    ),
    notifications: (
      <>
        <Row label={tr('appearanceCard.desktopNotifications')} note={tr('settings.notificationsNote')}>
          <Toggle checked={a.notifications} onChange={(notifications) => setAppearance({ notifications })} />
        </Row>
        <Row label={tr('appearanceCard.awayDigest')} note={tr('settings.awayDigestNote')}>
          <Toggle checked={a.awayDigest} onChange={(awayDigest) => setAppearance({ awayDigest })} />
        </Row>
      </>
    ),
    models: (
      <>
        <Row label={tr('automationCard.autoModel')} note={tr('automationCard.autoModelNote')}>
          <Toggle checked={auto.autoModel ?? true} onChange={(autoModel) => set({ autoModel })} />
        </Row>
        <Row label={tr('settings.agentForks')} note={tr('settings.agentForksNote')} tokens>
          <Toggle checked={auto.agentForks} onChange={(agentForks) => set({ agentForks })} />
        </Row>
        <Row label={tr('settings.effort')} note={tr('settings.effortNote')}>
          <Segmented<string>
            value={effort ?? ''}
            onChange={(v) => {
              const level = (v || null) as Effort | null
              setEffort(level)
              saveEffort(level)
            }}
            options={[{ value: '', label: tr('modelPicker.effortName.default') }, ...(['low', 'medium', 'high', 'xhigh', 'max'] as const).map((l) => ({ value: l, label: tr(`modelPicker.effort.${l}`) }))]}
          />
        </Row>
      </>
    ),
    background: (
      <>
        <div className="set-callout">
          <Icon name="info" />
          <span>{tr('settings.backgroundIntro')}</span>
        </div>
        <div className="set-group-label">{tr('settings.inSessions')}</div>
        <Row label={tr('settings.promptSuggestions')} note={tr('settings.promptSuggestionsNote')} tokens>
          <Toggle checked={auto.promptSuggestions} onChange={(promptSuggestions) => set({ promptSuggestions })} />
        </Row>
        <Row label={tr('automationCard.quickAnswers')} note={tr('automationCard.quickAnswersNote')} tokens>
          <Toggle checked={auto.quickAnswers} onChange={(quickAnswers) => set({ quickAnswers })} />
        </Row>
        <Row label={tr('settings.nudges')} note={tr('settings.nudgesNote')} tokens>
          <Toggle checked={auto.nudges} onChange={(nudges) => set({ nudges })} />
        </Row>
        <Row label={tr('settings.agentSummaries')} note={tr('settings.agentSummariesNote')} tokens>
          <Toggle checked={auto.agentSummaries} onChange={(agentSummaries) => set({ agentSummaries })} />
        </Row>
        <Row label={tr('automationCard.watchdog')} note={tr('automationCard.watchdogNote')} tokens>
          <Toggle checked={auto.watchdog} onChange={(watchdog) => set({ watchdog })} />
        </Row>
        {auto.watchdog && (
          <>
            <Row sub label={tr('automationCard.nudgeAfter')}>
              <Segmented<string> value={String(auto.watchdogNudgeMinutes)} onChange={(v) => set({ watchdogNudgeMinutes: Number(v) })} options={[5, 10, 20, 30].map((n) => ({ value: String(n), label: tr('automationCard.minutes', { n }) }))} />
            </Row>
            <Row sub label={tr('automationCard.stopAfter')}>
              <Segmented<string>
                value={String(auto.watchdogStopMinutes)}
                onChange={(v) => set({ watchdogStopMinutes: Number(v) })}
                options={[...[10, 15, 30].map((n) => ({ value: String(n), label: tr('automationCard.minutes', { n }) })), { value: '0', label: tr('automationCard.never') }]}
              />
            </Row>
          </>
        )}
        <Row label={tr('settings.autoCommit')} note={tr('settings.autoCommitNote')} tokens>
          <Toggle checked={auto.autoCommit} onChange={(autoCommit) => set({ autoCommit })} />
        </Row>
        <div className="set-group-label">{tr('settings.inViews')}</div>
        <Row label={tr('settings.autoMap')} note={tr('settings.autoMapNote')} tokens>
          <Toggle checked={auto.autoMap} onChange={(autoMap) => set({ autoMap })} />
        </Row>
        <Row label={tr('settings.autoTicket')} note={tr('settings.autoTicketNote')} tokens>
          <Toggle checked={auto.autoTicket} onChange={(autoTicket) => set({ autoTicket })} />
        </Row>
      </>
    ),
    editing: (
      <Row label={tr('automationCard.holdEdits')} note={tr('automationCard.holdEditsNote')}>
        <Segmented<HoldPolicy>
          value={auto.holdEdits ?? 'ask'}
          onChange={(holdEdits) => set({ holdEdits })}
          options={[
            { value: 'ask', label: tr('live.edit.policy.ask') },
            { value: 'offplan', label: tr('live.edit.policy.offplan') },
            { value: 'all', label: tr('live.edit.policy.all') }
          ]}
        />
      </Row>
    ),
    voice: (
      <>
        <Row label={tr('automationCard.voiceAccurate')} note={tr('automationCard.voiceAccurateNote')}>
          <Toggle checked={auto.voiceAccurate} onChange={(voiceAccurate) => set({ voiceAccurate })} />
        </Row>
        <Row label={tr('automationCard.micWarm')} note={tr('automationCard.micWarmNote')}>
          <Toggle checked={auto.micWarm} onChange={(micWarm) => set({ micWarm })} />
        </Row>
      </>
    )
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings" role="dialog" aria-modal="true" aria-label={tr('settings.title')}>
        <nav className="settings-nav" aria-label={tr('settings.title')}>
          <div className="settings-nav-title">{tr('settings.title')}</div>
          {SECTIONS.map((sct) => (
            <button key={sct.id} className={section === sct.id ? 'on' : ''} aria-current={section === sct.id ? 'page' : undefined} onClick={() => go(sct.id)}>
              <Icon name={sct.icon} />
              <span className="grow">{tr(`settings.section.${sct.id}`)}</span>
              {sct.id === 'background' && backgroundOn > 0 && <span className="settings-count" title={tr('settings.backgroundOn', { count: backgroundOn })}>{backgroundOn}</span>}
            </button>
          ))}
          <span className="grow" />
          <button className="settings-reset" onClick={resetAppearance}>
            <Icon name="discard" /> {tr('appearanceCard.resetToDefaults')}
          </button>
        </nav>
        <div className="settings-main">
          <header className="settings-head">
            <div>
              <h2>{tr(`settings.section.${section}`)}</h2>
              <p>{tr(`settings.blurb.${section}`)}</p>
            </div>
            <IconButton icon="close" title={tr('settings.close')} onClick={onClose} />
          </header>
          <div className="settings-body">{body[section]}</div>
        </div>
      </div>
    </div>
  )
}
