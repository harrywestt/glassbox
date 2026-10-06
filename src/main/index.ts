import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, Notification, protocol, shell } from 'electron'
import { Updater } from './updater'
import { setAutomation } from './automation'
import type { Automation } from '../shared/events'
import { abortAllQueries } from './claude'
import { askMap, type MapAskModule } from './mapAsk'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { listSessions, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import { adoptLoginShellPath } from './shellPath'
import { groupSessionMap, type HeatModule } from './mapGroups'
import { runBang, stopBang, stopAllBangs } from './bang'
import { pinSession, pinnedSessions, refreshPinned, restorePinned, unpinSession } from './pinned'
import { AgentHost } from './agentHost'
import { listProjectFiles, readProjectFile } from './files'
import { gitBranches, gitDiff, gitFileAt, gitBranchList, gitSwitch, gitLog, gitCommitFiles, gitShowFile, gitWorktree, gitFetchDefault, gitInfo } from './git'
import { glassboxCommits, undoGlassboxCommit } from './autocommit'
import { showcaseDir, showcasePrompt, skillDeckDir, type ShowcaseRequest } from './showcase'
import { UsageService } from './usage'
import { getGitHubSummary } from './github'
import { createPrWorktree, getBranchPr, getPr, listOpenPrs } from './launcher'
import { findDependents } from './deps'
import { getArchitecture, onArchitectureChanged, refreshArchitecture } from './architecture'
import { getAccounts, signIn } from './accounts'
import { getStandup } from './standup'
import { architectureDiff } from './archDiff'
import { focusErd, getErd } from './erd'
import { closeTerminal, closeTerminals, openTerminal, resizeTerminal, writeTerminal } from './terminal'
import type { BrowserBridge } from './browserTools'
import { forgetDecision, listDecisions } from './projectDecisions'
import { explainModule } from './mapExplain'
import { attachContextMenu, setMacMenu } from './contextMenu'
import { StatusTray, type TrayState } from './tray'
import { WatchServer } from './watch'
import { getRates } from './fx'
import { ServiceRegistry } from './services'
import { prepareVoice, transcribe } from './voice'
import { handoffMessage } from './handoff'
import { commentOnTicket, getTicket, getTransitions, transitionTicket } from './jira'
import { checkDependencies } from './radar'
import { undoEdit } from './undo'
import { adminState, dismissAdminPrompt, elevateAtStartupIfWanted, setRunAsAdmin } from './admin'
import type { AccessMode, DiffMode, GuardRule, SideTaskSpec, PermissionDecision, Requirements, ReviewModel, SendOptions, ServicesEvent, SessionEvent, TabEvent } from '../shared/events'
import { tr } from '../shared/i18n'

// Development builds keep their own profile (settings, tabs, rates), so running from source never
// touches the installed app's data.
if (!app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'Glassbox Dev'))
// Testing a packaged build without touching the real profile: GLASSBOX_PROFILE_DIR=<folder>.
if (process.env.GLASSBOX_PROFILE_DIR) app.setPath('userData', process.env.GLASSBOX_PROFILE_DIR)
// macOS: opened from the Finder, the app doesn't get your shell's PATH (git, gh, Homebrew).
adoptLoginShellPath()

protocol.registerSchemesAsPrivileged([
  { scheme: 'showcase', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // media://file/<encoded absolute path>: images, video and audio from disk, shown in file tabs
  // and inline in the conversation (streamed, so video can seek).
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

const MEDIA_FILE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|mp4|webm|mov|m4v|mp3|wav|ogg|m4a|flac|pdf)$/i
const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  pdf: 'application/pdf'
}

let win: BrowserWindow | null = null
/** One pixel shorter than the 40px header, so its bottom divider runs under the native buttons too. */
const TITLEBAR_OVERLAY_H = 39
/** Colours for the native minimise/maximise/close buttons, kept in step with the theme's header. */
let titleBar = { color: '#121418', symbolColor: '#d8dce4' }
const hosts = new Map<string, AgentHost>()
const usage = new UsageService()

// Dev aid: snapshot runs keep painting while other windows cover this one (Windows otherwise pauses
// a covered window, and capturePage hands back an old frame).
if (process.env.GLASSBOX_SNAPSHOTS) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
const toRenderer = (channel: string, payload: unknown) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}
const send = (payload: TabEvent) => toRenderer('glassbox:event', payload)
const updates = new Updater((s) => toRenderer('glassbox:update', s))
const services = new ServiceRegistry((e: ServicesEvent) => {
  toRenderer('glassbox:services', e)
  // Errors also land in the session's conversation, next to what Claude just changed.
  if (e.kind === 'error') send({ tabId: e.scope, event: { kind: 'service-error', service: e.name, text: e.text, at: e.at } })
})
const watch = new WatchServer()
let tray: StatusTray | undefined
const trayStates = new Map<string, { title: string; state: TrayState }>()

/** Keep the tray's per-session state in step with what each session is doing. */
/**
 * Background agents still working, per session: the SDK's level signal (the whole set, resent on
 * every change). Only agents count; a dev server left running in the background isn't "work".
 */
