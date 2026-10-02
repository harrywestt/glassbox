import { useSession } from '../views/SessionView'
import type { AccessMode } from '../../../shared/events'
import { Select } from '../components/Select'
import { tr } from '../../../shared/i18n'

const KEY = 'glassbox.access'

/** The access mode new sessions start in. Full access unless you've chosen otherwise. */
export function loadAccess(): AccessMode {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'default' || v === 'acceptEdits' || v === 'bypassPermissions') return v
  } catch {
    /* storage unavailable: use the default */
  }
  return 'bypassPermissions'
}

function saveAccess(mode: AccessMode) {
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    /* not remembered this time */
  }
}

const MODES: { value: AccessMode; label: string; hint: string }[] = [
  { value: 'default', label: tr('accessToggle.askFirst'), hint: tr('accessToggle.askFirstHint') },
  { value: 'acceptEdits', label: tr('accessToggle.autoEdit'), hint: tr('accessToggle.autoEditHint') },
  { value: 'bypassPermissions', label: tr('accessToggle.fullAccess'), hint: tr('accessToggle.fullAccessHint') }
]

/** How much Claude may do without asking, for this session and as the default for new ones. */
export function AccessToggle() {
  const { tab, s } = useSession()
  const current = (s.access ?? loadAccess()) as AccessMode
  const live = s.status !== 'new' && s.status !== 'stopped'

  return (
    <Select<AccessMode>
      className={`access access-${current}`}
      aria-label={tr('accessToggle.permissions')}
      title={tr('accessToggle.title', { hint: MODES.find((m) => m.value === current)?.hint })}
      value={current}
      options={MODES}
      disabled={!live}
      onChange={(mode) => {
        saveAccess(mode)
        void window.glassbox.session.setMode(tab.id, mode)
      }}
    />
  )
}
