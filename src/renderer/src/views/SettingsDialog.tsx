import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { ColourWheel } from '../components/ColourWheel'
import { contrast, isHex, mix, readableOn } from '../colour'
import { ACCENTS, accentFor, CHAT_SIZES, DEFAULT_ACCENT, UI_SCALES, resetAppearance, setAppearance, useAppearance, type ChatWidth, type CustomTheme, type PanelFrost, type Spinner, type TableStyle } from '../appearance'
import { SPINNERS, WorkingMark } from '../session-ui/WorkingMark'
import { Backdrop, BACKDROPS } from '../components/Backdrop'
import { useThemeTokens } from '../App'
import { customFrom, customTokens, THEME_CHOICES, THEMES, themeTokens, type ThemeTokens } from '../theme'
import { Icon, IconButton, Segmented, Toggle } from '../components/ui'
import { loadEffort, saveEffort } from '../session-ui/ModelPicker'
import type { Automation, Effort, HoldPolicy } from '../../../shared/events'
import { tr } from '../../../shared/i18n'

type SectionId = 'appearance' | 'conversation' | 'notifications' | 'models' | 'background' | 'editing' | 'voice'
const SECTIONS: { id: SectionId; icon: string }[] = [
  { id: 'appearance', icon: 'symbol-color' },
  { id: 'conversation', icon: 'comment-discussion' },
  { id: 'notifications', icon: 'bell' },
  { id: 'models', icon: 'hubot' },
  { id: 'background', icon: 'zap' },
  { id: 'editing', icon: 'edit' },
  { id: 'voice', icon: 'mic' }
]

/** A tiny window in a theme's colours: a title strip, a side bar, a user bubble, two lines of text and the accent. */
function ThemeThumb({ t, className }: { t: ThemeTokens; className?: string }) {
  const vars = { '--t-bg': t.bg, '--t-side': t.surface, '--t-bar': t.surface2, '--t-border': t.border, '--t-fg': t.fg, '--t-muted': t.subtle, '--t-accent': t.accent, '--t-bubble': t.userBubble }
  return (
    <span className={className ? `theme-thumb ${className}` : 'theme-thumb'} style={vars as CSSProperties} aria-hidden>
      <span className="tt-bar" />
      <span className="tt-side" />
      <span className="tt-main">
        <span className="tt-bubble" />
        <span className="tt-line" />
        <span className="tt-line short" />
        <span className="tt-pill" />
      </span>
    </span>
  )
}

const CUSTOM_KEYS = ['bg', 'surface', 'fg', 'accent'] as const
type CustomKey = (typeof CUSTOM_KEYS)[number]

const darkBackground = (hex: string) => contrast(hex, '#ffffff') > contrast(hex, '#000000')
/** How well text in this colour reads on the harder of the two backgrounds. */
const textContrast = (c: CustomTheme, hex: string) => Math.min(contrast(hex, c.bg), contrast(hex, c.surface))

/** Text pulled just far enough lighter or darker to read easily on both backgrounds, and the accent to read on them too. */
function keepReadable(c: CustomTheme): CustomTheme {
  const worst = contrast(c.fg, c.bg) < contrast(c.fg, c.surface) ? c.bg : c.surface
  const fg = textContrast(c, c.fg) >= 7 ? c.fg : readableOn(c.fg, worst, c.base, 7)
  const accent = textContrast(c, c.accent) >= 3 ? c.accent : readableOn(c.accent, worst, c.base, 3)
  return { ...c, fg, accent }
}

/** A grade for a contrast ratio: comfortable, readable, or hard to read. */
function Grade({ ratio, need }: { ratio: number; need: number }) {
  const level = ratio >= need * 1.5 ? 'good' : ratio >= need ? 'ok' : 'bad'
  return (
    <span className={`ct-grade ${level}`} title={tr('appearanceCard.contrastTip', { ratio: ratio.toFixed(1) })}>
      {tr(`appearanceCard.grade.${level}`)}
    </span>
  )
}

