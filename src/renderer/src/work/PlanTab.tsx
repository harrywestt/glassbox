import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Effort, PermissionDecision } from '../../../shared/events'
import { CHANGE_TOOLS, type SessionState } from '../session'
import { useSession } from '../views/SessionView'
import { relPath, renderMarkdown } from '../lib'
import { Empty, Icon, IconButton } from '../components/ui'
import { Select } from '../components/Select'
import { tr } from '../../../shared/i18n'
import { useThemeTokens } from '../App'
import { enhance } from '../markdownDoc'
import { answersText, CalloutBlock, DiffBlock, FilesBlock, mdBlocks, parsePlan, planAsMarkdown, planChanges, QuestionsBlock, SketchBlock, stepStatus, type Answers } from './planBlocks'

export type PlanShown = { text: string; status?: NonNullable<SessionState['plan']>['status'] }

const STATUS = { approved: 'planTab.status.approved', proposed: 'planTab.status.proposed', 'changes-requested': 'planTab.status.changesRequested' } as const

type Note = { id: number; quote: string; text: string }

/**
 * Claude's plan, as a view of its own: it opens when Claude presents one, and waits there while you
 * look at anything else (the map, the code, the browser). Approve it or ask for changes from here.
 * Once decided, or for an earlier plan picked from the conversation, it's there to read again.
 *
 * Reviewing it: answer its open questions, pick in its sketches, skip steps you don't want, and
 * leave notes on any part (select some text). All of that goes with your decision; approved, it
 * rides in the plan Claude builds from. A revised plan can show what changed since the last one.
 * Once approved, the plan follows the build: steps tick off as Claude's to-dos do, files as they're
 * edited. It can be kept in the project or added to the pull request.
 */
