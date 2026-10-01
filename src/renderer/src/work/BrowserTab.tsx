import { useEffect, useMemo, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import { useSession } from '../views/SessionView'
import { useServices } from '../services'
import { CHANGE_TOOLS } from '../session'
import { Empty, Icon, IconButton, Toggle } from '../components/ui'
import { Select } from '../components/Select'
import { activateBrowserTab, closeBrowserTab, openInBrowser, updateBrowserTab, useBrowser, type BrowserTabState } from '../browser'

const RELOAD_DELAY_MS = 1500
const isLocal = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?/i.test(url) || url.startsWith('file:')

/**
 * The Browser: tabs of web pages inside Glassbox, sharing one saved profile (sign in once and it
 * stays signed in). It opens the session's running app, anything you type, and the pages Claude
 * opens with its browser tools, so you watch what it does. Local pages reload after Claude's edits.
 */
export function BrowserTab() {
  const { tab, s, showPanel } = useSession()
  const b = useBrowser(tab.id)
  const { snapshot } = useServices(tab.id, tab.cwd)
  const web = useMemo(() => (snapshot?.services ?? []).filter((x) => x.config.url && /^https?:\/\//.test(x.config.url)), [snapshot])
  const [follow, setFollow] = useState(true)

  // With no tabs yet, open the running app (or the first web service).
  const appUrl = (web.find((x) => x.status === 'running' && /web|ui|front|app|client/i.test(x.name)) ?? web.find((x) => x.status === 'running') ?? web[0])?.config.url
  useEffect(() => {
    if (!b.tabs.length && appUrl) openInBrowser(tab.id, appUrl)
  }, [appUrl, b.tabs.length, tab.id])

  const active = b.tabs.find((t) => t.id === b.active) ?? b.tabs[0]

  return (
    <div className="work-page browser">
      <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
        {b.tabs.map((t) => (
          <div key={t.id} role="tab" aria-selected={t.id === active?.id} className={t.id === active?.id ? 'browser-tab active' : 'browser-tab'} onClick={() => activateBrowserTab(tab.id, t.id)} onAuxClick={(e) => e.button === 1 && closeBrowserTab(tab.id, t.id)} title={t.url}>
            {t.loading ? <Icon name="loading" className="codicon-modifier-spin" /> : t.icon ? <img src={t.icon} alt="" className="browser-favicon" /> : <Icon name="globe" />}
            <span className="ellipsis">{t.title || t.url.replace(/^https?:\/\//, '') || 'New tab'}</span>
            <button className="browser-tab-close" aria-label="Close tab" onClick={(e) => (e.stopPropagation(), closeBrowserTab(tab.id, t.id))}>
              <Icon name="close" />
            </button>
          </div>
        ))}
        <IconButton icon="add" title="New tab" onClick={() => openInBrowser(tab.id, appUrl ?? 'about:blank')} />
      </div>
      {active && <AddressBar key={active.id} t={active} web={web.map((x) => ({ name: x.name, url: x.config.url!, status: x.status }))} follow={follow} setFollow={setFollow} />}
      <div className="preview-stage">
        {b.tabs.map((t) => (
          <Page key={t.id} t={t} visible={t.id === active?.id} follow={follow && isLocal(t.url)} edits={s.files.filter((f) => CHANGE_TOOLS.has(f.tool)).length} />
        ))}
        {!b.tabs.length && (
          <Empty icon="globe" title="Nothing open yet">
            Type an address in a new tab, or start the app from{' '}
            <button className="link" onClick={() => showPanel('services')}>
              Services
            </button>
            . Pages Claude opens show here too, and sign-ins are kept.
          </Empty>
        )}
      </div>
    </div>
  )
}

function AddressBar({ t, web, follow, setFollow }: { t: BrowserTabState; web: { name: string; url: string; status: string }[]; follow: boolean; setFollow: (on: boolean) => void }) {
  const { tab } = useSession()
  const [address, setAddress] = useState(t.url)
  useEffect(() => setAddress(t.url), [t.url])
  const wv = () => document.querySelector<WebviewTag>(`webview[data-browser-tab="${tab.id}:${t.id}"]`)
  const go = (raw: string) => {
    const v = raw.trim()
    if (!v) return
    const url = /^[a-z]+:/i.test(v) ? v : /^(localhost|127\.|\d+\.\d+\.\d+\.\d+)/.test(v) ? `http://${v}` : v.includes('.') && !v.includes(' ') ? `https://${v}` : `https://www.google.com/search?q=${encodeURIComponent(v)}`
    // The page picks up the new address and loads it (the same path Claude's browser_open uses).
    updateBrowserTab(tab.id, t.id, { url, loading: true })
  }
  return (
    <div className="work-bar preview-bar-wide">
      <IconButton icon="arrow-left" title="Back" onClick={() => wv()?.canGoBack() && wv()?.goBack()} />
      <IconButton icon="arrow-right" title="Forward" onClick={() => wv()?.canGoForward() && wv()?.goForward()} />
      <IconButton icon="refresh" title="Reload" onClick={() => wv()?.reload()} />
      <input className="mono grow preview-address" value={address} onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go(address)} placeholder="Address, or search" aria-label="Address" />
      {web.length > 0 && <Select value="" onChange={(v) => go(v)} placeholder="Open the app" aria-label="Open one of the app's pages" options={web.map((x) => ({ value: x.url, label: x.name, hint: x.status }))} />}
      <label className="live-follow" title="Reload local pages shortly after each of Claude's edits">
        Reload after edits <Toggle checked={follow} onChange={setFollow} />
      </label>
      <IconButton icon="link-external" title="Open in your browser" onClick={() => void window.glassbox.openExternal(t.url)} />
    </div>
  )
}

/** One tab's page. Kept alive while hidden, so switching tabs or views never reloads it. */
function Page({ t, visible, follow, edits }: { t: BrowserTabState; visible: boolean; follow: boolean; edits: number }) {
  const { tab } = useSession()
  const ref = useRef<WebviewTag | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  // The address it was created with; later navigation happens inside the page, not by remounting.
  const [src] = useState(t.url)
  useEffect(() => {
    const wv = ref.current
    if (!wv) return
    const on = (name: string, fn: (e: never) => void) => (wv.addEventListener(name, fn as never), () => wv.removeEventListener(name, fn as never))
    const offs = [
      on('dom-ready', () => updateBrowserTab(tab.id, t.id, { wcId: wv.getWebContentsId() })),
      on('did-start-loading', () => (updateBrowserTab(tab.id, t.id, { loading: true }), setFailed(null))),
      on('did-stop-loading', () => updateBrowserTab(tab.id, t.id, { loading: false })),
      on('did-navigate', (e: { url: string }) => updateBrowserTab(tab.id, t.id, { url: e.url })),
      on('did-navigate-in-page', (e: { url: string; isMainFrame: boolean }) => e.isMainFrame && updateBrowserTab(tab.id, t.id, { url: e.url })),
      on('page-title-updated', (e: { title: string }) => updateBrowserTab(tab.id, t.id, { title: e.title })),
      on('page-favicon-updated', (e: { favicons: string[] }) => updateBrowserTab(tab.id, t.id, { icon: e.favicons[0] })),
      on('did-fail-load', (e: { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean }) => {
        // -3 is a navigation superseded by another (a redirect): not a failure.
        if (!e.isMainFrame || e.errorCode === -3) return
        setFailed(`${e.errorDescription || 'The page didn’t load'} (${e.validatedURL})`)
      })
    ]
    return () => offs.forEach((f) => f())
  }, [tab.id, t.id])

  // Claude asked this tab to go somewhere else (browser_open into the current tab).
  useEffect(() => {
    const wv = ref.current
    if (!wv || !t.url || t.url === src) return
    try {
      if (wv.getURL() !== t.url) void wv.loadURL(t.url).catch(() => {})
    } catch {
      /* not attached yet: src covers it */
    }
  }, [t.url])

  // Local pages reload a moment after each edit (dev servers need a beat to rebuild).
  useEffect(() => {
    if (!follow || !edits) return
    const timer = setTimeout(() => {
      try {
        ref.current?.reload()
      } catch {
        /* not attached */
      }
    }, RELOAD_DELAY_MS)
    return () => clearTimeout(timer)
  }, [edits, follow])

  return (
    <div className={visible ? 'browser-page' : 'browser-page hidden'}>
      <webview ref={ref} data-browser-tab={`${tab.id}:${t.id}`} className="preview-frame" src={src} partition="persist:preview" allowpopups={true} />
      {failed && visible && (
        <div className="preview-failed">
          <Icon name="warning" />
          <span className="grow">{failed}</span>
          <button className="btn" onClick={() => (setFailed(null), ref.current?.reload())}>
            Try again
          </button>
        </div>
      )}
    </div>
  )
}
