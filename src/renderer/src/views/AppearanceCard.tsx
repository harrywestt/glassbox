import { ACCENTS, CHAT_SIZES, UI_SCALES, resetAppearance, setAppearance, useAppearance, type ChatWidth, type TableStyle, type ThemePreference } from '../appearance'
import { useThemeTokens } from '../App'
import { Segmented, Toggle } from '../components/ui'

/** Dashboard settings: notifications, the away summary, theme, accent colour, text sizes and conversation width. Saved on this machine. */
export function AppearanceCard() {
  const a = useAppearance()
  const base = useThemeTokens().base

  return (
    <section className="card appearance">
      <div className="card-title">
        Settings
        <span className="spacer" />
        <button className="link small" onClick={resetAppearance}>Reset to defaults</button>
      </div>

      <label className="setting">
        <span className="setting-label">Desktop notifications</span>
        <Toggle checked={a.notifications} onChange={(notifications) => setAppearance({ notifications })} />
      </label>

      <label className="setting">
        <span className="setting-label">“While you were away” summary</span>
        <Toggle checked={a.awayDigest} onChange={(awayDigest) => setAppearance({ awayDigest })} />
      </label>

      <div className="setting">
        <span className="setting-label">Theme</span>
        <Segmented<ThemePreference>
          value={a.theme}
          onChange={(theme) => setAppearance({ theme })}
          options={[
            { value: 'system', label: 'Match Windows' },
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' }
          ]}
        />
      </div>

      <div className="setting">
        <span className="setting-label">Accent colour</span>
        <div className="accent-swatches" role="radiogroup" aria-label="Accent colour">
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
        <span className="setting-label">Conversation text</span>
        <Segmented<string>
          value={String(a.chatSize)}
          onChange={(v) => setAppearance({ chatSize: Number(v) })}
          options={CHAT_SIZES.map((n) => ({ value: String(n), label: `${n}px` }))}
        />
      </div>

      <div className="setting">
        <span className="setting-label">Interface size</span>
        <Segmented<string>
          value={String(a.uiScale)}
          onChange={(v) => setAppearance({ uiScale: Number(v) })}
          options={UI_SCALES.map((n) => ({ value: String(n), label: `${Math.round(n * 100)}%` }))}
        />
      </div>

      <div className="setting">
        <span className="setting-label">Conversation width</span>
        <Segmented<ChatWidth>
          value={a.chatWidth}
          onChange={(chatWidth) => setAppearance({ chatWidth })}
          options={[
            { value: 'full', label: 'Full width' },
            { value: 'wide', label: 'Wide' },
            { value: 'comfortable', label: 'Narrow' }
          ]}
        />
      </div>

      <div className="setting">
        <span className="setting-label">Tables</span>
        <Segmented<TableStyle>
          value={a.tableStyle}
          onChange={(tableStyle) => setAppearance({ tableStyle })}
          options={[
            { value: 'striped', label: 'Striped' },
            { value: 'grid', label: 'Grid' },
            { value: 'minimal', label: 'Minimal' }
          ]}
        />
      </div>

      <div className="appearance-preview markdown" style={{ fontSize: a.chatSize }}>
        <p>
          Claude’s replies look like this, with <strong>bold text standing out</strong> and <code>inline code</code>.
        </p>
        <table>
          <thead>
            <tr><th>File</th><th>Change</th><th>Lines</th></tr>
          </thead>
          <tbody>
            <tr><td>api.js</td><td>Added JSDoc</td><td>+12</td></tr>
            <tr><td>shipping.js</td><td>New module</td><td>+8</td></tr>
            <tr><td>api.test.js</td><td>New tests</td><td>+24</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  )
}
