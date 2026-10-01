import { useEffect, useMemo, useState } from 'react'
import { useSession } from '../views/SessionView'
import { Icon, IconButton } from '../components/ui'

/** Something Claude is waiting on you for: a check-in (it has paused) or a question it logged. */
export type Ask = { kind: 'checkin' | 'question'; id: string; title: string; detail?: string; options: string[]; blocking: boolean; at: number }

/** Unanswered check-ins first (Claude is paused on those), then open questions, oldest first. */
export function usePendingAsks(): Ask[] {
  const { s } = useSession()
  return useMemo(() => {
    const checkins: Ask[] = s.checkins
      .filter((c) => c.answer === undefined)
      .map((c) => ({ kind: 'checkin', id: c.id, title: c.about, detail: c.reason, options: c.options ?? [], blocking: true, at: c.at ?? 0 }))
    const questions: Ask[] = s.decisions
      .filter((d) => d.kind === 'question' && !d.challenged)
      .map((d) => ({ kind: 'question', id: d.id, title: d.title, detail: d.detail, options: d.alternatives ?? [], blocking: false, at: d.at }))
    return [...checkins, ...questions.sort((a, b) => a.at - b.at)]
  }, [s.checkins, s.decisions])
}

/** Sends your answer to whatever Claude asked, the right way for each kind. */
export function useAnswer() {
  const { tab, actions } = useSession()
  return (ask: Ask, text: string) =>
    ask.kind === 'checkin'
      ? window.glassbox.session.respondCheckin(tab.id, ask.id, text)
      : actions.comment(tab.id, { kind: 'decision', id: ask.id, title: ask.title }, text)
}

/**
 * What a message typed in the box answers: a check-in on its own (Claude is paused on it), or every
 * open question at once, since one reply usually covers them all.
 */
export function answerTargets(asks: Ask[]): Ask[] {
  if (!asks.length) return []
  if (asks[0].kind === 'checkin') return [asks[0]]
  return asks.filter((a) => a.kind === 'question')
}

/** Sends one reply to several questions together, so each is marked answered and Claude sorts out which part is which. */
export function useAnswerAll() {
  const { tab, actions } = useSession()
  const one = useAnswer()
  return (asks: Ask[], text: string) =>
    asks.length === 1 ? one(asks[0], text) : actions.comment(tab.id, { kind: 'questions', ids: asks.map((a) => a.id), titles: asks.map((a) => a.title) }, text)
}

/** Inline `code` in a question, rendered as code rather than raw backticks. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/g).map((part, i) =>
        part.startsWith('`') && part.endsWith('`') && part.length > 2 ? <code key={i}>{part.slice(1, -1)}</code> : <span key={i}>{part}</span>
      )}
    </>
  )
}

/**
 * Docked above the message box while Claude is waiting on you: the question and one-click answers
 * when Claude offered some. The message box below answers it until you skip.
 */
export function AskDock({ asks, index, onIndex, answering, onAnswering, compact }: { asks: Ask[]; index: number; onIndex: (i: number) => void; answering: boolean; onAnswering: (on: boolean) => void; compact?: boolean }) {
  const answer = useAnswer()
  const { tab, actions } = useSession()
  // The X: questions close without an answer (they stay in Decisions, marked dismissed). A check-in
  // has Claude paused, so it's told to carry on with its own judgement instead.
  const dismiss = (list: Ask[]) => {
    const questions = list.filter((a) => a.kind === 'question').map((a) => a.id)
    if (questions.length) actions.dismissQuestions(tab.id, questions)
    for (const c of list.filter((a) => a.kind === 'checkin')) void window.glassbox.session.respondCheckin(tab.id, c.id, 'The user skipped this question. Use your best judgement, say what you chose, and carry on.')
  }
  const closeTitle = (list: Ask[]) => (list.some((a) => a.kind === 'checkin') ? 'Skip: Claude carries on with its own judgement' : list.length > 1 ? 'Dismiss these questions (Claude isn’t told; they stay in Decisions)' : 'Dismiss this question (Claude isn’t told; it stays in Decisions)')
  // On the Map, Ripple and Flow tabs the question starts as one row, so it doesn't crowd out the
  // view you're watching; Answer opens it in place.
  const [opened, setOpened] = useState(false)
  useEffect(() => setOpened(false), [compact, asks[index]?.id])
  const ask = asks[index]
  if (!ask) return null
  const together = answerTargets(asks)
  if (!answering || (compact && !opened))
    return (
      <div className="ask-dock skipped">
        <span className="tally-lamp tally-wait" aria-hidden />
        <span className="grow ellipsis">
          {asks.length > 1 ? `${asks.length} questions waiting` : 'A question is waiting'}: <Inline text={ask.title} />
        </span>
        <button className="btn quiet" onClick={() => (onAnswering(true), setOpened(true))}>
          Answer
        </button>
        <IconButton icon="close" title={closeTitle(asks)} onClick={() => dismiss(asks)} />
      </div>
    )
  // Several open questions: all of them at once, numbered, each with its own quick answers. What you
  // type below answers them together.
  if (together.length > 1)
    return (
      <div className="ask-dock" role="region" aria-label="Claude is asking">
        <div className="ask-head">
          <span className="tally-lamp tally-wait" aria-hidden />
          <div className="ask-title">Claude has {together.length} questions</div>
          <button className="btn quiet" onClick={() => onAnswering(false)} title="Send a normal message instead; the questions stay open">
            Later
          </button>
          <IconButton icon="close" title={closeTitle(together)} onClick={() => dismiss(together)} />
        </div>
        <ol className="ask-list">
          {together.map((q) => (
            <li key={q.id}>
              <div className="ask-q">
                <Inline text={q.title} />
              </div>
              {q.detail && (
                <div className="ask-detail">
                  <Inline text={q.detail} />
                </div>
              )}
              {q.options.length > 0 && (
                <div className="ask-options">
                  {q.options.map((o) => (
                    <button key={o} className="btn" onClick={() => void answer(q, o)} title="Answer just this question">
                      <Inline text={o} />
                    </button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ol>
        <div className="ask-hint small muted">Answer them all in one message below, or pick an answer for each.</div>
      </div>
    )
  return (
    <div className={ask.blocking ? 'ask-dock blocking' : 'ask-dock'} role="region" aria-label="Claude is asking">
      <div className="ask-head">
        <span className="tally-lamp tally-wait" aria-hidden />
        <div className="ask-title" title={ask.blocking ? 'Claude has paused until you answer' : undefined}>
          <Inline text={ask.title} />
        </div>
        {asks.length > 1 && (
          <span className="ask-nav">
            <button className="icon-btn" disabled={index === 0} onClick={() => onIndex(index - 1)} title="Previous question" aria-label="Previous question">
              <Icon name="chevron-left" />
            </button>
            <span className="num">
              {index + 1} of {asks.length}
            </span>
            <button className="icon-btn" disabled={index === asks.length - 1} onClick={() => onIndex(index + 1)} title="Next question" aria-label="Next question">
              <Icon name="chevron-right" />
            </button>
          </span>
        )}
        <button className="btn quiet" onClick={() => onAnswering(false)} title="Send a normal message instead; the question stays open">
          Later
        </button>
        <IconButton icon="close" title={closeTitle([ask])} onClick={() => dismiss([ask])} />
      </div>
      {ask.detail && (
        <div className="ask-detail">
          <Inline text={ask.detail} />
        </div>
      )}
      {ask.options.length > 0 && (
        <div className="ask-options">
          {ask.options.map((o) => (
            <button key={o} className="btn" onClick={() => void answer(ask, o)}>
              <Inline text={o} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