const backgroundAgents = new Map<string, number>()
const turnOver = new Set<string>()
function backgroundCount(event: SessionEvent): number | undefined {
  if (event.kind !== 'sdk' || event.msg.type !== 'system') return undefined
  const m = event.msg as { subtype?: string; tasks?: { task_type?: string; ambient?: boolean }[] }
  if (m.subtype !== 'background_tasks_changed' || !Array.isArray(m.tasks)) return undefined
  return m.tasks.filter((t) => t.task_type === 'local_agent' && !t.ambient).length
}

function trackTray(tabId: string, cwd: string, event: SessionEvent) {
  const prev = trayStates.get(tabId)?.state ?? 'idle'
  let next: TrayState = prev
  const bg = backgroundCount(event)
  if (bg !== undefined) {
    backgroundAgents.set(tabId, bg)
    // The last background agent finished after Claude's turn ended: now it really is waiting for you.
    if (bg === 0 && turnOver.has(tabId) && prev === 'working') next = 'waiting'
    else if (bg > 0 && prev === 'waiting') next = 'working'
  }
  if (event.kind === 'status' && event.status === 'running') turnOver.delete(tabId)
  if (event.kind === 'sdk' && event.msg.type === 'result') turnOver.add(tabId)
  const busyBehind = (backgroundAgents.get(tabId) ?? 0) > 0
  if (event.kind === 'permission' || event.kind === 'checkin' || event.kind === 'user-questions') next = 'needs-you'
  else if (event.kind === 'permission-cancelled' || event.kind === 'checkin-resolved' || event.kind === 'user-questions-done') next = 'working'
  else if (event.kind === 'status') next = event.status === 'running' ? 'working' : event.status === 'ready' ? (prev === 'error' ? 'error' : busyBehind ? 'working' : 'waiting') : event.status === 'stopped' ? 'idle' : prev
  else if (event.kind === 'sdk' && event.msg.type === 'result') next = event.msg.is_error ? 'error' : busyBehind ? 'working' : 'waiting'
  else if (event.kind === 'error') next = 'error'
  if (next === prev && trayStates.has(tabId)) return
  trayStates.set(tabId, { title: basename(cwd), state: next })
  tray?.update([...trayStates].map(([id, v]) => ({ tabId: id, ...v })))
}

/** Off unless the user turns them on (dashboard Settings); the renderer tells us at startup. */
let notificationsOn = false
ipcMain.handle('settings:automation', (_e, next: Partial<Automation>) => setAutomation(next))
ipcMain.handle('settings:notifications', (_e, on: boolean) => {
  notificationsOn = !!on
})

/** Desktop notifications for things that need you, shown only while Glassbox isn't focused. */
/** Ongoing alerts already notified, by tab and alert id, until they clear. */
const alerted = new Set<string>()

function notifyFor(tabId: string, cwd: string, event: SessionEvent) {
  if (event.kind === 'alert-clear') return void alerted.delete(`${tabId}:${event.id}`)
  if (!notificationsOn || !win || win.isDestroyed() || win.isFocused()) return
  let body: string | undefined
  if (event.kind === 'user-questions') body = event.questions.length > 1 ? tr('mainIndex.notify.questions', { count: event.questions.length }) : tr('mainIndex.notify.asks', { question: event.questions[0]?.question ?? tr('mainIndex.notify.aQuestion') })
  else if (event.kind === 'permission') body = event.toolName === 'ExitPlanMode' ? tr('mainIndex.notify.planReady') : tr('mainIndex.notify.wantsTool', { tool: event.toolName })
  else if (event.kind === 'checkin') body = tr('mainIndex.notify.checkingIn', { about: event.checkin.about })
  // An ongoing alert ("stuck") notifies once, not each time it updates.
  else if (event.kind === 'alert') body = event.id && alerted.has(`${tabId}:${event.id}`) ? undefined : (event.id && alerted.add(`${tabId}:${event.id}`), event.text)
  else if (event.kind === 'guard' && event.hit.action === 'block') body = tr('mainIndex.notify.blocked', { label: event.hit.label })
  else if (event.kind === 'sdk' && event.msg.type === 'result') body = event.msg.is_error ? tr('mainIndex.notify.stoppedWithError') : (backgroundAgents.get(tabId) ?? 0) > 0 ? undefined : tr('mainIndex.notify.finished')
  // Runs before trackTray, so the map still holds the count from before this change.
  else if (backgroundCount(event) === 0 && turnOver.has(tabId) && (backgroundAgents.get(tabId) ?? 0) > 0) body = tr('mainIndex.notify.backgroundFinished')
  else if (event.kind === 'error') body = event.message
  if (!body) return
  if (event.kind === 'permission' || event.kind === 'user-questions') win.flashFrame(true)
  // The Glassbox name and icon come from the toast header (see registerShortcut); the title names the project.
  const n = new Notification({ title: basename(cwd), body, icon: APP_ICON(), silent: event.kind === 'sdk' })
  n.on('click', () => {
    win?.show()
    win?.focus()
    toRenderer('glassbox:focusTab', tabId)
  })
  n.show()
}

