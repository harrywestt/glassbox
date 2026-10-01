import { useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '../views/SessionView'
import { useServices } from '../services'
import { CHANGE_TOOLS } from '../session'
import { Empty, Icon, IconButton, Toggle } from '../components/ui'
import { Select } from '../components/Select'
import type { WebviewTag } from 'electron'

const RELOAD_DELAY_MS = 1500

/**
 * The running app, inside Glassbox: pick one of this session's services (or type a URL), and it
 * reloads shortly after each of Claude's edits so you see the change land.
 */
/** `url` opens a specific page (Claude's open_preview) instead of the first web service. */
export function PreviewTab({ url: asked }: { url?: string } = {}) {
  const { tab, s, showPanel } = useSession()
  const { snapshot } = useServices(tab.id, tab.cwd)
  const withUrl = useMemo(() => (snapshot?.services ?? []).filter((x) => x.config.url && /^https?:\/\//.test(x.config.url)), [snapshot])
  const [service, setService] = useState<string>('')
  const [url, setUrl] = useState('')
  const [address, setAddress] = useState('')
  const [follow, setFollow] = useState(true)
  const [version, setVersion] = useState(0)
  const frame = useRef<WebviewTag | null>(null)
  // Why the page didn't load (nothing listening, a bad certificate…), instead of a blank page.
  const [failed, setFailed] = useState<string | null>(null)

  // Reload in place (keeping the page you navigated to) rather than remounting at the start URL.
  const reload = () => {
    setFailed(null)
    try {
      frame.current?.reload()
    } catch {
      setVersion((v) => v + 1) // not attached yet
    }
  }
  useEffect(() => {
    const wv = frame.current
    if (!wv) return
    const onNav = (e: { url: string }) => {
      setAddress(e.url)
      setFailed(null)
    }
    const onFail = (e: { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean }) => {
      // -3 is a navigation superseded by another (a redirect): not a failure.
      if (!e.isMainFrame || e.errorCode === -3) return
      setFailed(`${e.errorDescription || 'The page didn’t load'} (${e.validatedURL})`)
    }
    wv.addEventListener('did-navigate', onNav as never)
    wv.addEventListener('did-navigate-in-page', onNav as never)
    wv.addEventListener('did-fail-load', onFail as never)
    return () => {
      wv.removeEventListener('did-navigate', onNav as never)
      wv.removeEventListener('did-navigate-in-page', onNav as never)
      wv.removeEventListener('did-fail-load', onFail as never)
    }
  })

  // Default to the first web-looking service.
  useEffect(() => {
    if (service || !withUrl.length) return
    const pick = withUrl.find((x) => /web|ui|front|app|client/i.test(x.name)) ?? withUrl[0]
    setService(pick.name)
  }, [withUrl, service])
  const current = withUrl.find((x) => x.name === service)
  useEffect(() => {
    if (current?.config.url && !asked) {
      setUrl(current.config.url)
      setAddress(current.config.url)
    }
  }, [current?.config.url])
  useEffect(() => {
    if (!asked) return
    setUrl(asked)
    setAddress(asked)
  }, [asked])

  // Reload a moment after each edit (dev servers need a beat to rebuild).
  const edits = s.files.filter((f) => CHANGE_TOOLS.has(f.tool)).length
  useEffect(() => {
    if (!follow || !edits) return
    const t = setTimeout(reload, RELOAD_DELAY_MS)
    return () => clearTimeout(t)
  }, [edits, follow])

  const running = current && (current.status === 'running' || current.status === 'starting')

  return (
    <div className="work-page">
      <div className="work-bar preview-bar-wide">
        {withUrl.length > 0 && (
          <Select value={service} onChange={setService} aria-label="Service" options={withUrl.map((x) => ({ value: x.name, label: x.name, hint: x.status }))} />
        )}
        <input
          className="mono grow preview-address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const next = address.trim()
              setFailed(null)
              if (next === url) reload()
              else setUrl(next)
            }
          }}
          placeholder="http://localhost:3000"
          aria-label="Address"
        />
        <IconButton icon="refresh" title="Reload" onClick={reload} />
        <label className="live-follow" title="Reload the page shortly after each of Claude's edits">
          Reload after edits <Toggle checked={follow} onChange={setFollow} />
        </label>
        <IconButton icon="link-external" title="Open in your browser" disabled={!url} onClick={() => void window.glassbox.openExternal(url)} />
      </div>
      {!url ? (
        <Empty icon="globe" title="Nothing to preview yet">
          Give a service a <span className="mono">url</span> in services.json, or type an address above.{' '}
          <button className="link" onClick={() => showPanel('services')}>Open services</button>
        </Empty>
      ) : current && !running ? (
        <Empty icon="debug-start" title={`${current.name} isn’t running`}>
          Start it from the Services panel and the page appears here.{' '}
          <button className="link" onClick={() => showPanel('services')}>Open services</button>
        </Empty>
      ) : (
        <div className="preview-stage">
          <webview key={`${url}#${version}`} ref={frame} className="preview-frame" src={url} partition="persist:preview" allowpopups={true} />
          {failed && (
            <div className="preview-failed">
              <Icon name="warning" />
              <span className="grow">{failed}</span>
              <button className="btn" onClick={reload}>
                Try again
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
