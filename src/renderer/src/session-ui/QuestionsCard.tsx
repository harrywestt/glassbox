import { useEffect, useState } from 'react'
import { useSession } from '../views/SessionView'
import { Icon, IconButton } from '../components/ui'
import type { UserQuestion } from '../../../shared/events'
import { tr } from '../../../shared/i18n'

/**
 * Claude's questions (AskUserQuestion), answered here: pick an option per question, or type your own,
 * then Send. Several questions are answered together, the way Claude asked them.
 */
export function QuestionsCard() {
  const { tab, s } = useSession()
  const ask = s.userQuestions?.[0]
  if (!ask) return null
  return <Questions key={ask.id} tabId={tab.id} id={ask.id} questions={ask.questions} />
}

function Questions({ tabId, id, questions }: { tabId: string; id: string; questions: UserQuestion[] }) {
  // Per question: the picked option labels, and your own answer if you wrote one.
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [own, setOwn] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)
  const answerOf = (q: UserQuestion) => (own[q.question]?.trim() ? own[q.question].trim() : (picked[q.question] ?? []).join(', '))
  const ready = questions.every((q) => answerOf(q))
  const send = async () => {
    if (!ready || sending) return
    setSending(true)
    await window.glassbox.session.answerQuestions(tabId, id, Object.fromEntries(questions.map((q) => [q.question, answerOf(q)])))
  }
  const pick = (q: UserQuestion, label: string) =>
    setPicked((p) => {
      const now = p[q.question] ?? []
      const next = q.multiSelect ? (now.includes(label) ? now.filter((l) => l !== label) : [...now, label]) : [label]
      return { ...p, [q.question]: next }
    })
  // One question with one choice: picking it is the answer, so it sends straight away.
  const instant = questions.length === 1 && !questions[0].multiSelect
  useEffect(() => {
    if (instant && picked[questions[0].question]?.length && !own[questions[0].question]?.trim()) void send()
  }, [picked])

  return (
    <div className="user-questions" role="group" aria-label={tr('questionsCard.ariaLabel')}>
      <div className="user-questions-head">
        <span className="tally-lamp tally-wait" aria-hidden />
        <strong>{tr('questionsCard.questions', { count: questions.length })}</strong>
        <span className="muted small">{tr('questionsCard.waiting')}</span>
        <span className="spacer" />
        <IconButton icon="close" title={tr('questionsCard.close')} onClick={() => void window.glassbox.session.answerQuestions(tabId, id, null)} />
      </div>
      {questions.map((q) => (
        <div key={q.question} className="user-question">
          <div className="user-question-text">
            {q.header && <span className="user-question-tag">{q.header}</span>}
            {q.question}
          </div>
          <div className="user-question-options" role={q.multiSelect ? 'group' : 'radiogroup'}>
            {q.options.map((o) => {
              const on = (picked[q.question] ?? []).includes(o.label) && !own[q.question]?.trim()
              return (
                <button key={o.label} className={on ? 'user-option on' : 'user-option'} role={q.multiSelect ? 'checkbox' : 'radio'} aria-checked={on} title={o.description} onClick={() => pick(q, o.label)}>
                  {q.multiSelect && <Icon name={on ? 'check' : 'circle-large-outline'} />}
                  <span className="user-option-label">{o.label}</span>
                  {o.description && <span className="user-option-desc">{o.description}</span>}
                </button>
              )
            })}
          </div>
          <input
            className="user-question-own"
            placeholder={tr('questionsCard.ownAnswer')}
            value={own[q.question] ?? ''}
            onChange={(e) => setOwn((p) => ({ ...p, [q.question]: e.target.value }))}
            onKeyDown={(e) => e.key === 'Enter' && void send()}
          />
        </div>
      ))}
      {!instant && (
        <div className="user-questions-foot">
          <span className="muted small">{ready ? tr('questionsCard.allAnswered') : tr('questionsCard.answeredCount', { answered: questions.filter((q) => answerOf(q)).length, total: questions.length })}</span>
          <span className="spacer" />
          <button className="primary" disabled={!ready || sending} onClick={() => void send()}>
            {sending ? tr('questionsCard.sending') : tr('questionsCard.sendAnswers')}
          </button>
        </div>
      )}
    </div>
  )
}