function host(tabId: string): AgentHost {
  const h = hosts.get(tabId)
  if (!h) throw new Error(`No session for tab ${tabId}`)
  return h
}

const isMac = process.platform === 'darwin'

function createWindow() {
  win = new BrowserWindow({
    width: 1680,
    height: 1040,
    minWidth: 960,
    minHeight: 600,
    title: app.isPackaged ? 'Glassbox' : 'Glassbox (dev)',
    // Windows takes the taskbar and window icon from an .ico; other platforms use the PNG.
    icon: join(import.meta.dirname, '../../resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#16181d',
    titleBarStyle: 'hidden',
    // Windows: our own title bar with the native buttons drawn over it, in the header colour (the
    // renderer re-applies it for the active theme). macOS: the traffic lights, centred in the bar.
    ...(isMac ? { trafficLightPosition: { x: 14, y: 13 } } : { titleBarOverlay: { color: titleBar.color, symbolColor: titleBar.symbolColor, height: TITLEBAR_OVERLAY_H } }),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      // The App preview is a <webview>: a real browsing context, so apps that refuse to be framed
      // or sign in through another site (Auth0) work, with first-party cookies.
      webviewTag: true,
      // Chromium's PDF viewer, so documents Claude makes or you attach open inside Glassbox.
      plugins: true
    }
  })
  win.on('closed', () => (win = null))
  // Every preview gets a locked-down guest: no Node, no Glassbox preload, its own saved profile.
  win.webContents.on('will-attach-webview', (_e, prefs, params) => {
    delete prefs.preload
    prefs.nodeIntegration = false
    prefs.contextIsolation = true
    prefs.sandbox = true
    // Pages keep running (timers, animation frames, so apps like React start) while the Browser
    // isn't the tab you're on, or Glassbox is minimised: Claude tests them in the background.
    prefs.backgroundThrottling = false
    params.partition = 'persist:preview'
  })
  // The taskbar button's icon, set explicitly (from the versioned copy) rather than left to
  // Windows' icon cache, which keeps showing an old icon after an update.
  if (process.platform === 'win32' && app.isPackaged) {
    const icon = taskbarIcon()
    win.setIcon(icon)
    win.setAppDetails({ appId: APP_ID, appIconPath: icon, appIconIndex: 0, relaunchCommand: `"${process.execPath}"`, relaunchDisplayName: 'Glassbox' })
  }
  attachContextMenu(win)
  // Keep the window title (and its "(dev)" marker) rather than the page's <title>.
  win.on('page-title-updated', (e) => e.preventDefault())
  win.on('focus', () => {
    win?.flashFrame(false)
    if (!isMac) win?.setTitleBarOverlay({ ...titleBar, height: TITLEBAR_OVERLAY_H })
  })
  // Links in chat and showcases open in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault()
      void shell.openExternal(url)
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  if (process.env.GLASSBOX_SNAPSHOTS) void captureSnapshots(win, process.env.GLASSBOX_SNAPSHOTS)
}

/**
 * Dev aid: GLASSBOX_SNAPSHOTS=<json file> holds [{ wait, script?, out }] steps; each runs `script`
 * in the renderer, waits `wait` ms, and saves a PNG to `out`. The app quits after the last step.
 */
async function captureSnapshots(w: BrowserWindow, file: string) {
  const steps = JSON.parse(readFileSync(file, 'utf8')) as { wait: number; script?: string; out: string }[]
  await new Promise<void>((r) => w.webContents.once('did-finish-load', () => r()))
  for (const step of steps) {
    if (step.script) {
      const r = await w.webContents.executeJavaScript(`(() => { try { ${step.script}
; return 'ok' } catch (e) { return 'ERR ' + (e && e.stack || e) } })()`).catch((e) => String(e))
      if (r !== 'ok') console.error('snapshot script failed', step.out, r)
    }
    await new Promise((r) => setTimeout(r, step.wait))
    // Dev aid: report what each embedded frame shows (screenshots can miss cross-site frames).
    if (process.env.GLASSBOX_SNAPSHOT_FRAMES)
      for (const f of w.webContents.mainFrame.framesInSubtree)
        if (f !== w.webContents.mainFrame) console.log('FRAME', f.url, JSON.stringify(await f.executeJavaScript('document.body ? document.body.innerText.slice(0, 200) : "(no body)"').catch((e) => String(e))))
    // Force a fresh frame: an unfocused window can otherwise hand back the previous one.
    w.webContents.setBackgroundThrottling(false)
    w.webContents.invalidate()
    await new Promise((r) => setTimeout(r, 250))
    // capturePage can fail transiently (GPU process restarts); retry rather than stall the run.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        writeFileSync(step.out, (await w.webContents.capturePage()).toPNG())
        break
      } catch (e) {
        console.error('snapshot capture failed, retrying', e)
        await new Promise((r) => setTimeout(r, 800))
      }
    }
  }
  app.quit()
}

