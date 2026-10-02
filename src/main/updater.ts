import { app, shell } from 'electron'
import updater from 'electron-updater'
import type { UpdateState } from '../shared/events'

const { autoUpdater } = updater
const REPO = 'harrywestt/glassbox'
const EVERY_MS = 4 * 60 * 60_000

/**
 * Keeps an installed Glassbox up to date from the GitHub releases. On Windows a new version
 * downloads in the background and installs when you restart (or next time you quit). The Mac build
 * isn't signed with an Apple certificate, so it can't replace itself: you're told a version is out
 * and the button opens its download page.
 */
export class Updater {
  state: UpdateState = { status: 'idle' }

  constructor(private emit: (s: UpdateState) => void) {}

  start() {
    // Only an installed copy updates: not `npm run dev`, nor a folder build copied into place.
    if (!app.isPackaged) return
    if (process.platform === 'win32') {
      autoUpdater.autoDownload = true
      autoUpdater.autoInstallOnAppQuit = true
      autoUpdater.on('update-available', (i) => this.set({ status: 'downloading', version: i.version, percent: 0 }))
      autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', version: 'version' in this.state ? this.state.version : '', percent: Math.round(p.percent) }))
      autoUpdater.on('update-downloaded', (i) => this.set({ status: 'ready', version: i.version }))
      autoUpdater.on('error', () => this.state.status === 'downloading' && this.set({ status: 'idle' }))
    }
    void this.check()
    setInterval(() => void this.check(), EVERY_MS).unref()
  }

  async check() {
    if (!app.isPackaged || this.state.status === 'ready' || this.state.status === 'downloading') return
    try {
      if (process.platform === 'win32') await autoUpdater.checkForUpdates()
      else {
        const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
        if (!r.ok) return
        const latest = String(((await r.json()) as { tag_name?: string }).tag_name ?? '').replace(/^v/, '')
        if (latest && newer(latest, app.getVersion())) this.set({ status: 'available', version: latest })
      }
    } catch {
      // Offline or GitHub unreachable: try again at the next check.
    }
  }

  /** Restart into the downloaded version (Windows), or open the download page (Mac). */
  install() {
    if (this.state.status === 'ready') autoUpdater.quitAndInstall(true, true)
    else if (this.state.status === 'available') void shell.openExternal(`https://github.com/${REPO}/releases/latest`)
  }

  private set(s: UpdateState) {
    this.state = s
    this.emit(s)
  }
}

const newer = (a: string, b: string) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}
