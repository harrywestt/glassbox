import { useEffect, useState } from 'react'
import { mediaKind, mediaUrl } from '../lib'
import { tr } from '../../../shared/i18n'
import { PanZoom } from './PanZoom'

/**
 * An image, video or audio file, shown as itself. An image opens fitted to the tab (never blown up
 * past its own size) and pans and zooms like a sketch: drag with the hand, scroll to zoom by steps,
 * 1 for actual size, 0 to fit; on a checkerboard, so transparency reads. The bar underneath gives the size.
 */
export function MediaView({ path, version = 0 }: { path: string; version?: number }) {
  const kind = mediaKind(path)
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
      {kind === 'image' && (
        <div className="media-stage media-pan checker">
          {/* Measured first; the pan surface needs the picture's own size. */}
          {!size && <img className="media-probe" src={src} alt="" onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} onError={() => setFailed(true)} />}
          {size && (
            <PanZoom contentKey={src} size={size} maxFit={1} hint={tr('mediaView.hint')}>
              <img className="media-img" src={src} alt="" width={size.w} height={size.h} draggable={false} />
            </PanZoom>
          )}
        </div>
      )}
      {kind !== 'image' && (
      <div className="media-stage">
        {kind === 'video' && <video src={src} controls onLoadedMetadata={(e) => setSize({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })} onError={() => setFailed(true)} />}
        {kind === 'audio' && <audio src={src} controls onError={() => setFailed(true)} />}
      </div>
      )}
      {size && size.w > 0 && (
        <div className="media-meta">
          {tr('mediaView.dimensions', { width: size.w, height: size.h })}
        </div>
      )}
    </div>
  )
}