// The Browser's tabs live in the window; Claude's browser tools ask it to open one (and list them),
// then drive the page directly.
const browserReplies = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let browserSeq = 1
ipcMain.on('browser:reply', (_e, reqId: string, result: unknown, error?: string) => {
  const r = browserReplies.get(reqId)
  if (!r) return
  browserReplies.delete(reqId)
  if (error) r.reject(new Error(error))
  else r.resolve(result)
})
function browserRequest<T>(tabId: string, cmd: Record<string, unknown>, ms = 20000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!win || win.isDestroyed()) return reject(new Error('Glassbox has no window open.'))
    const reqId = `r${browserSeq++}`
    const timer = setTimeout(() => (browserReplies.delete(reqId), reject(new Error('The Browser didn’t answer in time.'))), ms)
    browserReplies.set(reqId, { resolve: (v) => (clearTimeout(timer), resolve(v as T)), reject: (e) => (clearTimeout(timer), reject(e)) })
    win.webContents.send('glassbox:browser-request', { reqId, tabId, cmd })
  })
}
const browserFor = (tabId: string): { bridge: BrowserBridge; shotsDir: string } => ({
  bridge: {
    open: (url, newTab) => browserRequest(tabId, { cmd: 'open', url, newTab }),
    tabs: () => browserRequest(tabId, { cmd: 'tabs' }, 5000)
  },
  shotsDir: join(app.getPath('userData'), 'browser-shots')
})

