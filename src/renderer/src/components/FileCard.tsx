import { useEffect, useState } from 'react'
import { useSession } from '../views/SessionView'
import { fileKind, formatSize, KIND_ICON, KIND_LABEL, opensInside } from '../attachments'
import { baseName, mediaUrl } from '../lib'
import { Icon, IconButton } from './ui'
import { tr } from '../../../shared/i18n'

/**
 * A file as a card: a preview when it's an image or video, what it is and how big, and one click to
 * open it (inside Glassbox when Glassbox can show it, otherwise in its own app).
 */
export function FileCard({ path, title, why, compact }: { path: string; title?: string; why?: string; compact?: boolean }) {
  const { openAttachment } = useSession()
  const kind = fileKind(path)
  const [info, setInfo] = useState<{ exists: boolean; size?: number } | null>(null)
  useEffect(() => {
    let live = true
    void window.glassbox.stat(path).then((i) => live && setInfo(i)).catch(() => live && setInfo({ exists: false }))
    return () => {
      live = false
    }
  }, [path])
  const missing = info && !info.exists
  const folder = path.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
  return (
    <div className={`file-card${compact ? ' compact' : ''}${missing ? ' missing' : ''}`}>
      {!compact && !missing && kind === 'image' && (
        <button className="file-card-preview checker" onClick={() => openAttachment(path)} title={tr('fileCard.open')}>
          <img src={mediaUrl(path)} alt="" />
        </button>
      )}
      {!compact && !missing && kind === 'video' && <video className="file-card-preview" src={mediaUrl(path)} controls preload="metadata" />}
      {!compact && !missing && kind === 'audio' && <audio className="file-card-audio" src={mediaUrl(path)} controls preload="metadata" />}
      <div className="file-card-row">
        <Icon name={KIND_ICON[kind]} className="file-card-icon" />
        <div className="file-card-text">
          <button className="file-card-name" onClick={() => openAttachment(path)} disabled={!!missing} title={path}>
            {title || baseName(path)}
          </button>
          <span className="file-card-meta">
            {missing ? tr('fileCard.notFound') : [title ? baseName(path) : KIND_LABEL[kind], formatSize(info?.size)].filter(Boolean).join(', ')}
            <span className="file-card-folder" title={folder}>
              {' '}
              {tr('fileCard.inFolder', { folder: folder.split('/').slice(-2).join('/') || folder })}
            </span>
          </span>
          {why && !compact && <span className="file-card-why">{why}</span>}
        </div>
        {!missing && (
          <span className="file-card-actions">
            <button className="btn" onClick={() => openAttachment(path)}>
              {opensInside(kind) ? tr('fileCard.open') : tr('fileCard.openExternally')}
            </button>
            <IconButton icon="folder-opened" title={tr('fileCard.showInFolder')} onClick={() => void window.glassbox.showInFolder(path)} />
          </span>
        )}
      </div>
    </div>
  )
}
