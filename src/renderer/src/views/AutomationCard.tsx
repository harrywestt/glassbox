import { setAppearance, useAppearance } from '../appearance'
import { Segmented, Toggle } from '../components/ui'
import { tr } from '../../../shared/i18n'
import type { Automation, HoldPolicy } from '../../../shared/events'

/** Settings for what Glassbox does by itself: quick answers, the watchdog, and voice. Saved on this machine. */
export function AutomationCard() {
  const a = useAppearance()
  const auto = a.automation
  const set = (next: Partial<Automation>) => setAppearance({ automation: { ...auto, ...next } })
  return (
    <section className="card appearance">
      <div className="card-title">{tr('automationCard.title')}</div>
      <label className="setting">
        <span className="setting-text">
          <span className="setting-label">{tr('automationCard.quickAnswers')}</span>
          <span className="setting-note">{tr('automationCard.quickAnswersNote')}</span>
        </span>
        <Toggle checked={auto.quickAnswers} onChange={(quickAnswers) => set({ quickAnswers })} />
      </label>
      <div className="setting">
        <span className="setting-text">
          <span className="setting-label">{tr('automationCard.holdEdits')}</span>
          <span className="setting-note">{tr('automationCard.holdEditsNote')}</span>
        </span>
        <Segmented<HoldPolicy>
          value={auto.holdEdits ?? 'ask'}
          onChange={(holdEdits) => set({ holdEdits })}
          options={[
            { value: 'ask', label: tr('live.edit.policy.ask') },
            { value: 'offplan', label: tr('live.edit.policy.offplan') },
            { value: 'all', label: tr('live.edit.policy.all') }
          ]}
        />
      </div>
      <label className="setting">
        <span className="setting-text">
          <span className="setting-label">{tr('automationCard.watchdog')}</span>
          <span className="setting-note">{tr('automationCard.watchdogNote')}</span>
        </span>
        <Toggle checked={auto.watchdog} onChange={(watchdog) => set({ watchdog })} />
      </label>
      {auto.watchdog && (
        <>
          <div className="setting sub">
            <span className="setting-label">{tr('automationCard.nudgeAfter')}</span>
            <Segmented<string> value={String(auto.watchdogNudgeMinutes)} onChange={(v) => set({ watchdogNudgeMinutes: Number(v) })} options={[5, 10, 20, 30].map((n) => ({ value: String(n), label: tr('automationCard.minutes', { n }) }))} />
          </div>
          <div className="setting sub">
            <span className="setting-label">{tr('automationCard.stopAfter')}</span>
            <Segmented<string>
              value={String(auto.watchdogStopMinutes)}
              onChange={(v) => set({ watchdogStopMinutes: Number(v) })}
              options={[...[10, 15, 30].map((n) => ({ value: String(n), label: tr('automationCard.minutes', { n }) })), { value: '0', label: tr('automationCard.never') }]}
            />
          </div>
        </>
      )}
      <label className="setting">
        <span className="setting-text">
          <span className="setting-label">{tr('automationCard.voiceAccurate')}</span>
          <span className="setting-note">{tr('automationCard.voiceAccurateNote')}</span>
        </span>
        <Toggle checked={auto.voiceAccurate} onChange={(voiceAccurate) => set({ voiceAccurate })} />
      </label>
      <label className="setting">
        <span className="setting-text">
          <span className="setting-label">{tr('automationCard.micWarm')}</span>
          <span className="setting-note">{tr('automationCard.micWarmNote')}</span>
        </span>
        <Toggle checked={auto.micWarm} onChange={(micWarm) => set({ micWarm })} />
      </label>
    </section>
  )
}
