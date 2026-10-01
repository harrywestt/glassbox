import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './monaco'
import '@vscode/codicons/dist/codicon.css'
import '@fontsource-variable/archivo/wdth.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './styles.css'
import { App } from './App'

// Platform-specific chrome (macOS traffic lights sit on the left of the title bar).
document.documentElement.dataset.platform = window.glassbox.platform

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
