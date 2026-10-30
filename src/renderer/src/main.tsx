import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './monaco'
import '@vscode/codicons/dist/codicon.css'
import '@fontsource-variable/archivo/wdth.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './styles.css'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { copyButtons } from './lib'

// Platform-specific chrome (macOS traffic lights sit on the left of the title bar).
document.documentElement.dataset.platform = window.glassbox.platform
copyButtons()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary where="app">
      <App />
    </ErrorBoundary>
  </StrictMode>
)