/** A small window in the theme being made, with real words in it, so you can judge it as you'd use it. */
function ThemePreview({ t }: { t: ThemeTokens }) {
  const vars = { '--p-bg': t.bg, '--p-surface': t.surface, '--p-bar': t.surface2, '--p-elevated': t.elevated, '--p-border': t.border, '--p-fg': t.fg, '--p-muted': t.muted, '--p-subtle': t.subtle, '--p-accent': t.accent, '--p-accent-fg': t.accentFg, '--p-ok': t.ok, '--p-warn': t.warn, '--p-err': t.err, '--p-bubble': t.userBubble, '--p-sel': t.selection }
  return (
    <div className="ct-preview" style={vars as CSSProperties} aria-label={tr('appearanceCard.previewLabel')} role="img">
      <div className="ctp-bar">
        <span className="ctp-tab on">{tr('appearanceCard.sample.conversation')}</span>
        <span className="ctp-tab">{tr('appearanceCard.sample.live')}</span>
      </div>
      <div className="ctp-body">
        <div className="ctp-main">
          <div className="ctp-bubble">{tr('appearanceCard.sample.ask')}</div>
          <p className="ctp-text">{tr('appearanceCard.sample.reply')}</p>
          <p className="ctp-muted">{tr('appearanceCard.sample.meta')}</p>
          <div className="ctp-status">
            <span className="ctp-ok">{tr('appearanceCard.sample.passed')}</span>
            <span className="ctp-warn">{tr('appearanceCard.sample.warning')}</span>
            <span className="ctp-err">{tr('appearanceCard.sample.failed')}</span>
          </div>
          <div className="ctp-input">
            <span className="ctp-placeholder">{tr('appearanceCard.sample.message')}</span>
            <span className="ctp-btn">{tr('appearanceCard.sample.send')}</span>
          </div>
        </div>
        <div className="ctp-side">
          <div className="ctp-side-head">{tr('appearanceCard.sample.changes')}</div>
          <div className="ctp-row sel">refunds.ts</div>
          <div className="ctp-row">OrderPage.tsx</div>
          <div className="ctp-row">
            <span className="ctp-link">{tr('appearanceCard.sample.link')}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Making your own theme: four colours and a large preview of it in use. Nothing changes in the app
 * until you press Use this theme, so it stays readable while you try colours. With "Keep text
 * readable" on, text and the accent move just enough lighter or darker to stay easy to read as you
 * change the backgrounds.
 */
function CustomThemeEditor({ start, onUse, onCancel }: { start: CustomTheme; onUse: (c: CustomTheme) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(start)
  const [open, setOpen] = useState<CustomKey | null>('bg')
  const [auto, setAuto] = useState(true)
  const t = customTokens(draft)
  const set = (k: CustomKey, v: string) => {
    let next: CustomTheme = { ...draft, [k]: v }
    if (k === 'bg') {
      next.base = darkBackground(v) ? 'dark' : 'light'
      // The panels follow the background, a shade lighter (dark) or darker (light); set them on their own after.
      next.surface = mix(v, next.base === 'dark' ? '#ffffff' : '#000000', next.base === 'dark' ? 0.04 : 0.035)
    }
    if (auto && k !== 'fg' && k !== 'accent') next = keepReadable(next)
    setDraft(next)
  }
  const from = (tk: ThemeTokens) => setDraft(customFrom(tk))
  const fgRatio = textContrast(draft, draft.fg)
  const accentRatio = textContrast(draft, draft.accent)
  return (
    <div className="ct-editor">
      <div className="ct-start">
        <span className="ct-start-label">{tr('appearanceCard.startFrom')}</span>
        {(['dark', 'light', 'midnight', 'dusk', 'forest', 'ember', 'carbon', 'paper', 'blossom', 'mint'] as const).map((id) => {
          const tk = themeTokens(id)
          return (
            <button key={id} className="ct-start-chip" onClick={() => from(tk)} title={tr(`appearanceCard.themes.${id}`)}>
              <span className="ct-start-dot" style={{ background: tk.bg, boxShadow: `inset 0 0 0 3px ${tk.surface}, 0 0 0 1px ${tk.border}` }}>
                <span style={{ background: tk.accent }} />
              </span>
              {tr(`appearanceCard.themes.${id}`)}
            </button>
          )
        })}
      </div>
      <div className="ct-body">
        <div className="ct-controls">
          {CUSTOM_KEYS.map((k) => (
            <div key={k} className={open === k ? 'ct-item open' : 'ct-item'}>
              <button className="ct-row" aria-expanded={open === k} onClick={() => setOpen(open === k ? null : k)}>
                <span className="ct-chip" style={{ background: draft[k] }} />
                <span className="ct-label">{tr(`appearanceCard.custom.${k}`)}</span>
                {k === 'fg' && <Grade ratio={fgRatio} need={4.5} />}
                {k === 'accent' && <Grade ratio={accentRatio} need={3} />}
                <span className="ct-hex">{draft[k]}</span>
                <Icon name="chevron-down" className="ct-chevron" />
              </button>
              {open === k && (
                <div className="ct-wheel">
                  <ColourWheel lightness value={draft[k]} onChange={(v) => set(k, v)} />
                </div>
              )}
            </div>
          ))}
          <label className="ct-auto">
            <Toggle checked={auto} onChange={(on) => (setAuto(on), on && setDraft(keepReadable(draft)))} />
            <span>
              {tr('appearanceCard.keepReadable')}
              <span className="ct-auto-note">{tr('appearanceCard.keepReadableNote')}</span>
            </span>
          </label>
        </div>
        <ThemePreview t={t} />
      </div>
      <div className="ct-foot">
        {fgRatio < 4.5 && (
          <span className="ct-warn">
            <Icon name="warning" /> {tr('appearanceCard.customHardToRead')}
            <button className="link small" onClick={() => setDraft(keepReadable({ ...draft, fg: draft.base === 'dark' ? mix(draft.bg, '#ffffff', 0.9) : mix(draft.bg, '#000000', 0.86) }))}>
              {tr('appearanceCard.customReadable')}
            </button>
          </span>
        )}
        <span className="spacer" />
        <button className="btn" onClick={onCancel}>{tr('appearanceCard.cancel')}</button>
        <button className="btn primary" onClick={() => onUse(draft)}>{tr('appearanceCard.useTheme')}</button>
      </div>
    </div>
  )
}

/** One setting: what it is (and a line on what it does) on the left, its control on the right. */
function Row({ label, note, children, sub, tokens, stack }: { label: string; note?: string; children: ReactNode; sub?: boolean; tokens?: boolean; stack?: boolean }) {
  return (
    <div className={`set-row${sub ? ' sub' : ''}${stack ? ' stack' : ''}`}>
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
  const shown = useThemeTokens()
  const base = shown.base
  const custom = isHex(a.accent)
  const [wheel, setWheel] = useState(false)
  // Your theme while you make or change it; the app keeps its own until you use it.
  const [editing, setEditing] = useState<CustomTheme | null>(null)
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

  const backgroundOn = (['promptSuggestions', 'agentSummaries', 'nudges', 'autoMap', 'autoTicket', 'autoCommit', 'quickAnswers', 'watchdog', 'prOverview'] as const).filter((k) => auto[k]).length

  const body: Record<SectionId, ReactNode> = {
    appearance: (
      <>
        <Row label={tr('appearanceCard.theme')} stack>
          <div className="theme-cards" role="radiogroup" aria-label={tr('appearanceCard.theme')}>
            {THEME_CHOICES.map((id) => {
              const named = !!THEMES[id]
              // A named theme brings its own accent; going back to Glassbox's own themes brings back yours.
              const pick = () => setAppearance(named ? { theme: id, accent: 'theme' } : { theme: id, accent: a.accent === 'theme' ? DEFAULT_ACCENT : a.accent })
              const own = (t: ThemeTokens) => (named ? t : { ...t, accent: accentFor(a.accent === 'theme' ? { ...a, accent: DEFAULT_ACCENT } : a, t.base) })
              return (
                <button key={id} role="radio" aria-checked={a.theme === id} className={a.theme === id ? 'theme-card on' : 'theme-card'} onClick={pick}>
                  {id === 'system' ? (
                    <span className="theme-thumb-pair">
                      <ThemeThumb t={own(THEMES['glassbox-dark'])} />
                      <ThemeThumb t={own(THEMES['glassbox-light'])} className="half" />
                    </span>
                  ) : (
                    <ThemeThumb t={own(themeTokens(id))} />
                  )}
                  <span className="theme-name">{tr(`appearanceCard.themes.${id}`)}</span>
                </button>
              )
            })}
            <button
              role="radio"
              aria-checked={a.theme === 'custom'}
              className={`theme-card${a.theme === 'custom' ? ' on' : ''}${a.customTheme ? '' : ' new'}`}
              onClick={() => (a.customTheme ? setAppearance({ theme: 'custom', accent: 'theme' }) : setEditing(customFrom(shown)))}
            >
              {a.customTheme ? (
                <ThemeThumb t={customTokens(a.customTheme)} />
              ) : (
                <span className="theme-thumb theme-thumb-new">
                  <Icon name="add" />
                </span>
              )}
              <span className="theme-name">{tr(a.customTheme ? 'appearanceCard.themes.custom' : 'appearanceCard.makeTheme')}</span>
            </button>
          </div>
          {editing ? (
            <CustomThemeEditor
              start={editing}
              onCancel={() => setEditing(null)}
              onUse={(customTheme) => (setAppearance({ customTheme, theme: 'custom', accent: 'theme' }), setEditing(null))}
            />
          ) : (
            a.customTheme && (
              <button className="link small ct-edit" onClick={() => setEditing(a.customTheme ?? null)}>
                <Icon name="edit" /> {tr('appearanceCard.editTheme')}
              </button>
            )
          )}
        </Row>
        <Row label={tr('appearanceCard.accentColour')}>
          <div className="accent-swatches" role="radiogroup" aria-label={tr('appearanceCard.accentColour')}>
            {(THEMES[a.theme] || a.theme === 'custom') && (
              <>
                <button
                  role="radio"
                  aria-checked={a.accent === 'theme'}
                  className={a.accent === 'theme' ? 'accent-swatch on' : 'accent-swatch'}
                  style={{ ['--swatch' as string]: themeTokens(a.theme, undefined, a.customTheme).accent }}
                  title={tr('appearanceCard.themeAccent', { theme: tr(`appearanceCard.themes.${a.theme}`) })}
                  onClick={() => (setAppearance({ accent: 'theme' }), setWheel(false))}
                />
                <span className="accent-sep" aria-hidden />
              </>
            )}
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
        <div className="set-group-label">{tr('settings.groupMotion')}</div>
        <Row label={tr('appearanceCard.backdrop')} note={tr('appearanceCard.backdropNote')} stack>
          <div className="theme-cards" role="radiogroup" aria-label={tr('appearanceCard.backdrop')}>
            {BACKDROPS.map((k) => (
              <button key={k} role="radio" aria-checked={a.backdrop === k} className={a.backdrop === k ? 'theme-card on' : 'theme-card'} onClick={() => setAppearance({ backdrop: k })}>
                <span className="pick-thumb">
                  <Backdrop kind={k} preview />
                </span>
                <span className="theme-name">{tr(`appearanceCard.backdrops.${k}`)}</span>
              </button>
            ))}
          </div>
          {a.backdrop !== 'none' && (
            <div className="set-inline">
              <span className="set-inline-label">{tr('appearanceCard.backdropStrength')}</span>
              <Segmented<string>
                value={String(a.backdropStrength)}
                onChange={(n) => setAppearance({ backdropStrength: Number(n) as 1 | 2 | 3 | 4 })}
                options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: tr(`appearanceCard.strength.${n}`) }))}
              />
              <span className="set-inline-label">{tr('appearanceCard.backdropPanels')}</span>
              <Segmented<PanelFrost>
                value={a.backdropPanels}
                onChange={(backdropPanels) => setAppearance({ backdropPanels })}
                options={(['clear', 'frosted', 'heavy', 'solid'] as const).map((f) => ({ value: f, label: tr(`appearanceCard.frost.${f}`) }))}
              />
            </div>
          )}
        </Row>
        <Row label={tr('appearanceCard.spinner')} note={tr('appearanceCard.spinnerNote')} stack>
          <div className="theme-cards" role="radiogroup" aria-label={tr('appearanceCard.spinner')}>
            {SPINNERS.map((k: Spinner) => (
              <button key={k} role="radio" aria-checked={a.spinner === k} className={a.spinner === k ? 'theme-card on' : 'theme-card'} onClick={() => setAppearance({ spinner: k })}>
                <span className="pick-thumb short">
                  <WorkingMark kind={k} />
                </span>
                <span className="theme-name">{tr(`appearanceCard.spinners.${k}`)}</span>
              </button>
            ))}
          </div>
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
        <Row label={tr('settings.prOverview')} note={tr('settings.prOverviewNote')} tokens>
          <Toggle checked={auto.prOverview} onChange={(prOverview) => set({ prOverview })} />
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
