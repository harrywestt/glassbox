import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './monaco'
import '@vscode/codicons/dist/codicon.css'
import '@fontsource-variable/archivo/wdth.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './styles.css'
import { App } from './App'
import { LivePopout } from './live/LivePopout'

// Platform-specific chrome (macOS traffic lights sit on the left of the title bar).
document.documentElement.dataset.platform = window.glassbox.platform

const LIVE_TAB = /^#live=(.+)$/.exec(location.hash)?.[1] ? decodeURIComponent(/^#live=(.+)$/.exec(location.hash)![1]) : null

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* A popped-out Live window loads the same page with #live=<session tab>. */}
    {LIVE_TAB ? <LivePopout tabId={LIVE_TAB} /> : <App />}
  </StrictMode>
)
