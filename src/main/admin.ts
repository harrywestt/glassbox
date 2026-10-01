import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Running Glassbox as administrator (Windows): everything it starts (Claude's sessions, their shell
 * commands, services) inherits the elevation. It's a saved preference applied at launch, through
 * the normal Windows UAC prompt.
 */
const settingsPath = () => join(app.getPath('userData'), 'glassbox-settings.json')

type Settings = { runAsAdmin?: boolean; adminAsked?: boolean }

function load(): Settings {
  try {
    return existsSync(settingsPath()) ? JSON.parse(readFileSync(settingsPath(), 'utf8')) : {}
  } catch {
    return {}
  }
}

function save(s: Settings) {
  writeFileSync(settingsPath(), JSON.stringify({ ...load(), ...s }, null, 2))
}

let elevatedCache: boolean | undefined

/** True if this process has administrator rights. */
export function isElevated(): boolean {
  if (process.platform !== 'win32') return process.getuid?.() === 0
  if (elevatedCache === undefined) {
    try {
      // Only succeeds from an elevated process.
      execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true })
      elevatedCache = true
    } catch {
      elevatedCache = false
    }
  }
  return elevatedCache
}

let adminAccountCache: boolean | undefined

/**
 * True if your Windows account is itself an administrator (in the Administrators group, even when
 * UAC is filtering it). A standard account elevates by switching to another account, which would run
 * Claude signed out, so Glassbox only elevates the whole app for admin accounts.
 */
export function isAdminAccount(): boolean {
  if (process.platform !== 'win32') return true
  if (adminAccountCache === undefined) {
    try {
      adminAccountCache = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), ['/groups'], { encoding: 'utf8', windowsHide: true }).includes('S-1-5-32-544')
    } catch {
      adminAccountCache = false
    }
  }
  return adminAccountCache
}

export type AdminState = { supported: boolean; elevated: boolean; runAsAdmin: boolean; asked: boolean; adminAccount: boolean }

export function adminState(): AdminState {
  const s = load()
  return { supported: process.platform === 'win32' && app.isPackaged, elevated: isElevated(), runAsAdmin: !!s.runAsAdmin, asked: !!s.adminAsked, adminAccount: isAdminAccount() }
}

/** Relaunches with the UAC prompt. Resolves false if you cancel the prompt (this instance keeps running). */
function relaunchElevated(): Promise<boolean> {
  const exe = process.execPath.replace(/'/g, "''")
  return new Promise((done) =>
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${exe}' -Verb RunAs`], { windowsHide: true }, (err) => done(!err))
  )
}

/** Relaunches without elevation: Explorer starts programs at the normal level. */
function relaunchNormal(): Promise<boolean> {
  return new Promise((done) => execFile('explorer.exe', [process.execPath], { windowsHide: true }, () => done(true)))
}

/**
 * At startup: if you've asked for admin and this instance isn't elevated, relaunch elevated.
 * Returns true when this instance should quit (the elevated one has taken over).
 */
export async function elevateAtStartupIfWanted(): Promise<boolean> {
  const s = adminState()
  if (!s.supported || !s.runAsAdmin || s.elevated || !s.adminAccount) return false
  return relaunchElevated()
}

/** Saves the preference and restarts Glassbox at the matching level. Returns false if UAC was cancelled. */
export async function setRunAsAdmin(on: boolean): Promise<boolean> {
  const s = adminState()
  if (!s.supported) throw new Error('Running as administrator is only available in the installed app on Windows.')
  if (on && !s.adminAccount) throw new Error('Your Windows account isn’t an administrator, so Glassbox can’t run elevated as you. Claude asks for administrator rights per command instead.')
  if (on === s.elevated) {
    save({ runAsAdmin: on, adminAsked: true })
    return true
  }
  // Saved first, so the new instance reads the new preference.
  save({ runAsAdmin: on, adminAsked: true })
  const ok = on ? await relaunchElevated() : await relaunchNormal()
  if (!ok) {
    save({ runAsAdmin: s.runAsAdmin })
    return false
  }
  setTimeout(() => app.quit(), 300)
  return true
}

/** Remembers that you've answered the first-run question (without changing anything). */
export function dismissAdminPrompt() {
  save({ adminAsked: true })
}