// Sessions
ipcMain.handle('session:open', (_e, tabId: string, cwd: string, resume?: string, access?: AccessMode) => {
  hosts.get(tabId)?.close()
  // A pinned session Claude Code has since cleared comes back from its backup first.
  if (resume) {
    try {
      restorePinned(resume)
    } catch {
      /* opens as far as it can */
    }
  }
  const h = new AgentHost(
    cwd,
    (event) => {
      send({ tabId, event })
      notifyFor(tabId, cwd, event)
      watch.publish(tabId, event)
      trackTray(tabId, cwd, event)
      // Keep pinned sessions' backups current as they're used.
      if (event.kind === 'sdk' && event.msg.type === 'result') setTimeout(() => {
        try {
          refreshPinned([])
        } catch {
          /* next time */
        }
      }, 1000)
    },
    () => services.get(tabId, cwd),
    browserFor(tabId),
    // The other live sessions in this same working tree.
    () => [...hosts].filter(([id, x]) => id !== tabId && !!x.root() && x.root()!.toLowerCase() === h.root()?.toLowerCase()).map(([, x]) => x)
  )
  hosts.set(tabId, h)
  void h.open(resume, access)
  // A new session redraws its project's map in the background; resuming keeps the cached one.
  if (!resume) void refreshArchitecture(cwd)
})
ipcMain.handle('session:send', (_e, tabId: string, text: string, opts: SendOptions) => host(tabId).send(text, opts))
// "! command" from the message box: you run it yourself; output streams back to that session.
ipcMain.handle('bang:run', (_e, tabId: string, id: string, cwd: string, command: string) => runBang(id, cwd, command, (b) => send({ tabId, event: { kind: 'bang', id, ...b } })))
ipcMain.handle('bang:stop', (_e, id: string) => stopBang(id))
ipcMain.handle('session:rewind', (_e, tabId: string, userMessageId: string, dryRun: boolean) => host(tabId).rewind(userMessageId, dryRun))
ipcMain.handle('session:checkin', (_e, tabId: string, id: string, answer: string) => host(tabId).respondCheckin(id, answer))
ipcMain.handle('session:autoCommit', (_e, tabId: string, on: boolean) => host(tabId).setAutoCommit(on))
ipcMain.handle('session:commitNow', (_e, tabId: string) => host(tabId).commitNow())
ipcMain.handle('session:review', (_e, tabId: string, model: ReviewModel) => host(tabId).review(model))
ipcMain.handle('launch:prs', (_e, cwd: string) => listOpenPrs(cwd))
ipcMain.handle('git:branchPr', (_e, cwd: string) => getBranchPr(cwd))
ipcMain.handle('launch:pr', (_e, cwd: string, ref: string) => getPr(cwd, ref))
ipcMain.handle('launch:worktree', (_e, cwd: string, pr: number) => createPrWorktree(cwd, pr))
ipcMain.handle('session:guardrails', (_e, tabId: string, rules: GuardRule[]) => host(tabId).setGuardrails(rules))
ipcMain.handle('session:setMode', (_e, tabId: string, mode: AccessMode) => host(tabId).setMode(mode))
ipcMain.handle('session:side', (_e, tabId: string, spec: SideTaskSpec) => host(tabId).runSide(spec))
ipcMain.handle('session:stopSide', (_e, tabId: string, id: string) => host(tabId).stopSide(id))
ipcMain.handle('session:sideShowcase', (_e, tabId: string, req: ShowcaseRequest, context: string) =>
  host(tabId).runSide({ kind: 'showcase', title: tr('mainIndex.buildShowcase'), prompt: `${showcasePrompt(req)}\n\n## What happened in the main session\n${context}`, tools: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'Artifact', 'Skill'] })
)
ipcMain.handle('session:exitPlan', (_e, tabId: string) => host(tabId).exitPlan())
ipcMain.handle('app:version', () => app.getVersion())
ipcMain.handle('update:state', () => updates.state)
ipcMain.handle('update:install', () => updates.install())
ipcMain.handle('session:interrupt', (_e, tabId: string) => host(tabId).interrupt())
ipcMain.handle('session:continueAfterReset', (_e, tabId: string, on: boolean) => host(tabId).continueAfterReset(on))
ipcMain.handle('session:setModel', (_e, tabId: string, model: string) => host(tabId).setModel(model))
ipcMain.handle('session:stopTask', (_e, tabId: string, taskId: string) => host(tabId).stopTask(taskId))
ipcMain.handle('session:close', (_e, tabId: string) => {
  closeTerminals(tabId)
  hosts.get(tabId)?.close()
  hosts.delete(tabId)
  services.disposeScope(tabId)
  trayStates.delete(tabId)
  tray?.update([...trayStates].map(([id, v]) => ({ tabId: id, ...v })))
  watch.forget(tabId)
})
ipcMain.handle('watch:share', (_e, tabId: string, title: string, cwd: string) => watch.share(tabId, title, cwd))
ipcMain.handle('watch:unshare', (_e, tabId: string) => watch.unshare(tabId))
ipcMain.handle('deps:find', (_e, cwd: string, files: string[]) => findDependents(cwd, files))
onArchitectureChanged((root) => toRenderer('glassbox:architecture', root))
ipcMain.handle('architecture:explain', (_e, cwd: string, id: string) => explainModule(cwd, id))
// The map's "This conversation" view, grouped by Claude from the session's heatmap.
ipcMain.handle('architecture:ask', (_e, root: string, question: string, mods: MapAskModule[], force?: boolean) => askMap(root, question, mods, force))
ipcMain.handle('architecture:group', (_e, root: string, mods: HeatModule[], force?: boolean) => groupSessionMap(root, mods, force))
ipcMain.handle('architecture:get', (_e, cwd: string, force?: boolean) => getArchitecture(cwd, force))
ipcMain.handle('architecture:diff', (_e, cwd: string, ref: string, mode: DiffMode, apiOnly?: string[]) => architectureDiff(cwd, ref, mode, apiOnly))
ipcMain.handle('decisions:list', (_e, cwd: string) => listDecisions(cwd))
ipcMain.handle('erd:get', (_e, cwd: string) => getErd(cwd))
ipcMain.handle('terminal:open', (_e, scope: string, cwd: string, cols: number, rows: number) => openTerminal(scope, cwd, cols, rows, toRenderer))
ipcMain.on('terminal:write', (_e, id: string, data: string) => writeTerminal(id, data))
ipcMain.on('terminal:resize', (_e, id: string, cols: number, rows: number) => resizeTerminal(id, cols, rows))
ipcMain.handle('terminal:close', (_e, id: string) => closeTerminal(id))
ipcMain.handle('erd:focus', (_e, cwd: string, question: string) => focusErd(cwd, question))
ipcMain.handle('decisions:forget', (_e, cwd: string, id: string) => forgetDecision(cwd, id))
ipcMain.handle('accounts:get', (_e, force?: boolean) => getAccounts(force))
ipcMain.handle('accounts:signIn', (_e, id: string) => signIn(id))
ipcMain.handle('standup:get', (_e, force?: boolean) => getStandup(app.getPath('userData'), force))
ipcMain.handle('session:permission', (_e, tabId: string, id: string, decision: PermissionDecision, message?: string) =>
  host(tabId).respondPermission(id, decision, message)
)
ipcMain.handle('session:answerQuestions', (_e, tabId: string, id: string, answers: Record<string, string> | null) => host(tabId).answerQuestions(id, answers))
ipcMain.handle('session:refresh', async (_e, tabId: string) => {
  const h = host(tabId)
  await Promise.all([h.refreshContext(), h.refreshMcp(), h.refreshGit()])
})
ipcMain.handle('session:toggleMcp', (_e, tabId: string, name: string, enabled: boolean) => host(tabId).toggleMcp(name, enabled))
ipcMain.handle('session:requirements', (_e, tabId: string, req: Requirements) => host(tabId).setRequirements(req))
ipcMain.handle('session:showcase', (_e, tabId: string, req: ShowcaseRequest, opts: SendOptions) => host(tabId).send(showcasePrompt(req), opts))

