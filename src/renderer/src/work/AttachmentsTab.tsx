import { useMemo, useState } from 'react'
import { useSession } from '../views/SessionView'
import { sessionAttachments, type Attachment } from '../attachments'
import { FileCard } from '../components/FileCard'
import { Empty, Icon, Segmented } from '../components/ui'

/**
 * Every file in this conversation in one place: the ones you attached, and the ones Claude made or
 * showed you. Each opens inside Glassbox when it can.
 */
export function AttachmentsTab() {
  const { s, tab, attachFiles } = useSession()
  const all = useMemo(() => sessionAttachments(s, tab.cwd), [s.timeline, s.presented, s.files, tab.cwd])
  const [who, setWho] = useState<'all' | 'you' | 'claude'>('all')
  const shown = all.filter((a) => who === 'all' || a.from === who)
  const mine = all.filter((a) => a.from === 'you').length
  const claude = all.length - mine
  const group = (list: Attachment[], title: string) =>
    list.length > 0 && (
      <section className="attach-group">
        <h3 className="attach-head">
          {title} <span className="muted">{list.length}</span>
        </h3>
        <div className="attach-list">
          {list.map((a) => (
            <div key={`${a.from}:${a.path}`} className="attach-item">
              <FileCard path={a.path} title={a.title} why={a.why} />
              <span className="attach-when small">{new Date(a.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span>
            </div>
          ))}
        </div>
      </section>
    )
  return (
    <div className="work-page">
      <div className="work-bar">
        <Segmented<'all' | 'you' | 'claude'>
          value={who}
          onChange={setWho}
          options={[
            { value: 'all', label: `All ${all.length}` },
            { value: 'you', label: `From you ${mine}` },
            { value: 'claude', label: `From Claude ${claude}` }
          ]}
        />
        <span className="spacer" />
        <button className="btn" onClick={() => void window.glassbox.attachments.pick().then((p) => p.length && attachFiles(p))}>
          <Icon name="attach" /> Attach files
        </button>
      </div>
      <div className="work-body attach-body">
        {all.length === 0 ? (
          <Empty icon="attach" title="No files yet">
            Files you attach to a message (the paperclip, or drop them anywhere on this window) and files Claude makes for you collect here.
          </Empty>
        ) : shown.length === 0 ? (
          <Empty icon="attach" title="Nothing here yet" />
        ) : (
          <>
            {group(shown.filter((a) => a.from === 'claude'), 'From Claude')}
            {group(shown.filter((a) => a.from === 'you'), 'From you')}
          </>
        )}
      </div>
    </div>
  )
}
