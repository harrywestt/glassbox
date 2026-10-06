import { blockedOnYou } from '../session'
import { clock } from '../live/model'
import { useEffect, useState, type Dispatch } from 'react'
import type { UpdateState } from '../../../shared/events'
import { useActions } from '../App'
import { DASHBOARD, tabTitle, type AppAction, type AppState } from '../tabs'
import type { ThemePreference } from '../theme'
import { Icon } from './ui'
import { useScrollStrip } from './useScrollStrip'
import { liveVerb, tallyOf } from '../tally'
import { Logo } from './Logo'
import { tr } from '../../../shared/i18n'

type Props = { state: AppState; dispatch: Dispatch<AppAction>; themePref: ThemePreference; themeBase: 'dark' | 'light'; onToggleTheme: () => void }

export function TitleBar({ state, dispatch, themePref, themeBase, onToggleTheme }: Props) {
  const actions = useActions()
  const strip = useScrollStrip<HTMLDivElement>(state.active)
  const [dragId, setDragId] = useState<string | null>(null)

  // The mark's lamp is the whole gallery's tally: anyone waiting on you first, then anyone working.
  const tallies = state.tabs.map((t) => tallyOf(state.sessions[t.id]))
  const overall = tallies.includes('wait') ? 'wait' : tallies.includes('live') ? 'live' : tallies.includes('ok') ? 'ok' : 'idle'

  const newTab = () => actions.showLauncher((state.tabs.find((t) => t.id === state.active) ?? state.tabs.at(-1))?.cwd)

  return (
    <header className="titlebar">
      {/* The mark and the word Dashboard are one control: click it to go home. */}
      <button
        className={state.active === DASHBOARD ? 'brand-home active' : 'brand-home'}
        aria-current={state.active === DASHBOARD ? 'page' : undefined}
        onClick={() => dispatch({ type: 'activate', id: DASHBOARD })}
        title={tr('titleBar.dashboardTip')}
      >
        <Logo size={20} state={overall} />
        <span>{tr('titleBar.dashboard')}</span>
      </button>
      <div className="tabstrip" role="tablist" ref={strip}>
        {state.tabs.map((tab, index) => {
          const s = state.sessions[tab.id]
          const tally = tallyOf(s)
          const verb = liveVerb(s)
          // Claude is stopped on you: the tab says so, with how long it's been waiting.
          const yours = !!s && blockedOnYou(s)
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={state.active === tab.id}
              className={`tab monitor tally-${tally}${yours ? ' your-turn' : ''}${state.active === tab.id ? ' active' : ''}${dragId === tab.id ? ' dragging' : ''}`}
              draggable
              onDragStart={() => setDragId(tab.id)}
              onDragEnd={() => setDragId(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => dragId && dispatch({ type: 'move', id: dragId, to: index })}
              onClick={() => dispatch({ type: 'activate', id: tab.id })}
              onAuxClick={(e) => e.button === 1 && actions.closeTab(tab.id)}
              title={`${tabTitle(tab, s)}\n${tab.cwd}`}
            >
              <span className="tally-lamp" aria-hidden />
              <span className="tab-text">
                <span className="tab-label">{tabTitle(tab, s)}</span>
                <span className="tab-verb">{yours ? <YourTurn since={s.waitSince} /> : verb}</span>
              </span>
              <button
                className="tab-close"
                title={tr('titleBar.closeTip')}
                onClick={(e) => {
                  e.stopPropagation()
                  actions.closeTab(tab.id)
                }}
              >
                <Icon name="close" />
              </button>
            </div>
          )
        })}
      </div>
      {/* Outside the strip, so it stays in reach however many tabs are open. */}
      <button className="tab-new" title={tr('titleBar.newSessionTip')} onClick={newTab}>
        <Icon name="add" />
      </button>
      <div className="titlebar-drag" />
      <UpdateButton />
      <button className="icon-btn titlebar-btn" title={themeBase === 'dark' ? (themePref === 'system' ? tr('titleBar.switchToLightSystem') : tr('titleBar.switchToLight')) : themePref === 'system' ? tr('titleBar.switchToDarkSystem') : tr('titleBar.switchToDark')} onClick={onToggleTheme}>
        <Icon name={themeBase === 'dark' ? 'sun' : 'moon'} />
      </button>
      <div className="window-controls-space" />
    </header>
  )
}

/** "Your turn, 2:14": ticks while Claude waits on you. */
function YourTurn({ since }: { since?: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return <>{tr('titleBar.yourTurn', { time: clock(now - (since ?? now)) })}</>
}

/** A newer Glassbox, VS Code style: it downloads quietly and installs when you close the app; this just says so, and can restart now. */
function UpdateButton() {
  const [u, setU] = useState<UpdateState>({ status: 'idle' })
  useEffect(() => {
    void window.glassbox.update.state().then(setU)
    return window.glassbox.update.onChange(setU)
  }, [])
  // Downloading shows quietly with its progress; there's a button once it's ready.
  if (u.status === 'downloading')
    return (
      <span className="update-chip" title={tr('titleBar.downloadingTitle', { version: u.version })}>
        <Icon name="cloud-download" /> {u.percent}%
      </span>
    )
  if (u.status !== 'ready' && u.status !== 'available') return null
  const ready = u.status === 'ready'
  return (
    <button
      className="update-chip ready"
      onClick={() => void window.glassbox.update.install()}
      title={ready ? tr('titleBar.updateReadyTip', { version: u.version }) : tr('titleBar.updateAvailableTip', { version: u.version })}
    >
      <Icon name={ready ? 'check' : 'cloud-download'} /> {ready ? tr('titleBar.updateReady') : tr('titleBar.getVersion', { version: u.version })}
    </button>
  )
}
