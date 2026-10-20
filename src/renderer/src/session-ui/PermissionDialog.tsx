import { useState } from 'react'
import type { PermissionDecision } from '../../../shared/events'
import type { PermissionRequest } from '../session'
import { useSession } from '../views/SessionView'
import { Icon } from '../components/ui'
import { toolIcon, toolLabel } from './Timeline'
import { tr } from '../../../shared/i18n'

export function PermissionDialog({ request, queued }: { request: PermissionRequest; queued: number }) {
  const { tab } = useSession()
  const respond = (decision: PermissionDecision, message?: string) => window.glassbox.session.respondPermission(tab.id, request.id, decision, message)

  const { input } = request
  const guard = request.guard

  return (
    <div className="overlay">
      <div className="dialog permission-dialog" onKeyDown={(e) => e.key === 'Escape' && respond('deny')}>
        <div className="dialog-title">
          <Icon name={toolIcon(request.toolName)} />
          <span>
            {tr('permissionDialog.wantsToUse')} <strong>{toolLabel(request.toolName)}</strong>
          </span>
        </div>
        <div className="permission-body">
        {guard && (
          <div className="callout callout-warn">
            <Icon name="shield" /> {tr('permissionDialog.guardrailAsked', { guard })}
          </div>
        )}
        {typeof input.description === 'string' && <div className="muted">{input.description}</div>}
        {typeof input.command === 'string' && <Long text={input.command} className="command" />}
        {typeof input.file_path === 'string' && <div className="mono muted small">{input.file_path}</div>}
        {typeof input.old_string === 'string' && typeof input.new_string === 'string' ? (
          <div className="mini-diff">
            <Long text={input.old_string} className="del" />
            <Long text={input.new_string} className="add" />
          </div>
        ) : typeof input.command !== 'string' ? (
          <Long text={JSON.stringify(input, null, 2)} className="json" />
        ) : null}
        </div>
        <div className="dialog-actions">
          {queued > 0 && <span className="muted small">{tr('permissionDialog.moreWaiting', { n: queued })}</span>}
          <span className="spacer" />
          <button className="danger" onClick={() => respond('deny')}>{tr('permissionDialog.deny')}</button>
          {/* Shell commands one by one get tiring: allow them all for this session (guardrails still stop risky ones). */}
          {!guard && (request.toolName === 'Bash' || request.toolName === 'PowerShell') ? (
            <button onClick={() => respond('shell')} title={tr('permissionDialog.allowShellHint')}>
              {tr('permissionDialog.allowShell')}
            </button>
          ) : (
            request.canAlwaysAllow && !guard && <button onClick={() => respond('always')}>{tr('permissionDialog.alwaysAllow')}</button>
          )}
          <button className="primary" autoFocus onClick={() => respond('allow')}>{tr('permissionDialog.allow')}</button>
        </div>
      </div>
    </div>
  )
}

/**
 * A command (or edit) in full, never cut off: it wraps, and a long one shows its first lines with
 * a row to open the rest, so you can read every line before you allow it.
 */
function Long({ text, className }: { text: string; className: string }) {
  const lines = text.split('\n')
  const long = lines.length > 10 || text.length > 900
  const [open, setOpen] = useState(false)
  const shown = long && !open ? lines.slice(0, 8).join('\n').slice(0, 700) : text
  return (
    <div className={long ? `long-text${open ? ' open' : ''}` : 'long-text'}>
      <pre className={className}>{shown}</pre>
      {long && (
        <button className="long-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'chevron-up' : 'chevron-down'} />
          {open ? tr('permissionDialog.showLess') : tr('permissionDialog.showAll', { count: lines.length, chars: text.length.toLocaleString() })}
        </button>
      )}
    </div>
  )
}
