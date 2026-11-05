import { useState } from 'react'
import { useSession } from '../views/SessionView'
import { Icon, Toggle } from './ui'
import { tr } from '../../../shared/i18n'

/** Whether "Research first" was on last time (it starts off: research spends more of the conversation's tokens). */
const RESEARCH_KEY = 'glassbox.researchFirst'
const loadResearch = () => {
  try {
    return localStorage.getItem(RESEARCH_KEY) === '1'
  } catch {
    return false
  }
}

/** What Claude is asked to do: design it as a sketch, after looking at good examples when research is on. */
export function designPrompt(brief: string, research: boolean): string {
  const ask = `Design this as a sketch (show_sketch) that fits the app as it is now: its colours, type, spacing and existing components (copies are in the component library: list_components; otherwise read the app's own screens and styles), following the patterns it already uses. Change the look only where the request below explicitly asks for a different style. The request: ${brief.trim()}`
  if (!research) return ask
  // Research is for layout and ideas; the app's own look stays (unless the request says otherwise).
  return `${ask}

Research first, for layout and ideas only. Find 4 to 6 strong, recent examples of this kind of screen on Dribbble (https://dribbble.com/search/ plus a few words) and, where useful, Mobbin, Behance or Land-book. Open them in the Glassbox Browser with browser_open (it has the user's sign-ins, and these sites block plain fetching, so don't use WebFetch or curl for them) and take a browser_screenshot of each one worth keeping. Show the best 3 to the user as one sketch titled "References: <topic>" (show_sketch, each as an <img> of its saved screenshot file with a one-line caption and its link). Then say in a few bullets what is worth borrowing (how the content is arranged, grouped and prioritised, the flow, useful interactions) and what to avoid. Take only those ideas: the design itself stays in the app's current style and design patterns, not the references' colours, fonts or decoration, unless the request asks for a new look.`
}

/** Asking Claude to design something, with "Research first" to look at good examples before it starts. */
export function DesignAsk({ placeholder }: { placeholder?: string }) {
  const { s, send } = useSession()
  const [brief, setBrief] = useState('')
  const [research, setResearch] = useState(loadResearch)
  const canSend = !!brief.trim() && s.status !== 'stopped'
  const go = () => {
    if (!canSend) return
    void send(designPrompt(brief, research))
    setBrief('')
  }
  return (
    <div className="design-ask">
      <textarea
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && (e.preventDefault(), go())}
        placeholder={placeholder ?? tr('designAsk.placeholder')}
        aria-label={tr('designAsk.label')}
        rows={2}
      />
      <div className="design-ask-row">
        <label className="design-ask-research" title={tr('designAsk.researchTip')}>
          <Toggle
            checked={research}
            onChange={(on) => {
              setResearch(on)
              try {
                localStorage.setItem(RESEARCH_KEY, on ? '1' : '0')
              } catch {
                /* this run only */
              }
            }}
          />
          <span>
            {tr('designAsk.research')} <span className="muted small">{tr('designAsk.researchNote')}</span>
          </span>
        </label>
        <span className="grow" />
        <button className="primary" disabled={!canSend} onClick={go} title={tr('designAsk.sendTip')}>
          <Icon name="sparkle" /> {tr(research ? 'designAsk.sendResearch' : 'designAsk.send')}
        </button>
      </div>
    </div>
  )
}
