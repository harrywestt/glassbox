import { useEffect, useState } from 'react'
import { useSession } from '../views/SessionView'
import { Icon, IconButton } from '../components/ui'
import { mediaUrl } from '../lib'
import { tr } from '../../../shared/i18n'

type Saved = { path: string; kind: 'image' | 'video' }

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * The Browser's capture buttons: a screenshot (of what shows, or the whole page) and a video of
 * the tab. What's saved can go straight into your next message, be copied, or be shown in its folder.
 * A recording Claude started (browser_record) shows here too, and can be stopped from here.
 */
export function BrowserCapture({ wcId }: { wcId?: number }) {
  const { composerRef } = useSession()
  const [menu, setMenu] = useState(false)
  const [recording, setRecording] = useState<{ started: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<Saved | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  // Whether this tab is being recorded (by you or by Claude), kept in step while the tab is open.
  useEffect(() => {
    if (wcId === undefined) return
    let live = true
    const check = () => void window.glassbox.browser.record(wcId, 'state').then((r) => live && setRecording(r && typeof r === 'object' ? r : null))
    check()
    const t = setInterval(check, 2000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [wcId])
  useEffect(() => {
    if (!recording) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [recording])
  // The note about what was saved clears itself after a while.
  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(null), 20_000)
    return () => clearTimeout(t)
  }, [saved])

  const fail = (e: unknown) => setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
  const shoot = async (fullPage: boolean) => {
    if (wcId === undefined) return
    setMenu(false)
    setBusy(true)
    setError(null)
    try {
      setSaved({ path: await window.glassbox.browser.screenshot(wcId, fullPage), kind: 'image' })
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const toggleRecording = async () => {
    if (wcId === undefined) return
    setError(null)
    try {
      if (!recording) {
        const r = await window.glassbox.browser.record(wcId, 'start')
        setRecording(r && typeof r === 'object' ? r : { started: Date.now() })
        setNow(Date.now())
      } else {
        setBusy(true)
        setRecording(null)
        const path = await window.glassbox.browser.record(wcId, 'stop')
        if (typeof path === 'string') setSaved({ path, kind: 'video' })
        else setError(tr('browserCapture.nothingRecorded'))
      }
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const copy = async (path: string) => {
    try {
      const blob = await (await fetch(mediaUrl(path))).blob()
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })])
      setSaved(null)
    } catch (e) {
      fail(e)
    }
  }

  const off = wcId === undefined
  return (
    <span className="browser-capture">
      <span className="browser-capture-shot">
        <IconButton icon={busy && !recording ? 'loading' : 'device-camera'} title={tr('browserCapture.screenshot')} disabled={off || busy} onClick={() => setMenu(!menu)} />
        {menu && (
          <>
            <div className="menu-scrim" onMouseDown={() => setMenu(false)} />
            <div className="menu capture-menu" role="menu">
              <button className="menu-item" role="menuitem" onClick={() => void shoot(false)}>
                <Icon name="device-camera" /> {tr('browserCapture.visible')}
              </button>
              <button className="menu-item" role="menuitem" onClick={() => void shoot(true)}>
                <Icon name="screen-full" /> {tr('browserCapture.wholePage')}
              </button>
            </div>
          </>
        )}
      </span>
      {recording ? (
        <button className="btn capture-stop" onClick={() => void toggleRecording()} title={tr('browserCapture.stopTip')}>
          <span className="capture-dot" aria-hidden /> <span className="num">{clock(now - recording.started)}</span> {tr('browserCapture.stop')}
        </button>
      ) : (
        <IconButton icon="device-camera-video" title={tr('browserCapture.record')} disabled={off || busy} onClick={() => void toggleRecording()} />
      )}
      {(saved || error) && (
        <div className="capture-note" role="status">
          {error ? (
            <>
              <Icon name="error" />
              <span className="grow">{error}</span>
            </>
          ) : (
            saved && (
              <>
                {saved.kind === 'image' ? <img className="capture-thumb" src={mediaUrl(saved.path)} alt="" /> : <Icon name="device-camera-video" />}
                <span className="grow">{saved.kind === 'image' ? tr('browserCapture.savedShot') : tr('browserCapture.savedVideo')}</span>
                <button className="btn primary" onClick={() => (composerRef.current?.attach([saved.path]), setSaved(null))}>
                  {tr('browserCapture.attach')}
                </button>
                {saved.kind === 'image' && <button className="btn" onClick={() => void copy(saved.path)}>{tr('browserCapture.copy')}</button>}
                <IconButton icon="folder-opened" title={tr('browserCapture.showInFolder')} onClick={() => void window.glassbox.showInFolder(saved.path)} />
              </>
            )
          )}
          <IconButton icon="close" title={tr('browserCapture.dismiss')} onClick={() => (setSaved(null), setError(null))} />
        </div>
      )}
    </span>
  )
}