// History, usage
// Past sessions, newest first. Pinned ones are marked, kept up to date in their backup, and listed
// even once Claude Code has cleared them or they've fallen past the limit.
ipcMain.handle('history:list', async () => {
  const live = await listSessions({ limit: 300 })
  try {
    refreshPinned(live)
  } catch {
    /* the list still shows */
  }
  const pinned = pinnedSessions()
  const ids = new Set(pinned.map((p) => p.sessionId))
  const seen = new Set(live.map((s) => s.sessionId))
  const kept = pinned.filter((p) => !seen.has(p.sessionId)).map(({ pinnedAt: _p, transcript: _t, ...info }) => info)
  return [...live, ...kept].map((s) => (ids.has(s.sessionId) ? { ...s, pinned: true } : s))
})
ipcMain.handle('history:pin', (_e, info: SDKSessionInfo) => pinSession(info))
ipcMain.handle('history:unpin', (_e, id: string) => unpinSession(id))
ipcMain.handle('history:pinnedIds', () => pinnedSessions().map((p) => p.sessionId))
ipcMain.handle('usage:get', () => usage.snapshot())
// The dashboard loads these separately, so each card fills in as soon as its own part is ready.
ipcMain.handle('usage:limits', () => usage.limits())
ipcMain.handle('usage:local', () => usage.local())
ipcMain.handle('fx:rates', () => getRates())
ipcMain.handle('admin:get', () => adminState())
ipcMain.handle('admin:set', (_e, on: boolean) => setRunAsAdmin(on))
ipcMain.handle('admin:dismiss', () => dismissAdminPrompt())
ipcMain.handle('edit:undo', (_e, cwd: string, tool: string, input: Record<string, unknown>, createdFile: boolean) => undoEdit(cwd, tool, input, createdFile))
ipcMain.handle('radar:deps', (_e, deps: { name: string; version: string; ecosystem: string }[]) => checkDependencies(deps))
ipcMain.handle('share:handoff', (_e, cwd: string, brief: string) => handoffMessage(cwd, brief))
ipcMain.handle('ticket:get', (_e, cwd: string, key: string, force?: boolean) => getTicket(cwd, key, force))
ipcMain.handle('ticket:transitions', (_e, cwd: string, key: string) => getTransitions(cwd, key))
ipcMain.handle('ticket:transition', (_e, cwd: string, key: string, id: string) => transitionTicket(cwd, key, id))
ipcMain.handle('ticket:comment', (_e, cwd: string, key: string, body: string) => commentOnTicket(cwd, key, body))

// Voice input
const voiceProgress = (p: unknown) => toRenderer('glassbox:voice', p)
ipcMain.handle('voice:prepare', async () => void (await prepareVoice(voiceProgress)))
ipcMain.handle('voice:transcribe', (_e, audio: Float32Array, live?: boolean) => transcribe(audio, voiceProgress, live))
ipcMain.handle('github:summary', (_e, dirs: string[], force?: boolean) => getGitHubSummary(dirs, { force }))

// Files and git
ipcMain.handle('fs:list', (_e, cwd: string) => listProjectFiles(cwd))
ipcMain.handle('fs:read', (_e, cwd: string, path: string) => readProjectFile(cwd, path))
ipcMain.handle('git:branches', (_e, cwd: string) => gitBranches(cwd))
ipcMain.handle('git:log', (_e, cwd: string, base: string | null) => gitLog(cwd, base))
ipcMain.handle('git:commitFiles', (_e, cwd: string, sha: string) => gitCommitFiles(cwd, sha))
ipcMain.handle('git:showFile', (_e, cwd: string, ref: string, path: string) => gitShowFile(cwd, ref, path))
ipcMain.handle('git:glassboxCommits', () => glassboxCommits())
ipcMain.handle('git:undoCommit', (_e, cwd: string, sha: string) => undoGlassboxCommit(cwd, sha))
ipcMain.handle('git:branchList', (_e, cwd: string) => gitBranchList(cwd))
ipcMain.handle('git:switch', (_e, cwd: string, branch: string, create?: boolean) => gitSwitch(cwd, branch, create))
// How many other live sessions work in the same repo folder as `cwd` (before starting another there).
ipcMain.handle('session:peers', async (_e, cwd: string, except?: string) => {
  const root = (await gitInfo(cwd).catch(() => null))?.root?.replace(/\\/g, '/').toLowerCase()
  if (!root) return 0
  return [...hosts].filter(([id, x]) => id !== except && x.root()?.toLowerCase() === root).length
})
ipcMain.handle('git:worktree', (_e, cwd: string, branch: string) => gitWorktree(cwd, branch))
ipcMain.handle('git:fetchDefault', (_e, cwd: string) => gitFetchDefault(cwd))
ipcMain.handle('git:diff', (_e, cwd: string, ref: string, mode: DiffMode) => gitDiff(cwd, ref, mode))
ipcMain.handle('git:fileAt', (_e, cwd: string, ref: string, mode: DiffMode, path: string) => gitFileAt(cwd, ref, mode, path))

