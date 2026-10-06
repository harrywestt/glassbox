import { app, shell } from 'electron'
import updater from 'electron-updater'
import type { UpdateState } from '../shared/events'

const { autoUpdater } = updater
const REPO = 'harrywestt/glassbox'
/** How often an installed copy looks for a new version (also when you come back after unlocking). */
const EVERY_MS = 30 * 60_000

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
      autoUpdater.on('update-not-available', () => this.state.status === 'checking' && this.set({ status: 'current', checkedAt: Date.now() }))
      autoUpdater.on('error', () => (this.state.status === 'downloading' || this.state.status === 'checking') && this.set({ status: 'error', checkedAt: Date.now() }))
    }
    void this.check()
    setInterval(() => void this.check(), EVERY_MS).unref()
  }

  async check() {
    if (!app.isPackaged || this.state.status === 'downloading' || this.state.status === 'checking') return
    // Already downloaded one: still look, in case an even newer version is out (it replaces it).
    const was = this.state
    if (was.status !== 'ready') this.set({ status: 'checking' })
    try {
      if (process.platform === 'win32') {
        const r = await autoUpdater.checkForUpdates()
        if (!r?.isUpdateAvailable && this.status() === 'checking') this.set({ status: 'current', checkedAt: Date.now() })
      } else {
        const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
        if (!r.ok) throw new Error(`GitHub answered ${r.status}`)
        const latest = String(((await r.json()) as { tag_name?: string }).tag_name ?? '').replace(/^v/, '')
        if (latest && newer(latest, app.getVersion())) this.set({ status: 'available', version: latest })
        else this.set({ status: 'current', checkedAt: Date.now() })
      }
    } catch {
      // Offline or GitHub unreachable: say so, and try again at the next check.
      if (this.status() === 'checking') this.set(was.status === 'ready' ? was : { status: 'error', checkedAt: Date.now() })
    }
  }

  /** Restart into the downloaded version (Windows), or open the download page (Mac). */
  install() {
    if (this.state.status === 'ready') autoUpdater.quitAndInstall(true, true)
    else if (this.state.status === 'available') void shell.openExternal(`https://github.com/${REPO}/releases/latest`)
  }

  /** The status now (read fresh: it changes while a check is awaited). */
  private status = (): UpdateState['status'] => this.state.status

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
