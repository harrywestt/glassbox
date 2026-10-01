import type { PermissionDecision } from '../../../shared/events'
import type { PermissionRequest } from '../session'
import { useSession } from '../views/SessionView'
import { Icon } from '../components/ui'
import { toolIcon, toolLabel } from './Timeline'

export function PermissionDialog({ request, queued }: { request: PermissionRequest; queued: number }) {
  const { tab } = useSession()
  const respond = (decision: PermissionDecision, message?: string) => window.glassbox.session.respondPermission(tab.id, request.id, decision, message)

  const { input } = request
  const guard = request.guard

  return (
    <div className="overlay">
      <div className="dialog" onKeyDown={(e) => e.key === 'Escape' && respond('deny')}>
        <div className="dialog-title">
          <Icon name={toolIcon(request.toolName)} />
          <span>
            Claude wants to use <strong>{toolLabel(request.toolName)}</strong>
          </span>
        </div>
        {guard && (
          <div className="callout callout-warn">
            <Icon name="shield" /> Your guardrail “{guard}” asked for approval.
          </div>
        )}
        {typeof input.description === 'string' && <div className="muted">{input.description}</div>}
        {typeof input.command === 'string' && <pre className="command">{input.command}</pre>}
        {typeof input.file_path === 'string' && <div className="mono muted small">{input.file_path}</div>}
        {typeof input.old_string === 'string' && typeof input.new_string === 'string' ? (
          <div className="mini-diff">
            <pre className="del">{input.old_string}</pre>
            <pre className="add">{input.new_string}</pre>
          </div>
        ) : typeof input.command !== 'string' ? (
          <pre className="json">{JSON.stringify(input, null, 2)}</pre>
        ) : null}
        <div className="dialog-actions">
          {queued > 0 && <span className="muted small">{queued} more waiting</span>}
          <span className="spacer" />
          <button className="danger" onClick={() => respond('deny')}>Deny</button>
          {/* Shell commands one by one get tiring: allow them all for this session (guardrails still stop risky ones). */}
          {!guard && (request.toolName === 'Bash' || request.toolName === 'PowerShell') ? (
            <button onClick={() => respond('shell')} title="Claude runs shell commands without asking for the rest of this session. Your guardrails still stop or ask about risky ones.">
              Allow shell for this session
            </button>
          ) : (
            request.canAlwaysAllow && !guard && <button onClick={() => respond('always')}>Always allow</button>
          )}
          <button className="primary" autoFocus onClick={() => respond('allow')}>Allow</button>
        </div>
      </div>
    </div>
  )
}