// Project services (.glassbox/services.json)
// Scoped per session (the tab id), so each session runs its own copy on its own ports.
ipcMain.handle('services:get', (_e, scope: string, cwd: string) => services.get(scope, cwd).snapshot())
ipcMain.handle('services:logs', (_e, scope: string, cwd: string, name: string) => services.get(scope, cwd).logs(name))
ipcMain.handle('services:startAll', (_e, scope: string, cwd: string) => services.get(scope, cwd).startAll())
ipcMain.handle('services:stopAll', (_e, scope: string, cwd: string) => services.get(scope, cwd).stopAll())
ipcMain.handle('services:start', (_e, scope: string, cwd: string, name: string) => services.get(scope, cwd).start(name))
ipcMain.handle('services:stop', (_e, scope: string, cwd: string, name: string) => services.get(scope, cwd).stop(name))
ipcMain.handle('services:restart', (_e, scope: string, cwd: string, name: string) => services.get(scope, cwd).restart(name))

// Shell and window
ipcMain.handle('dialog:pickFolder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return result.canceled ? null : result.filePaths[0]
})
ipcMain.handle('shell:openPath', (_e, path: string) => shell.openPath(path))
ipcMain.handle('shell:showItem', (_e, path: string) => shell.showItemInFolder(path))
// Attachments: files you pick, and pasted images (which have no file yet) saved to Glassbox's folder.
ipcMain.handle('attachments:pick', async () => {
  const r = win ? await dialog.showOpenDialog(win, { title: tr('mainIndex.attachFiles'), properties: ['openFile', 'multiSelections'] }) : { canceled: true, filePaths: [] }
  return r.canceled ? [] : r.filePaths
})
ipcMain.handle('attachments:save', (_e, name: string, data: ArrayBuffer) => {
  const dir = join(app.getPath('userData'), 'attachments', new Date().toISOString().slice(0, 10))
  mkdirSync(dir, { recursive: true })
  const safe = basename(name).replace(/[^\w.\- ]+/g, '_') || 'pasted'
  const ext = extname(safe)
  let file = join(dir, safe)
  for (let i = 2; existsSync(file); i++) file = join(dir, `${safe.slice(0, safe.length - ext.length)} (${i})${ext}`)
  writeFileSync(file, Buffer.from(data))
  return file
})
// A command's full output, when it was too big to hand Claude whole: Claude Code saves it under
// ~/.claude/projects/<project>/tool-results/ and passes on a preview. Only files there are read.
const TOOL_OUTPUT_MAX = 8 * 1024 * 1024
ipcMain.handle('tool:fullOutput', (_e, path: string): { text?: string; size?: number; error?: string } => {
  const full = resolve(path)
  const root = resolve(homedir(), '.claude', 'projects') + sep
  if (!full.toLowerCase().startsWith(root.toLowerCase()) || !full.toLowerCase().includes(`${sep}tool-results${sep}`)) return { error: tr('mainIndex.notSavedToolOutput') }
  try {
    const size = statSync(full).size
    const text = readFileSync(full, 'utf8')
    return { text: text.length > TOOL_OUTPUT_MAX ? text.slice(0, TOOL_OUTPUT_MAX) : text, size }
  } catch {
    return { error: tr('mainIndex.savedOutputGone') }
  }
})
ipcMain.handle('fs:stat', (_e, path: string) => {
  try {
    const st = statSync(path)
    return { exists: true, size: st.size, modified: st.mtimeMs, dir: st.isDirectory() }
  } catch {
    return { exists: false }
  }
})
ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))
// Errors from the app's own pages, kept in its data folder (logs/renderer.log, trimmed to its last 1 MB).
ipcMain.handle('log:error', (_e, where: string, text: string) => {
  const dir = join(app.getPath('userData'), 'logs')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'renderer.log')
  const line = `[${new Date().toISOString()}] v${app.getVersion()} ${where}: ${String(text).slice(0, 8000)}\n`
  const old = existsSync(file) ? readFileSync(file, 'utf8') : ''
  writeFileSync(file, (old.length > 1_000_000 ? old.slice(-500_000) : old) + line)
})
ipcMain.handle('window:titleBar', (_e, color: string, symbolColor: string) => {
  titleBar = { color, symbolColor }
  if (!isMac) win?.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_OVERLAY_H })
})

// A separate ID for source builds, so Windows doesn't group them with the installed app (or borrow its shortcut).
const APP_ID = app.isPackaged ? 'com.harrywest.glassbox.desktop' : 'com.harrywest.glassbox.dev'
const ICON_PATH = join(import.meta.dirname, '../../resources/icon.png')
const APP_ICON = () => nativeImage.createFromPath(ICON_PATH)

// Groups the taskbar button and ties notifications to Glassbox.
app.setAppUserModelId(APP_ID)

/**
 * Windows takes a notification's header (app name and icon) from a Start menu shortcut carrying the
 * same AppUserModelID. Keep that shortcut pointing at this install so toasts are branded.
 */
