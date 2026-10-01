import { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useSession } from '../views/SessionView'
import { baseName, mediaUrl } from '../lib'
import { fileKind, filesToPaths, KIND_ICON, withAttachments } from '../attachments'
import { Icon } from '../components/ui'
import { AskDock, answerTargets, useAnswerAll, usePendingAsks } from './AskDock'
import { useVoice } from '../voice'
import { Loaders } from './Loaders'

const MARK_LABEL = { read: 'must read', edit: 'must edit', avoid: "don't touch", ask: 'ask first', api: 'public API only' } as const
const MARK_ICON = { read: 'eye', edit: 'edit', avoid: 'lock', ask: 'question', api: 'shield' } as const

/** How long Space must be held before it starts recording rather than typing a space. */
const HOLD_MS = 200

export function Composer({ compact }: { compact?: boolean } = {}) {
  const { s, tab, actions, send, composerRef, updateRequirements, markFile, showPanel, planFirst, setPlanFirst, everyday, openAttachment } = useSession()
  const [text, setText] = useState('')
  // Files going with the next message: picked, dropped on the window, or pasted.
  const [attached, setAttached] = useState<string[]>([])
  const attach = (paths: string[]) => {
    setAttached((a) => [...a, ...paths.filter((p) => !a.includes(p))])
    area.current?.focus()
  }
  const [error, setError] = useState<string | null>(null)
  const [pick, setPick] = useState(0)
  // Starting with ! runs a shell command instead of sending a message (as in the CLI).
  const shellMode = text.trimStart().startsWith('!')
  const area = useRef<HTMLTextAreaElement>(null)
  const voice = useVoice()
  // Where the transcript goes: the caret position when recording started.
  const insertAt = useRef<number | null>(null)

  const startVoice = () => {
    insertAt.current = area.current?.selectionStart ?? null
    void voice.start()
  }
  const finishVoice = async () => {
    const said = await voice.stop()
    if (!said) return
    setText((t) => {
      const at = Math.min(insertAt.current ?? t.length, t.length)
      const before = t.slice(0, at)
      const after = t.slice(at)
      const gap = before && !/\s$/.test(before) ? ' ' : ''
      return before + gap + said + (after && !/^\s/.test(after) ? ' ' : '') + after
    })
    area.current?.focus()
  }

  // Hold Space to talk, like the Claude CLI: a tap types a space; holding it past HOLD_MS records
  // until you let go. Timed here rather than waiting for the keyboard's own repeat, which Windows
  // delays by half a second or more. Works in the message box, or anywhere in the session that
  // isn't a text field.
  const voiceRef = useRef({ voice, startVoice, finishVoice })
  voiceRef.current = { voice, startVoice, finishVoice }
  useEffect(() => {
    const typing = (el: Element | null) => !!el && el !== area.current && (el.matches('input, textarea, select, [contenteditable="true"]') || !!el.closest('.monaco-editor'))
    let hold: ReturnType<typeof setTimeout> | null = null
    let recording = false
    const begin = (inBox: boolean) => {
      hold = null
      const { voice, startVoice } = voiceRef.current
      const el = area.current
      if (!el || voice.state !== 'idle') return
      recording = true
      // The press typed a space; take it back.
      if (inBox && el.selectionStart === el.selectionEnd && el.value[el.selectionStart - 1] === ' ') {
        const at = el.selectionStart - 1
        setText(el.value.slice(0, at) + el.value.slice(at + 1))
        requestAnimationFrame(() => el.setSelectionRange(at, at))
        insertAt.current = at
        void voice.start()
      } else startVoice()
    }
    const onDown = (e: KeyboardEvent) => {
      const { voice } = voiceRef.current
      if (!area.current || area.current.offsetParent === null) return // another tab is showing
      if ((voice.state === 'listening' || voice.state === 'starting') && e.key === 'Escape') return e.preventDefault(), (recording = false), voice.cancel()
      if (e.key !== ' ' || e.ctrlKey || e.altKey || e.metaKey || typing(document.activeElement)) return
      const inBox = document.activeElement === area.current
      if (e.repeat) {
        // Held: no more spaces (the timer, or the recording, has it).
        if (hold || recording) e.preventDefault()
        return
      }
      if (!inBox) e.preventDefault() // don't scroll the page
      if (voice.state !== 'idle' || hold) return
      hold = setTimeout(() => begin(inBox), HOLD_MS)
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.key !== ' ') return
      if (hold) {
        // A tap: the space it typed stays.
        clearTimeout(hold)
        hold = null
        return
      }
      if (recording) {
        recording = false
        e.preventDefault()
        void voiceRef.current.finishVoice()
      }
    }
    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)
    return () => {
      if (hold) clearTimeout(hold)
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
    }
  }, [])

  useImperativeHandle(composerRef, () => ({
    insert(value: string) {
      setText((t) => (t ? `${t} ${value}` : value))
      area.current?.focus()
    },
    attach
  }))

  // Slash-command autocomplete while typing the first word.
  const suggestions = useMemo(() => {
    const m = text.match(/^\/(\S*)$/)
    if (!m) return []
    const q = m[1].toLowerCase()
    return s.commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8)
  }, [text, s.commands])

  const canSend = s.status === 'ready' || s.status === 'running'

  // Claude's guess at your next message, shown while the box is empty and Claude is waiting.
  // While Claude is waiting on an answer, the message box answers it (unless you switch that off).
  const asks = usePendingAsks()
  const answerAll = useAnswerAll()
  const [askIndex, setAskIndex] = useState(0)
  const [answering, setAnswering] = useState(true)
  const askKey = asks.map((a) => a.id).join('|')
  useEffect(() => {
    setAskIndex((i) => Math.min(i, Math.max(0, asks.length - 1)))
    if (asks.length) setAnswering(true)
  }, [askKey])
  const currentAsk = answering ? asks[askIndex] : undefined
  // A message typed while several questions are open answers all of them (one while paused on a check-in).
  const targets = !currentAsk ? [] : currentAsk.kind === 'checkin' || answerTargets(asks).length < 2 ? [currentAsk] : answerTargets(asks)

  const predicted = !text && s.status === 'ready' && voice.state === 'idle' && !currentAsk ? s.suggestion : undefined

  const submit = () => sendPrompt(text)
  const stop = () => void window.glassbox.session.interrupt(tab.id)

  const sendPrompt = async (value: string) => {
    // "! command": run it yourself in this folder, like the CLI. It isn't a message; Claude sees the
    // command and its output with the next one you send.
    if (value.trimStart().startsWith('!')) {
      const command = value.trimStart().slice(1).trim()
      if (!command) return
      setText('')
      window.dispatchEvent(new CustomEvent('glassbox:to-latest', { detail: tab.id }))
      actions.runShell(tab.id, tab.cwd, command)
      return
    }
    const files = attached
    const prompt = withAttachments(value.trim(), files)
    if ((!value.trim() && !files.length) || !canSend) return
    setText('')
    setAttached([])
    setError(null)
    // Whatever you'd scrolled up to, sending takes the conversation back to the bottom.
    window.dispatchEvent(new CustomEvent('glassbox:to-latest', { detail: tab.id }))
    try {
      if (targets.length) await answerAll(targets, prompt)
      else if (planFirst) {
        await actions.send(tab.id, prompt, undefined, { plan: true })
        setPlanFirst(false)
      } else await send(prompt)
    } catch (err) {
      setError(String(err))
    }
  }

  const complete = (name: string) => {
    setText(`/${name} `)
    setPick(0)
    area.current?.focus()
  }

  const req = s.requirements
  const hasReq = req.files.length || req.connectors.length || req.skills.length

  return (
    <div className="composer">
      <Loaders />
      <AskDock asks={asks} index={askIndex} onIndex={setAskIndex} answering={answering} onAnswering={setAnswering} compact={compact} />
      {hasReq ? (
        <div className="req-chips" title="Attached to every message you send in this session">
          <span className="muted small">
            <Icon name="pinned" /> Attached:
          </span>
          {req.files.map((f) => (
            <span key={f.path} className={`req-chip mark-${f.mark}`} title={`${f.path} (${MARK_LABEL[f.mark]})`}>
              <Icon name={MARK_ICON[f.mark]} /> {baseName(f.path)}
              <button onClick={() => markFile(f.path, null)} aria-label="Remove"><Icon name="close" /></button>
            </span>
          ))}
          {req.connectors.map((c) => (
            <span key={c} className="req-chip" title="Required connector">
              <Icon name="plug" /> {c.replace(/^claude\.ai /, '')}
              <button onClick={() => updateRequirements((r) => ({ ...r, connectors: r.connectors.filter((x) => x !== c) }))} aria-label="Remove"><Icon name="close" /></button>
            </span>
          ))}
          {req.skills.map((k) => (
            <span key={k} className="req-chip" title="Preferred skill">
              <Icon name="sparkle" /> /{k}
              <button onClick={() => updateRequirements((r) => ({ ...r, skills: r.skills.filter((x) => x !== k) }))} aria-label="Remove"><Icon name="close" /></button>
            </span>
          ))}
        </div>
      ) : null}
      {error && <div className="note note-error">{error}</div>}
      {voice.error && (
        <div className="note note-error">
          {voice.error} <button className="link" onClick={voice.clearError}>Dismiss</button>
        </div>
      )}
      <div className={`composer-box${voice.state === 'listening' || voice.state === 'starting' ? ' listening' : ''}${shellMode ? ' shell' : ''}`}>
        {shellMode && (
          <div className="shell-hint">
            <Icon name="terminal" /> Shell command. Runs in {baseName(tab.cwd)} when you press Enter; Claude sees the output with your next message.
          </div>
        )}
        {attached.length > 0 && (
          <div className="composer-files">
            {attached.map((p) => (
              <span key={p} className="composer-file" title={p}>
                {fileKind(p) === 'image' ? (
                  <button className="composer-file-thumb checker" onClick={() => openAttachment(p)} aria-label={`Open ${baseName(p)}`}>
                    <img src={mediaUrl(p)} alt="" />
                  </button>
                ) : (
                  <Icon name={KIND_ICON[fileKind(p)]} />
                )}
                <span className="ellipsis">{baseName(p)}</span>
                <button className="icon-btn" onClick={() => setAttached((a) => a.filter((x) => x !== p))} aria-label={`Remove ${baseName(p)}`} title="Remove">
                  <Icon name="close" />
                </button>
              </span>
            ))}
          </div>
        )}
        {voice.state !== 'idle' && (
          <div className="voice-bar" role="status">
            {voice.state === 'starting' ? (
              <>
                <Icon name="loading" className="codicon-modifier-spin" />
                <span>Starting the microphone…</span>
              </>
            ) : voice.state === 'listening' ? (
              <>
                <span className="voice-dot" />
                <span className="voice-meter" aria-hidden>
                  {[0.5, 0.8, 1, 0.8, 0.5].map((w, i) => (
                    <span key={i} style={{ transform: `scaleY(${0.15 + voice.level * w})` }} />
                  ))}
                </span>
                <span>Listening. Let go of Space to finish, Esc to cancel</span>
              </>
            ) : (
              <>
                <Icon name="loading" className="codicon-modifier-spin" />
                <span>
                  {voice.model?.status === 'downloading'
                    ? `Downloading the speech model, one time only (${voice.model.progress ?? 0}%)`
                    : 'Transcribing…'}
                </span>
              </>
            )}
          </div>
        )}
        {suggestions.length > 0 && (
          <div className="suggest">
            {suggestions.map((c, i) => (
              <div key={c.name} className={i === pick ? 'suggest-item active' : 'suggest-item'} onMouseDown={(e) => (e.preventDefault(), complete(c.name))}>
                <span className="mono">/{c.name}</span>
                {c.argumentHint && <span className="muted mono small"> {c.argumentHint}</span>}
                <span className="suggest-desc">{c.description}</span>
              </div>
            ))}
          </div>
        )}
        {predicted && (
          <span className="predicted-hint small" aria-hidden>
            <kbd>Tab</kbd> send · <kbd>→</kbd> edit
          </span>
        )}
        <textarea
          ref={area}
          value={text}
          rows={currentAsk ? 1 : 3}
          className={predicted ? 'has-prediction' : undefined}
          placeholder={currentAsk ? (targets.length > 1 ? `Answer the ${targets.length} questions` : 'Type an answer') : predicted ?? (canSend ? 'Message Claude' : 'Starting session…')}
          onChange={(e) => {
            setText(e.target.value)
            setPick(0)
          }}
          // Pasting a screenshot or a copied file attaches it (text pastes as text, as usual).
          onPaste={(e) => {
            const files = [...e.clipboardData.files]
            if (!files.length || e.clipboardData.getData('text/plain')) return
            e.preventDefault()
            void filesToPaths(files).then(attach, (err) => setError(String(err)))
          }}
          onKeyDown={(e) => {
            if (suggestions.length) {
              if (e.key === 'ArrowDown') return e.preventDefault(), setPick((p) => (p + 1) % suggestions.length)
              if (e.key === 'ArrowUp') return e.preventDefault(), setPick((p) => (p - 1 + suggestions.length) % suggestions.length)
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) return e.preventDefault(), complete(suggestions[pick].name)
            }
            // Esc stops Claude, like the CLI (voice recording handles its own Esc first).
            if (e.key === 'Escape' && s.status === 'running' && voice.state === 'idle') return e.preventDefault(), stop()
            // The predicted next message: Tab sends it as is, → puts it in the box to edit first.
            if (predicted && e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey) return e.preventDefault(), void sendPrompt(predicted)
            if (predicted && e.key === 'ArrowRight') return e.preventDefault(), setText(predicted)
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        <div className="composer-actions">
          <button className="icon-btn" title="Attach files (or drop them anywhere on the window, or paste a screenshot)" aria-label="Attach files" onClick={() => void window.glassbox.attachments.pick().then((p) => p.length && attach(p))}>
            <Icon name="attach" />
          </button>
          {!everyday && (
            <button className="icon-btn" title="Mark project files Claude must read, edit or leave alone" onClick={() => showPanel('explorer')}>
              <Icon name="files" />
            </button>
          )}
          <button className="icon-btn" title="Skills" onClick={() => showPanel('skills')}>
            <Icon name="library" />
          </button>
          <button
            className={planFirst ? 'chip-btn on' : 'chip-btn'}
            title="Claude proposes a plan and waits for your approval before changing anything"
            onClick={() => setPlanFirst(!planFirst)}
          >
            <Icon name="checklist" /> Plan first
          </button>
          {s.mode === 'plan' && (
            <span className="muted small">
              Planning, no edits until you approve.{' '}
              {s.status === 'ready' && (
                <button className="link" onClick={() => void window.glassbox.session.exitPlan(tab.id)}>
                  Exit plan mode
                </button>
              )}
            </span>
          )}
          <span className="spacer" />
          <button
            className={voice.state === 'listening' || voice.state === 'starting' ? 'icon-btn mic on' : 'icon-btn mic'}
            title={voice.state === 'listening' || voice.state === 'starting' ? 'Stop and transcribe' : 'Speak to Claude (or hold Space). Transcribed on this machine'}
            disabled={voice.state === 'transcribing'}
            onClick={() => (voice.state === 'listening' || voice.state === 'starting' ? void finishVoice() : startVoice())}
          >
            <Icon name={voice.state === 'listening' || voice.state === 'starting' ? 'debug-stop' : 'mic'} />
          </button>
          {s.status === 'running' && text.trim() && <span className="hint">Sends when Claude finishes this step</span>}
          {/* While Claude works and the box is empty, Send becomes Stop; typing turns it back into Send (queued). */}
          {s.status === 'running' && !text.trim() ? (
            <button className="send stop" onClick={stop} title="Stop Claude (Esc)" aria-label="Stop Claude">
              <span className="stop-square" />
            </button>
          ) : (
            <button className="primary send" disabled={!canSend || (!text.trim() && !attached.length)} onClick={() => void submit()} title="Send">
              <Icon name="send" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
