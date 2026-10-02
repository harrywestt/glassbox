import { ACCENTS, CHAT_SIZES, UI_SCALES, resetAppearance, setAppearance, useAppearance, type ChatWidth, type TableStyle, type ThemePreference } from '../appearance'
import { useThemeTokens } from '../App'
import { Segmented, Toggle } from '../components/ui'
import { tr } from '../../../shared/i18n'

/** Dashboard settings: notifications, the away summary, theme, accent colour, text sizes and conversation width. Saved on this machine. */
export function AppearanceCard() {
  const a = useAppearance()
  const base = useThemeTokens().base

  return (
    <section className="card appearance">
      <div className="card-title">
        {tr('appearanceCard.settings')}
        <span className="spacer" />
        <button className="link small" onClick={resetAppearance}>{tr('appearanceCard.resetToDefaults')}</button>
      </div>

      <label className="setting">
        <span className="setting-label">{tr('appearanceCard.desktopNotifications')}</span>
        <Toggle checked={a.notifications} onChange={(notifications) => setAppearance({ notifications })} />
      </label>

      <label className="setting">
        <span className="setting-label">{tr('appearanceCard.awayDigest')}</span>
        <Toggle checked={a.awayDigest} onChange={(awayDigest) => setAppearance({ awayDigest })} />
      </label>

      <div className="setting">
        <span className="setting-label">{tr('appearanceCard.theme')}</span>
        <Segmented<ThemePreference>
          value={a.theme}
          onChange={(theme) => setAppearance({ theme })}
          options={[
            { value: 'system', label: tr('appearanceCard.themeSystem') },
            { value: 'dark', label: tr('appearanceCard.themeDark') },
            { value: 'light', label: tr('appearanceCard.themeLight') }
          ]}
        />
      </div>

      <div className="setting">
        <span className="setting-label">{tr('appearanceCard.accentColour')}</span>
        <div className="accent-swatches" role="radiogroup" aria-label={tr('appearanceCard.accentColour')}>
          {ACCENTS.map((c) => (
            <button
              key={c.id}
              role="radio"
              aria-checked={a.accent === c.id}
              className={a.accent === c.id ? 'accent-swatch on' : 'accent-swatch'}
              style={{ ['--swatch' as string]: c[base] }}
              title={c.label}
              onClick={() => setAppearance({ accent: c.id })}
            />
          ))}
        </div>
      </div>

      <div className="setting">
        <span className="setting-label">{tr('appearanceCard.conversationText')}</span>
        <Segmented<string>
          value={String(a.chatSize)}
          onChange={(v) => setAppearance({ chatSize: Number(v) })}
          options={CHAT_SIZES.map((n) => ({ value: String(n), label: tr('appearanceCard.pixels', { n }) }))}
        />
      </div>

      <div className="setting">
        <span className="setting-label">{tr('appearanceCard.interfaceSize')}</span>
        <Segmented<string>
          value={String(a.uiScale)}
          onChange={(v) => setAppearance({ uiScale: Number(v) })}
          options={UI_SCALES.map((n) => ({ value: String(n), label: tr('appearanceCard.percent', { n: Math.round(n * 100) }) }))}
        />
      </div>

      <div className="setting">
        <span className="setting-label">{tr('appearanceCard.conversationWidth')}</span>
        <Segmented<ChatWidth>
          value={a.chatWidth}
          onChange={(chatWidth) => setAppearance({ chatWidth })}
          options={[
            { value: 'full', label: tr('appearanceCard.widthFull') },
            { value: 'wide', label: tr('appearanceCard.widthWide') },
            { value: 'comfortable', label: tr('appearanceCard.widthNarrow') }
          ]}
        />
      </div>

      <div className="setting">
        <span className="setting-label">{tr('appearanceCard.tables')}</span>
        <Segmented<TableStyle>
          value={a.tableStyle}
          onChange={(tableStyle) => setAppearance({ tableStyle })}
          options={[
            { value: 'striped', label: tr('appearanceCard.tableStriped') },
            { value: 'grid', label: tr('appearanceCard.tableGrid') },
            { value: 'minimal', label: tr('appearanceCard.tableMinimal') }
          ]}
        />
      </div>

      <div className="appearance-preview markdown" style={{ fontSize: a.chatSize }}>
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
    </section>
  )
}
