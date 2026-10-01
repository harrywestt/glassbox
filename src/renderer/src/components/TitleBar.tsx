import { useState, type Dispatch } from 'react'
import { useActions } from '../App'
import { DASHBOARD, tabTitle, type AppAction, type AppState } from '../tabs'
import type { ThemePreference } from '../theme'
import { Icon } from './ui'
import { liveVerb, tallyOf } from '../tally'
import { Logo } from './Logo'

type Props = { state: AppState; dispatch: Dispatch<AppAction>; themePref: ThemePreference; themeBase: 'dark' | 'light'; onToggleTheme: () => void }

export function TitleBar({ state, dispatch, themePref, themeBase, onToggleTheme }: Props) {
  const actions = useActions()
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
        title="Dashboard (Ctrl+T)"
      >
        <Logo size={20} state={overall} />
        <span>Dashboard</span>
      </button>
      <div className="tabstrip" role="tablist">
        {state.tabs.map((tab, index) => {
          const s = state.sessions[tab.id]
          const tally = tallyOf(s)
          const verb = liveVerb(s)
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={state.active === tab.id}
              className={`tab monitor tally-${tally}${state.active === tab.id ? ' active' : ''}${dragId === tab.id ? ' dragging' : ''}`}
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
                <span className="tab-verb">{verb}</span>
              </span>
              <button
                className="tab-close"
                title="Close (Ctrl+W)"
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
        <button className="tab-new" title="New session (Ctrl+T)" onClick={newTab}>
          <Icon name="add" />
        </button>
      </div>
      <div className="titlebar-drag" />
      <button className="icon-btn titlebar-btn" title={`Switch to ${themeBase === 'dark' ? 'light' : 'dark'} mode${themePref === 'system' ? ' (currently following the system)' : ''}`} onClick={onToggleTheme}>
        <Icon name={themeBase === 'dark' ? 'sun' : 'moon'} />
      </button>
      <div className="window-controls-space" />
    </header>
  )
}
