import { useEffect, useState } from 'react'
import { useSession } from '../views/SessionView'
import { baseName } from '../lib'
import { DiffView } from '../components/Code'
import { Icon } from '../components/ui'
import { tr } from '../../../shared/i18n'

const STATUS: Record<string, { cls: string; title: string }> = {
  A: { cls: 'ok', title: 'commitTab.status.added' },
  M: { cls: 'warn', title: 'commitTab.status.modified' },
  D: { cls: 'err', title: 'commitTab.status.deleted' },
  R: { cls: 'info', title: 'commitTab.status.renamed' }
}

/** One commit: its files on the left, the selected file's diff (parent → commit) on the right. */
export function CommitTab({ sha }: { sha: string }) {
  const { tab } = useSession()
  const [files, setFiles] = useState<{ status: string; path: string }[] | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  const [pair, setPair] = useState<{ path: string; before: string; after: string } | null>(null)
  const [subject, setSubject] = useState('')

  useEffect(() => {
    void window.glassbox.git.commitFiles(tab.cwd, sha).then((f) => {
      setFiles(f)
      setPick((p) => p ?? f[0]?.path ?? null)
    })
    void window.glassbox.git.log(tab.cwd, null).then((l) => setSubject(l.commits.find((c) => c.sha === sha)?.subject ?? ''))
  }, [tab.cwd, sha])

  useEffect(() => {
    if (!pick) return
    let stale = false
    void Promise.all([window.glassbox.git.showFile(tab.cwd, `${sha}^`, pick), window.glassbox.git.showFile(tab.cwd, sha, pick)]).then(
      ([before, after]) => !stale && setPair({ path: pick, before, after })
    )
    return () => {
      stale = true
    }
  }, [tab.cwd, sha, pick])

  return (
    <div className="live-view">
      <aside className="live-files">
        <div className="live-files-head">
          <Icon name="git-commit" className="muted" />
          <span className="small ellipsis grow" title={subject}>{subject || sha.slice(0, 7)}</span>
        </div>
        {files?.map((f) => (
          <button key={f.path} className={f.path === pick ? 'live-file active' : 'live-file'} onClick={() => setPick(f.path)} title={f.path}>
            <span className={`status-letter ${STATUS[f.status]?.cls ?? 'muted'}`} title={STATUS[f.status] && tr(STATUS[f.status].title)}>{f.status}</span>
            <span className="live-file-main">
              <span className="ellipsis">{baseName(f.path)}</span>
              <span className="muted small ellipsis">{f.path.split('/').slice(0, -1).join('/') || tr('commitTab.projectRoot')}</span>
            </span>
          </button>
        ))}
      </aside>
      <div className="work-page">
        {pair && pair.path === pick ? <DiffView path={pair.path} original={pair.before} modified={pair.after} inline /> : <div className="muted pad">{tr('commitTab.loading')}</div>}
      </div>
    </div>
  )
}
