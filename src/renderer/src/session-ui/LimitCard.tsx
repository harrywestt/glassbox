import { useSession } from '../views/SessionView'
import { Icon } from '../components/ui'
import { tr } from '../../../shared/i18n'

/** Today: the time. Another day: the day and time. */
const time = (ms: number) => {
  const d = new Date(ms)
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

/** A usage limit stopped Claude: when it resets, and a way to have Glassbox carry on then by itself. */
export function LimitCard() {
  const { tab, s } = useSession()
  const hit = s.limitHit
  if (!hit) return null
  const waiting = !!hit.continueAt
  return (
    <div className="limit-card" role="status">
      <Icon name={waiting ? 'watch' : 'warning'} className={waiting ? 'accent' : 'warn'} />
      <span className="grow">
        <strong>{tr('limitCard.title')}</strong>{' '}
        {waiting
          ? tr('limitCard.waiting', { at: time(hit.continueAt!) })
          : hit.resetsAt
            ? tr('limitCard.resets', { at: time(hit.resetsAt), window: hit.type ?? '' })
            : tr('limitCard.noTime')}
      </span>
      {hit.resetsAt && (
        <button className={waiting ? 'btn quiet' : 'btn primary'} onClick={() => void window.glassbox.session.continueAfterReset(tab.id, !waiting)}>
          {waiting ? tr('limitCard.cancel') : tr('limitCard.continue')}
        </button>
      )}
    </div>
  )
}