export function PlanTab({ shown }: { shown: PlanShown | null }) {
  const { tab, s, actions, showMap, openFile } = useSession()
  const [feedback, setFeedback] = useState('')
  const [asking, setAsking] = useState(false)
  const request = s.permissions.find((p) => p.toolName === 'ExitPlanMode')
  // Every plan presented in this session, oldest first. Versions of one plan share its title; a plan
  // with a new title (another feature for the ticket, say) is a plan of its own, not a replacement.
  const versions = useMemo(
    () =>
      Object.values(s.toolCalls)
        .filter((c) => c.name === 'ExitPlanMode' && typeof c.input.plan === 'string' && c.input.plan.trim())
        .sort((a, b) => a.at - b.at),
    [s.toolCalls]
  )
  const plans = useMemo(() => {
    const out: { title: string; calls: typeof versions }[] = []
    for (const c of versions) {
      const t = planTitle(String(c.input.plan))
      const same = out.find((p) => p.title.toLowerCase() === t.toLowerCase())
      if (same) same.calls.push(c)
      else out.push({ title: t, calls: [c] })
    }
    return out
  }, [versions])
  const [pickedId, setPickedId] = useState<string | null>(null)
  // A new plan arriving (or one opened from the conversation) shows instead of what you'd picked.
  useEffect(() => setPickedId(null), [versions.length, shown?.text])
  const picked = pickedId ? versions.find((c) => c.id === pickedId) : undefined
  // The waiting plan comes first unless you picked another; otherwise the one you picked or opened, or the latest.
  const waitingText = request ? String(request.input.plan ?? '') : null
  const text = picked ? String(picked.input.plan) : waitingText !== null && (!shown || shown.text === waitingText) ? waitingText : (shown?.text ?? s.plan?.text ?? '')
  const waiting = !!request && text === waitingText
  const statusOf = (callText: string, callStatus?: string) =>
    waitingText === callText ? 'proposed' : s.plan?.text === callText ? s.plan.status : callStatus === 'error' ? 'changes-requested' : callStatus === 'done' ? 'approved' : undefined
  const status = waiting ? 'proposed' : picked ? statusOf(text, picked.status) : (shown ? shown.status : s.plan?.status)
  // The plan's shape, when Claude drew it on the map for this plan (since your last message).
  const since = [...s.timeline].reverse().find((i) => i.kind === 'user')?.at ?? 0
  const shape = waiting && s.planMap && s.planMap.at >= since ? s.planMap : undefined
  // The plan's blocks (sketches, files, diffs, callouts, open questions) between its Markdown.
  const segments = useMemo(() => parsePlan(text), [text])
  const theme = useThemeTokens()
  const doc = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [outline, setOutline] = useState<{ id: string; text: string; block?: boolean }[]>([])
  const [current, setCurrent] = useState<string | null>(null)

  // Your review, kept until the plan changes.
  const [answers, setAnswers] = useState<Answers>({})
  const [picks, setPicks] = useState<Record<string, string>>({})
  const [skipped, setSkipped] = useState<Set<number>>(new Set())
  const [notes, setNotes] = useState<Note[]>([])
  const [showNotes, setShowNotes] = useState(false)
  useEffect(() => {
    setAnswers({})
    setPicks({})
    setSkipped(new Set())
    setNotes([])
  }, [text])
  const changedAnswers = segments.some((sg) => sg.kind === 'questions' && sg.items.some((q) => answers[q.text]?.trim() && answers[q.text].trim() !== q.options[0]))
  const steps = useRef<string[]>([])

  // This plan's versions: a revision can show what changed since the one before.
  const group = plans.find((p) => p.calls.some((c) => String(c.input.plan) === text))
  const own = group?.calls ?? []
  const index = own.findIndex((c) => String(c.input.plan) === text)
  const previous = index > 0 ? String(own[index - 1].input.plan) : null
  const [showChanges, setShowChanges] = useState(false)
  useEffect(() => setShowChanges(false), [text])
  const changes = useMemo(() => (showChanges && previous ? planChanges(previous, text) : null), [showChanges, previous, text])

  // Once approved (and still the latest plan), it follows the build.
  const building = !waiting && s.plan?.status === 'approved' && s.plan.text === text
  const approvedAt = index >= 0 ? (own[index].endedAt ?? own[index].at) : 0
  const builtFiles = useMemo(() => {
    if (!building) return undefined
    return new Set(s.files.filter((f) => CHANGE_TOOLS.has(f.tool) && f.at >= approvedAt).map((f) => relPath(tab.cwd, f.path).replace(/\\/g, '/').toLowerCase()))
  }, [building, s.files, approvedAt, tab.cwd])

  // Diagrams drawn, code coloured, callouts and task lists, as in the Markdown viewer.
  useLayoutEffect(() => {
    if (doc.current) enhance(doc.current, theme, { copy: tr('markdownView.copyCode'), copied: tr('markdownView.copied'), alert: (k) => tr(`markdownView.alert.${k}`) })
  }, [segments, theme, showChanges])

  // The plan's steps (its numbered lists): skip toggles while it waits, progress once it's building.
  useLayoutEffect(() => {
    const items = [...(doc.current?.querySelectorAll<HTMLLIElement>('.plan-md > ol > li') ?? [])]
    // A step's own words, without the Skip button Glassbox adds to it.
    steps.current = items.map((li) => [...li.childNodes].filter((n) => !(n instanceof HTMLElement && n.classList.contains('plan-step-skip'))).map((n) => n.textContent ?? '').join('').trim())
    items.forEach((li, i) => {
      li.dataset.step = String(i)
      li.classList.toggle('skipped', skipped.has(i))
      let btn = li.querySelector<HTMLButtonElement>(':scope > .plan-step-skip')
      if (waiting && !btn) {
        btn = document.createElement('button')
        btn.className = 'plan-step-skip'
        btn.type = 'button'
        li.append(btn)
      }
      if (!waiting) btn?.remove()
      if (btn) {
        btn.textContent = skipped.has(i) ? tr('planTab.includeStep') : tr('planTab.skipStep')
        btn.title = skipped.has(i) ? tr('planTab.includeStepTip') : tr('planTab.skipStepTip')
        btn.setAttribute('aria-pressed', String(skipped.has(i)))
      }
      const st = building ? stepStatus(steps.current[i], s.todos ?? []) : null
      if (st) li.dataset.status = st
      else delete li.dataset.status
    })
  }, [segments, skipped, waiting, building, s.todos, showChanges])
  const stepsDone = building ? [...(doc.current?.querySelectorAll('.plan-md > ol > li[data-status="done"]') ?? [])].length : 0
  const stepsTotal = steps.current.length

  // The plan's sections, for the outline: its headings and its sketches, files and questions, in order.
  useEffect(() => {
    const heads = [...(doc.current?.querySelectorAll<HTMLElement>('h2, [data-outline]') ?? [])]
    heads.forEach((h, i) => (h.id = `plan-${i}`))
    setOutline(heads.map((h) => ({ id: h.id, text: h.dataset.outline ?? h.textContent ?? '', block: !!h.dataset.outline })))
  }, [segments, showChanges])

  // What the plan amounts to, for the bar: files it touches, risks it names, questions it leaves open.
  const facts = useMemo(() => {
    const files = segments.reduce((n, sg) => n + (sg.kind === 'files' ? sg.rows.length : 0), 0)
    const risks = segments.filter((sg) => sg.kind === 'callout' && sg.type === 'risk').length
    const questions = segments.reduce((n, sg) => n + (sg.kind === 'questions' ? sg.items.length : 0), 0)
    return { files, risks, questions }
  }, [segments])
  const jump = (kind: string) => doc.current?.querySelector(`[data-kind="${kind}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  // The section you're reading, marked in the outline.
  useEffect(() => {
    const box = scroller.current
    if (!box || outline.length < 3) return
    const onScroll = () => {
      const r = box.getBoundingClientRect()
      const top = r.top + r.height / 3
      let at: string | null = null
      for (const o of outline) {
        const h = document.getElementById(o.id)
        if (h && h.getBoundingClientRect().top <= top) at = o.id
      }
      setCurrent(at)
      setPop(null)
    }
    onScroll()
    box.addEventListener('scroll', onScroll, { passive: true })
    return () => box.removeEventListener('scroll', onScroll)
  }, [outline])

  // A note on part of the plan: select some text, then Note.
  const [pop, setPop] = useState<{ x: number; y: number; quote: string } | null>(null)
  const [draft, setDraft] = useState('')
  const onMouseUp = () => {
    if (!waiting) return
    const sel = window.getSelection()
    const quote = sel?.toString().replace(/\s+/g, ' ').trim()
    if (!sel || !quote || !sel.rangeCount || !doc.current?.contains(sel.anchorNode) || !scroller.current) return
    const r = sel.getRangeAt(0).getBoundingClientRect()
    const box = scroller.current.getBoundingClientRect()
    setDraft('')
    setPop({ x: Math.min(Math.max(r.left + r.width / 2 - box.left, 170), box.width - 170), y: r.bottom - box.top + scroller.current.scrollTop + 8, quote: quote.slice(0, 300) })
  }
  const addNote = () => {
    if (!pop || !draft.trim()) return
    setNotes((n) => [...n, { id: Date.now(), quote: pop.quote, text: draft.trim() }])
    setPop(null)
    window.getSelection()?.removeAllRanges()
  }

  // Skipping a step: the button sits in the plan's own HTML, so its clicks come through here.
  const onDocClick = (e: React.MouseEvent) => {
    const btn = (e.target as Element).closest('.plan-step-skip')
    const li = btn?.closest<HTMLElement>('li[data-step]')
    if (!btn || !li) return
    const i = Number(li.dataset.step)
    setSkipped((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  // Everything you decided while reading, as text for Claude.
  const review = (): string => {
    const parts: string[] = []
    if (changedAnswers) parts.push(answersText(segments, answers))
    const pickLines = Object.entries(picks).map(([id, label]) => `- In the sketch "${s.sketches?.[id]?.title ?? id}": ${label}`)
    if (pickLines.length) parts.push(`Picked in the sketches:\n${pickLines.join('\n')}`)
    const skip = [...skipped].sort((a, b) => a - b).map((i) => `- ${i + 1}. ${steps.current[i]}`)
    if (skip.length) parts.push(`Leave out these steps (don't do them):\n${skip.join('\n')}`)
    if (notes.length) parts.push(`Notes on parts of the plan:\n${notes.map((n) => `- On "${n.quote}": ${n.text}`).join('\n')}`)
    return parts.join('\n\n')
  }
  const reviewCount = (changedAnswers ? 1 : 0) + Object.keys(picks).length + skipped.size + notes.length

  // How the build runs, chosen as you approve: the model (and its effort) for the work.
  const [buildModel, setBuildModel] = useState('')
  const [buildEffort, setBuildEffort] = useState('')
  const modelOptions = [
    { value: '', label: tr('planTab.build.sameModel') },
    ...['opus', 'sonnet', 'haiku'].filter((m) => (s.models ?? []).some((x) => x.value === m)).map((m) => ({ value: m, label: tr(`planTab.build.${m}`) }))
  ]
  const effortOptions = [{ value: '', label: tr('planTab.build.sameEffort') }, ...(['low', 'medium', 'high', 'xhigh'] as const).map((l) => ({ value: l, label: tr('planTab.build.effort', { level: tr(`modelPicker.effortName.${l}`) }) }))]

  const respond = (decision: PermissionDecision, message?: string) => request && window.glassbox.session.respondPermission(tab.id, request.id, decision, message)
  const approve = async () => {
    if (buildModel) await window.glassbox.session.setModel(tab.id, buildModel).catch(() => {})
    if (buildEffort) await window.glassbox.session.setEffort(tab.id, buildEffort as Effort).catch(() => {})
    actions.planStatus(tab.id, 'approved')
    void respond('allow', review() || undefined)
  }
  const sendFeedback = () => {
    const extra = review()
    if (!feedback.trim() && !extra) return
    actions.planStatus(tab.id, 'changes-requested')
    void respond('deny', `The user reviewed your plan and wants changes before you start:\n\n${[feedback.trim(), extra].filter(Boolean).join('\n\n')}\n\nRevise the plan and present it again.`)
    setAsking(false)
    setFeedback('')
  }

  // Keeping it: in the project, or in the pull request.
  const [kept, setKept] = useState<{ text: string; path?: string; error?: boolean } | null>(null)
  const title = (text.match(/^#\s+(.+)$/m)?.[1] ?? tr('planTab.title')).trim()
  const save = async () => {
    try {
      const path = await window.glassbox.plan.save(tab.cwd, title, planAsMarkdown(text))
      setKept({ text: tr('planTab.saved', { file: relPath(tab.cwd, path) }), path })
    } catch (e) {
      setKept({ text: String(e), error: true })
    }
  }
  const toPr = async () => {
    setKept({ text: tr('planTab.addingToPr') })
    const r = await window.glassbox.plan.toPr(tab.cwd, planAsMarkdown(text))
    setKept(r.error ? { text: r.error, error: true } : { text: tr('planTab.addedToPr') })
  }

  if (!text)
    return (
      <div className="plan-tab">
        <Empty center icon="checklist" title={tr('planTab.emptyTitle')}>{tr('planTab.empty')}</Empty>
      </div>
    )

  const md = (body: string, key: string) =>
    changes ? (
      mdBlocks(body).map((b, j) => <div key={`${key}-${j}`} className={changes.isNew(b) ? 'plan-md plan-changed' : 'plan-md'} dangerouslySetInnerHTML={{ __html: renderMarkdown(b, tab.cwd) }} />)
    ) : (
      <div key={key} className="plan-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(body, tab.cwd) }} />
    )

  return (
    <div className="plan-tab">
      <div className="plan-bar">
        <Icon name="checklist" />
        <strong>{tr('planTab.title')}</strong>
        {plans.length > 1 && (
          <Select
            className="plan-picker"
            value={group?.calls[group.calls.length - 1].id ?? ''}
            onChange={(id) => setPickedId(id)}
            aria-label={tr('planTab.pickPlan')}
            title={tr('planTab.pickPlan')}
            options={plans.map((p) => {
              const last = p.calls[p.calls.length - 1]
              const st = statusOf(String(last.input.plan), last.status)
              return { value: last.id, label: p.title, hint: [st ? tr(STATUS[st]) : '', p.calls.length > 1 ? tr('planTab.versions', { count: p.calls.length }) : ''].filter(Boolean).join(' · ') }
            })}
          />
        )}
        {own.length > 1 && index >= 0 && (
          <Select
            className="plan-version-picker"
            value={own[index].id}
            onChange={(id) => setPickedId(id)}
            aria-label={tr('planTab.pickVersion')}
            title={tr('planTab.pickVersion')}
            options={own.map((c, i) => ({ value: c.id, label: tr('planTab.version', { n: i + 1, of: own.length }) }))}
          />
        )}
        {status && <span className={`plan-status plan-status-${status}`}>{tr(STATUS[status])}</span>}
        {waiting && <span className="muted small ellipsis">{tr('planTab.nothingChangedYet')}</span>}
        {building && stepsTotal > 0 && <span className="plan-progress small">{tr('planTab.building', { done: stepsDone, total: stepsTotal })}</span>}
        <span className="grow" />
        {previous && (
          <button className={showChanges ? 'plan-fact on' : 'plan-fact'} onClick={() => setShowChanges(!showChanges)} aria-pressed={showChanges} title={tr('planTab.changesTip')}>
            <Icon name="diff" /> {tr('planTab.changes')}
          </button>
        )}
        <span className="plan-facts">
          {facts.files > 0 && (
            <button className="plan-fact" onClick={() => jump('files')}>
              <Icon name="files" /> {tr('planTab.facts.files', { count: facts.files })}
            </button>
          )}
          {facts.risks > 0 && (
            <button className="plan-fact warn" onClick={() => jump('risk')}>
              <Icon name="warning" /> {tr('planTab.facts.risks', { count: facts.risks })}
            </button>
          )}
          {facts.questions > 0 && (
            <button className="plan-fact" onClick={() => jump('questions')}>
              <Icon name="question" /> {tr('planTab.facts.questions', { count: facts.questions })}
            </button>
          )}
        </span>
        {shape && (
          <button className="btn plan-map" onClick={showMap} title={shapeText(shape)}>
            <Icon name="type-hierarchy" /> {tr('planTab.seeOnMap')}
          </button>
        )}
        <IconButton icon="save" title={tr('planTab.saveTip')} onClick={() => void save()} />
        <IconButton icon="git-pull-request" title={tr('planTab.toPrTip')} onClick={() => void toPr()} />
        <IconButton icon="copy" title={tr('planTab.copy')} onClick={() => void navigator.clipboard.writeText(planAsMarkdown(text))} />
      </div>
      {kept && (
        <div className={kept.error ? 'plan-kept error' : 'plan-kept'} role="status">
          <Icon name={kept.error ? 'error' : 'pass'} />
          <span className="grow ellipsis">{kept.text}</span>
          {kept.path && (
            <button className="link small" onClick={() => openFile(kept.path!)}>
              {tr('planTab.openSaved')}
            </button>
          )}
          <IconButton icon="close" title={tr('planTab.dismiss')} onClick={() => setKept(null)} />
        </div>
      )}
      <div className="plan-scroll" ref={scroller}>
        <div className={outline.length >= 3 ? 'plan-layout with-outline' : 'plan-layout'}>
          {outline.length >= 3 && (
            <nav className="plan-outline" aria-label={tr('planTab.outline')}>
              {outline.map((o) => (
                <button key={o.id} className={`${o.id === current ? 'on' : ''}${o.block ? ' block' : ''}`} onClick={() => document.getElementById(o.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                  {o.text}
                </button>
              ))}
            </nav>
          )}
          <article className={building ? 'plan-doc markdown building' : 'plan-doc markdown'} ref={doc} onMouseUp={onMouseUp} onClick={onDocClick}>
            {changes && changes.removed.length > 0 && (
              <details className="plan-removed">
                <summary>{tr('planTab.removed', { count: changes.removed.length })}</summary>
                {changes.removed.map((b, j) => (
                  <div key={j} className="plan-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(b, tab.cwd) }} />
                ))}
              </details>
            )}
            {segments.map((sg, i) =>
              sg.kind === 'md' ? (
                md(sg.text, String(i))
              ) : sg.kind === 'sketch' ? (
                <SketchBlock key={i} id={sg.id} version={sg.version} caption={sg.caption} picked={picks[sg.id]} onPick={waiting ? (label) => setPicks((p) => ({ ...p, [sg.id]: label })) : undefined} />
              ) : sg.kind === 'files' ? (
                <FilesBlock key={i} rows={sg.rows} done={builtFiles} />
              ) : sg.kind === 'diff' ? (
                <DiffBlock key={i} file={sg.file} body={sg.body} />
              ) : sg.kind === 'callout' ? (
                <CalloutBlock key={i} type={sg.type} html={renderMarkdown(sg.body, tab.cwd)} />
              ) : (
                <QuestionsBlock key={i} items={sg.items} answers={answers} onAnswer={(q, a) => setAnswers((prev) => ({ ...prev, [q]: a }))} editable={!!waiting} />
              )
            )}
          </article>
        </div>
        {pop && (
          <div className="plan-note-pop" style={{ left: pop.x, top: pop.y }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="plan-note-quote ellipsis">“{pop.quote}”</div>
            <div className="plan-note-row">
              <input
                autoFocus
                placeholder={tr('planTab.notePlaceholder')}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addNote()
                  if (e.key === 'Escape') setPop(null)
                }}
              />
              <button className="primary" disabled={!draft.trim()} onClick={addNote}>
                {tr('planTab.addNote')}
              </button>
            </div>
          </div>
        )}
      </div>
      {waiting && (
        <div className="plan-decide">
          <div className="plan-decide-inner">
            {showNotes && notes.length > 0 && (
              <ul className="plan-notes">
                {notes.map((n) => (
                  <li key={n.id}>
                    <span className="plan-note-on">“{n.quote}”</span>
                    <span className="grow">{n.text}</span>
                    <IconButton icon="close" title={tr('planTab.removeNote')} onClick={() => setNotes((all) => all.filter((x) => x.id !== n.id))} />
                  </li>
                ))}
              </ul>
            )}
            {asking ? (
              <>
                <textarea
                  autoFocus
                  rows={3}
                  placeholder={tr('planTab.feedbackPlaceholder')}
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendFeedback()
                    else if (e.key === 'Escape') setAsking(false)
                  }}
                />
                <div className="plan-decide-row">
                  <span className="muted small">{reviewCount ? tr('planTab.feedbackWithReview', { count: reviewCount }) : tr('planTab.feedbackHint')}</span>
                  <span className="grow" />
                  <button onClick={() => setAsking(false)}>{tr('planTab.back')}</button>
                  <button className="primary" disabled={!feedback.trim() && !reviewCount} onClick={sendFeedback}>
                    {tr('planTab.sendFeedback')}
                  </button>
                </div>
              </>
            ) : (
              <div className="plan-decide-row">
                <span className="plan-review small">
                  {reviewCount > 0 ? (
                    <>
                      {notes.length > 0 && (
                        <button className="link small" onClick={() => setShowNotes(!showNotes)} aria-expanded={showNotes}>
                          {tr('planTab.review.notes', { count: notes.length })}
                        </button>
                      )}
                      {skipped.size > 0 && <span>{tr('planTab.review.skipped', { count: skipped.size })}</span>}
                      {Object.keys(picks).length > 0 && <span>{tr('planTab.review.picks', { count: Object.keys(picks).length })}</span>}
                      {changedAnswers && <span>{tr('planTab.review.answers')}</span>}
                      <span className="muted">{tr('planTab.review.goesWith')}</span>
                    </>
                  ) : facts.questions > 0 ? (
                    <span className="muted">
                      {tr('planTab.questionsDefault', { count: facts.questions })}{' '}
                      <button className="link small" onClick={() => jump('questions')}>
                        {tr('planTab.reviewQuestions')}
                      </button>
                    </span>
                  ) : (
                    <span className="muted">{tr('planTab.reviewHint')}</span>
                  )}
                </span>
                <span className="grow" />
                <Select value={buildModel} options={modelOptions} onChange={setBuildModel} title={tr('planTab.build.modelTip')} aria-label={tr('planTab.build.modelTip')} />
                <Select value={buildEffort} options={effortOptions} onChange={setBuildEffort} title={tr('planTab.build.effortTip')} aria-label={tr('planTab.build.effortTip')} />
                <button onClick={() => setAsking(true)}>{tr('planTab.requestChanges')}</button>
                <button className="primary" onClick={() => void approve()}>
                  {tr('planTab.approvePlan')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function shapeText(shape: NonNullable<SessionState['planMap']>): string {
  return (
    tr('planTab.shape.touchesModules', { count: shape.modules.length }) +
    (shape.modules.some((m) => m.change === 'new') ? tr('planTab.shape.newOfThem', { count: shape.modules.filter((m) => m.change === 'new').length }) : '') +
    (shape.connections.length ? tr('planTab.shape.changesConnections', { count: shape.connections.length }) : '') +
    tr('planTab.shape.end')
  )
}

/** A plan's name: its first heading, else its first line. */
function planTitle(text: string): string {
  const t = text.match(/^#{1,2}\s+(.+)$/m)?.[1] ?? text.split('\n').find((l) => l.trim()) ?? ''
  return t.replace(/^plan\s*[:\-–]\s*/i, '').replace(/[*_`]/g, '').trim().slice(0, 80) || tr('planTab.title')
}
