import { useEffect, useMemo, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import { useSession } from '../views/SessionView'
import { claudeInBrowser } from '../session'
import { useServices } from '../services'
import { CHANGE_TOOLS } from '../session'
import { Icon, IconButton, Toggle } from '../components/ui'
import { Select } from '../components/Select'
import { tr } from '../../../shared/i18n'
import { activateBrowserTab, closeBrowserTab, openInBrowser, updateBrowserTab, useBrowser, type BrowserTabState } from '../browser'

const RELOAD_DELAY_MS = 1500
/** What you typed, as an address: a URL as it is, a local host over http, a domain over https, anything else searched. */
const toUrl = (raw: string) => {
  const v = raw.trim()
  return /^[a-z]+:/i.test(v) ? v : /^(localhost|127\.|\d+\.\d+\.\d+\.\d+)/.test(v) ? `http://${v}` : v.includes('.') && !v.includes(' ') ? `https://${v}` : `https://www.google.com/search?q=${encodeURIComponent(v)}`
}
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
  // The page Claude is working in, marked like the Browser's own tab (the one it named, or the one showing).
  const browsing = claudeInBrowser(s)
  const claudeTab = browsing.active ? (browsing.tab && b.tabs.some((t) => t.id === browsing.tab) ? browsing.tab : active?.id) : undefined

  return (
    <div className="work-page browser">
      <div className="browser-tabs" role="tablist" aria-label={tr('browserTab.tabs')}>
        {b.tabs.map((t) => (
          <div key={t.id} role="tab" aria-selected={t.id === active?.id} className={t.id === active?.id ? 'browser-tab active' : 'browser-tab'} onClick={() => activateBrowserTab(tab.id, t.id)} onAuxClick={(e) => e.button === 1 && closeBrowserTab(tab.id, t.id)} title={t.url}>
            {t.loading ? <Icon name="loading" className="codicon-modifier-spin" /> : t.icon ? <img src={t.icon} alt="" className="browser-favicon" /> : <Icon name="globe" />}
            <span className="ellipsis">{t.title || t.url.replace(/^https?:\/\//, '') || tr('browserTab.newTab')}</span>
            {t.id === claudeTab && (
              <span className="claude-browsing" title={tr('sessionView.claudeBrowsing')} aria-label={tr('sessionView.claudeBrowsing')}>
                <Icon name="sparkle" />
              </span>
            )}
            <button className="browser-tab-close" aria-label={tr('browserTab.closeTab')} onClick={(e) => (e.stopPropagation(), closeBrowserTab(tab.id, t.id))}>
              <Icon name="close" />
            </button>
          </div>
        ))}
        <IconButton icon="add" title={tr('browserTab.newTab')} onClick={() => openInBrowser(tab.id, appUrl ?? 'about:blank')} />
      </div>
      {active && <AddressBar key={active.id} t={active} web={web.map((x) => ({ name: x.name, url: x.config.url!, status: x.status }))} follow={follow} setFollow={setFollow} />}
      <div className="preview-stage">
        {b.tabs.map((t) => (
          <Page key={t.id} t={t} visible={t.id === active?.id} follow={follow && isLocal(t.url)} edits={s.files.filter((f) => CHANGE_TOOLS.has(f.tool)).length} />
        ))}
        {!b.tabs.length && (
          <div className="browser-start">
            {/* Nothing open: the address box is right here rather than behind the + button. */}
            <form
              className="browser-start-form"
              onSubmit={(e) => {
                e.preventDefault()
                const v = new FormData(e.currentTarget).get('address')?.toString() ?? ''
                if (v.trim()) openInBrowser(tab.id, toUrl(v))
              }}
            >
              <Icon name="globe" />
              <input name="address" className="grow" placeholder={tr('browserTab.startPlaceholder')} aria-label={tr('browserTab.address')} autoFocus />
            </form>
            <p className="muted small">
              {tr('browserTab.startBefore')}{' '}
              <button className="link small" onClick={() => showPanel('services')}>
                {tr('browserTab.startLink')}
              </button>
              {tr('browserTab.startAfter')}
            </p>
          </div>
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
    if (!raw.trim()) return
    const url = toUrl(raw)
    // The page picks up the new address and loads it (the same path Claude's browser_open uses).
    updateBrowserTab(tab.id, t.id, { url, loading: true })
  }
  return (
    <div className="work-bar preview-bar-wide">
      <IconButton icon="arrow-left" title={tr('browserTab.back')} onClick={() => wv()?.canGoBack() && wv()?.goBack()} />
      <IconButton icon="arrow-right" title={tr('browserTab.forward')} onClick={() => wv()?.canGoForward() && wv()?.goForward()} />
      <IconButton icon="refresh" title={tr('browserTab.reload')} onClick={() => wv()?.reload()} />
      <input className="mono grow preview-address" value={address} onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go(address)} placeholder={tr('browserTab.addressPlaceholder')} aria-label={tr('browserTab.address')} />
      {web.length > 0 && <Select value="" onChange={(v) => go(v)} placeholder={tr('browserTab.openApp')} aria-label={tr('browserTab.openAppLabel')} options={web.map((x) => ({ value: x.url, label: x.name, hint: x.status }))} />}
      <label className="live-follow" title={tr('browserTab.reloadAfterEditsTip')}>
        {tr('browserTab.reloadAfterEdits')} <Toggle checked={follow} onChange={setFollow} />
      </label>
      <IconButton icon="link-external" title={tr('browserTab.openExternal')} onClick={() => void window.glassbox.openExternal(t.url)} />
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
        setFailed(tr('browserTab.loadFailed', { reason: e.errorDescription || tr('browserTab.didntLoad'), url: e.validatedURL }))
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
    <div className={visible ? 'browser-page' : 'browser-page hidden'} inert={!visible}>
      <webview ref={ref} data-browser-tab={`${tab.id}:${t.id}`} className="preview-frame" src={src} partition="persist:preview" allowpopups={true} />
      {failed && visible && (
        <div className="preview-failed">
          <Icon name="warning" />
          <span className="grow">{failed}</span>
          <button className="btn" onClick={() => (setFailed(null), ref.current?.reload())}>
            {tr('browserTab.tryAgain')}
          </button>
        </div>
      )}
    </div>
  )
}
