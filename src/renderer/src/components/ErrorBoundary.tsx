import { Component, type ReactNode } from 'react'
import { Icon } from './ui'
import { tr } from '../../../shared/i18n'

type Props = { where: string; children: ReactNode }
type State = { error: Error | null }

/** Sends a renderer error to the log in Glassbox's data folder (logs/renderer.log), for fixing later. */
export function logError(where: string, error: unknown) {
  const e = error instanceof Error ? error : new Error(String(error))
  void window.glassbox.logError(where, `${e.message}\n${e.stack ?? ''}`).catch(() => undefined)
}

/**
 * One panel or view that hits an error says so and offers to reload itself, while the rest of
 * Glassbox carries on (an uncaught error used to blank the whole window).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    logError(this.props.where, Object.assign(error, { stack: `${error.stack ?? ''}\n${info.componentStack ?? ''}` }))
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="panel-error" role="alert">
        <Icon name="warning" className="warn" />
        <strong>{tr('errorBoundary.title')}</strong>
        <span className="muted small">{tr('errorBoundary.body')}</span>
        <code className="panel-error-detail">{error.message}</code>
        <button className="btn" onClick={() => this.setState({ error: null })}>
          <Icon name="refresh" /> {tr('errorBoundary.reload')}
        </button>
      </div>
    )
  }
}
