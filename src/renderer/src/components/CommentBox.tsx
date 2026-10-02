import { useState } from 'react'
import type { CommentTarget } from '../session'
import { targetLabel } from '../review'
import { useSession } from '../views/SessionView'
import { Icon } from './ui'
import { tr } from '../../../shared/i18n'

/**
 * Inline review comment. Sent straight into the session with priority "now", so Claude reads it
 * mid-turn instead of after it finishes.
 */
export function CommentBox({ target, onDone, placeholder }: { target: CommentTarget; onDone: () => void; placeholder?: string }) {
  const { tab, s, actions } = useSession()
  const [text, setText] = useState('')
  const canSend = s.status === 'ready' || s.status === 'running'

  const send = () => {
    if (!text.trim() || !canSend) return
    void actions.comment(tab.id, target, text)
    onDone()
  }

  return (
    <div className="comment-box" onClick={(e) => e.stopPropagation()}>
      <div className="comment-about small muted">
        <Icon name="comment" /> {targetLabel(target)}
      </div>
      <textarea
        autoFocus
        rows={2}
        value={text}
        placeholder={placeholder ?? (s.status === 'running' ? tr('commentBox.placeholderRunning') : tr('commentBox.placeholder'))}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send()
          if (e.key === 'Escape') onDone()
        }}
      />
      <div className="comment-actions">
        <span className="muted small">{tr('commentBox.sendHint')}</span>
        <span className="spacer" />
        <button onClick={onDone}>{tr('commentBox.cancel')}</button>
        <button className="primary" disabled={!text.trim() || !canSend} onClick={send}>
          {tr('commentBox.send')}
        </button>
      </div>
    </div>
  )
}
