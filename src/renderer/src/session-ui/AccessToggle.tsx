import { useSession } from '../views/SessionView'
import type { AccessMode } from '../../../shared/events'
import { Select } from '../components/Select'

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
  { value: 'default', label: 'Ask first', hint: 'Ask before running commands and editing files' },
  { value: 'acceptEdits', label: 'Auto-edit', hint: 'Edit files without asking; ask before commands' },
  { value: 'bypassPermissions', label: 'Full access', hint: 'Never ask. Guardrails still block or check dangerous actions' }
]

/** How much Claude may do without asking, for this session and as the default for new ones. */
export function AccessToggle() {
  const { tab, s } = useSession()
  const current = (s.access ?? loadAccess()) as AccessMode
  const live = s.status !== 'new' && s.status !== 'stopped'

  return (
    <Select<AccessMode>
      className={`access access-${current}`}
      aria-label="Permissions"
      title={`${MODES.find((m) => m.value === current)?.hint}. New sessions start in the mode you pick.`}
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
