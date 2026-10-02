import { useEffect, useState } from 'react'
import { mediaKind, mediaUrl } from '../lib'
import { tr } from '../../../shared/i18n'

/**
 * An image, video or audio file, shown as itself. Images fit the tab (click for actual size) on a
 * checkerboard, so transparency reads; the bar underneath gives the size.
 */
export function MediaView({ path, version = 0 }: { path: string; version?: number }) {
  const kind = mediaKind(path)
  const [actual, setActual] = useState(false)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [failed, setFailed] = useState(false)
  // Bust the cache when the file changes on disk (Claude regenerated the screenshot).
  const src = `${mediaUrl(path)}?v=${version}`
  useEffect(() => {
    setFailed(false)
    setSize(null)
  }, [src])

  if (failed) return <div className="media-view media-failed">{tr('mediaView.failed')}</div>
  return (
    <div className="media-view">
      <div className={`media-stage${kind === 'image' ? ' checker' : ''}${actual ? ' actual' : ''}`}>
        {kind === 'image' && (
          <img
            src={src}
            alt=""
            onClick={() => setActual(!actual)}
            onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setFailed(true)}
            title={actual ? tr('mediaView.fitToTab') : tr('mediaView.actualSize')}
          />
        )}
        {kind === 'video' && <video src={src} controls onLoadedMetadata={(e) => setSize({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })} onError={() => setFailed(true)} />}
        {kind === 'audio' && <audio src={src} controls onError={() => setFailed(true)} />}
      </div>
      {size && size.w > 0 && (
        <div className="media-meta">
          {tr('mediaView.dimensions', { width: size.w, height: size.h })}
          {kind === 'image' && <span>{actual ? tr('mediaView.actualSizeClickToFit') : tr('mediaView.clickForActualSize')}</span>}
        </div>
      )}
    </div>
  )
}