function registerShortcut() {
  if (process.platform !== 'win32' || !app.isPackaged) return
  // Only the installed copy (the installer leaves its uninstaller beside it), never a build folder
  // run for testing: that would point your Start menu and taskbar at the test build.
  if (!existsSync(join(dirname(process.execPath), 'Uninstall Glassbox.exe'))) return
  const icon = taskbarIcon()
  const lnk = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Glassbox.lnk')
  shell.writeShortcutLink(lnk, existsSync(lnk) ? 'replace' : 'create', {
    target: process.execPath,
    cwd: dirname(process.execPath),
    appUserModelId: APP_ID,
    icon,
    iconIndex: 0,
    description: tr('mainIndex.shortcutDescription')
  })
  // A taskbar pin keeps its own copy of the icon; point it at the same versioned file.
  const pinned = join(app.getPath('appData'), 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', 'Glassbox.lnk')
  if (existsSync(pinned)) shell.writeShortcutLink(pinned, 'update', { target: process.execPath, cwd: dirname(process.execPath), appUserModelId: APP_ID, icon, iconIndex: 0 })
}

/**
 * Windows caches taskbar icons by file path and never notices when the file changes, so a new icon
 * keeps showing the old one. The icon is copied to a path named after its contents: a changed icon
 * gets a new path, which Windows has to read fresh.
 */
function taskbarIcon(): string {
  const src = join(import.meta.dirname, '../../resources/icon.ico')
  try {
    const data = readFileSync(src)
    const dir = join(app.getPath('userData'), 'icons')
    const dest = join(dir, `glassbox-${createHash('sha1').update(data).digest('hex').slice(0, 10)}.ico`)
    if (!existsSync(dest)) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(dest, data)
    }
    return dest
  } catch {
    return process.execPath
  }
}

app.whenReady().then(async () => {
  setMacMenu()
  // Asked to run as administrator: hand over to an elevated instance (via UAC) and quit this one.
  if (await elevateAtStartupIfWanted()) return app.quit()
  registerShortcut()
  // showcase://deck/<file> serves decks, and only from Glassbox's showcase folder or the one the
  // /pr-showcase skill uses. <file> is a bare name (Glassbox's folder) or an encoded absolute path.
  protocol.handle('showcase', (req) => {
    const raw = decodeURIComponent(new URL(req.url).pathname.replace(/^\/+/, ''))
    const allowed = [showcaseDir(), skillDeckDir()].map((d) => resolve(d).toLowerCase() + sep)
    const full = isAbsolute(raw) ? resolve(raw) : join(showcaseDir(), basename(raw))
    if (!allowed.some((d) => full.toLowerCase().startsWith(d))) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(full).toString())
  })
  // Only media files, by extension; everything else is refused. Byte ranges are honoured, which
  // video needs to play and seek.
  protocol.handle('media', async (req) => {
    const full = resolve(decodeURIComponent(new URL(req.url).pathname.replace(/^\/+/, '')))
    if (!MEDIA_FILE.test(full) || !existsSync(full)) return new Response('Not found', { status: 404 })
    const size = statSync(full).size
    const type = MEDIA_TYPES[extname(full).slice(1).toLowerCase()] ?? 'application/octet-stream'
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') ?? '')
    if (!range) {
      const body = Readable.toWeb(createReadStream(full)) as ReadableStream
      return new Response(body, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } })
    }
    let start = range[1] ? Number(range[1]) : size - Number(range[2])
    let end = range[1] && range[2] ? Number(range[2]) : size - 1
    start = Math.max(0, Math.min(start, size - 1))
    end = Math.min(Math.max(end, start), size - 1)
    const body = Readable.toWeb(createReadStream(full, { start, end })) as ReadableStream
    return new Response(body, {
      status: 206,
      headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' }
    })
  })
  createWindow()
  updates.start()
  tray = new StatusTray({
    onOpen: (tabId) => {
      win?.show()
      win?.focus()
      if (tabId) toRenderer('glassbox:focusTab', tabId)
    },
    onQuit: () => app.quit()
  })
})

app.on('window-all-closed', () => (closeTerminals(), stopAllBangs(), app.quit()))

// Inside the preview, links that open a new window (sign-in popups, target=_blank) stay in the
// preview rather than spawning Electron windows.
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return
  contents.setBackgroundThrottling(false)
  contents.setWindowOpenHandler(({ url }) => {
    void contents.loadURL(url)
    return { action: 'deny' }
  })
})

// Local dev servers often run https with a self-signed certificate (e.g. https://localhost:56117):
// trust those, and only those.
app.on('certificate-error', (event, _contents, url, _error, _cert, callback) => {
  try {
    const host = new URL(url).hostname
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      event.preventDefault()
      return callback(true)
    }
  } catch {
    /* not a URL: fall through to the default (reject) */
  }
  callback(false)
})

// Runs for every quit path (including app.quit()), so sessions and services never outlive the app.
// Each step is guarded: one that throws must not leave Glassbox running with no window (which also
// holds up a pending update, since that installs once the app has gone).
app.on('will-quit', () => {
  const safely = (f: () => unknown) => {
    try {
      void Promise.resolve(f()).catch(() => undefined)
    } catch {
      /* carry on closing */
    }
  }
  for (const h of hosts.values()) safely(() => h.close())
  safely(() => abortAllQueries())
  safely(() => usage.dispose())
  safely(() => services.disposeAll())
  safely(() => tray?.dispose())
  safely(() => watch.dispose())
})
