import { useLayoutEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useSession } from '../views/SessionView'
import { Icon } from '../components/ui'
import { tr } from '../../../shared/i18n'

/**
 * Your own shell in the session's folder, for commands you'd rather run yourself. Each session has
 * one; it keeps running (and keeps its scrollback) while you switch tabs, and closes with the session.
 */

type Shell = { term: Terminal; fit: FitAddon; host: HTMLDivElement; pty?: string; exited?: number; opening?: boolean }
const shells = new Map<string, Shell>()

// One listener for every terminal's output, routed by id.
let listening = false
function listen() {
  if (listening) return
  listening = true
  window.glassbox.terminal.onData(({ id, data, exit }) => {
    for (const sh of shells.values()) {
      if (sh.pty !== id) continue
      if (data) sh.term.write(data)
      if (exit !== undefined) {
        sh.exited = exit
        sh.term.write(`\r\n\x1b[2m${tr('terminalTab.exited', { code: exit ?? '?' })}\x1b[0m\r\n`)
      }
    }
  })
}

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
const theme = () => ({
  background: cssVar('--bg'),
  foreground: cssVar('--fg'),
  cursor: cssVar('--accent'),
  cursorAccent: cssVar('--bg'),
  selectionBackground: cssVar('--selection') || cssVar('--elevated')
})

export function TerminalTab() {
  const { tab, composerRef } = useSession()
  const box = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState('')
  const [, rerender] = useState(0)

  const start = async (sh: Shell) => {
    if (sh.opening) return
    sh.opening = true
    sh.exited = undefined
    try {
      sh.pty = await window.glassbox.terminal.open(tab.id, tab.cwd, sh.term.cols, sh.term.rows)
    } catch (e) {
      sh.term.write(`\x1b[31m${tr('terminalTab.couldntStart', { error: String(e) })}\x1b[0m\r\n`)
    } finally {
      sh.opening = false
      rerender((n) => n + 1)
    }
  }

  useLayoutEffect(() => {
    listen()
    let sh = shells.get(tab.id)
    if (!sh) {
      const host = document.createElement('div')
      host.className = 'terminal-host'
      const term = new Terminal({ fontFamily: "'IBM Plex Mono', Consolas, monospace", fontSize: 13, lineHeight: 1.25, cursorBlink: true, scrollback: 5000, theme: theme(), allowProposedApi: false })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(host)
      sh = { term, fit, host }
      shells.set(tab.id, sh)
      const s = sh
      term.onData((d) => {
        // After the shell exits, Enter starts a new one.
        if (s.exited !== undefined) {
          if (d === '\r') void start(s)
          return
        }
        if (s.pty) window.glassbox.terminal.write(s.pty, d)
      })
      term.onResize(({ cols, rows }) => s.pty && window.glassbox.terminal.resize(s.pty, cols, rows))
      term.onSelectionChange(() => setSelection(term.getSelection()))
      // Ctrl+C copies when there's a selection (otherwise it interrupts, as usual); Ctrl+V pastes.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && term.hasSelection()) {
          void navigator.clipboard.writeText(term.getSelection())
          return false
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
          void navigator.clipboard.readText().then((t) => s.pty && window.glassbox.terminal.write(s.pty, t))
          return false
        }
        return true
      })
    }
    box.current?.appendChild(sh.host)
    sh.term.options.theme = theme()
    const fitNow = () => {
      try {
        sh!.fit.fit()
      } catch {
        /* not laid out yet */
      }
    }
    fitNow()
    if (!sh.pty && !sh.opening) void start(sh)
    sh.term.focus()
    const ro = new ResizeObserver(fitNow)
    if (box.current) ro.observe(box.current)
    return () => {
      ro.disconnect()
      sh!.host.remove()
    }
  }, [tab.id])

  const sh = shells.get(tab.id)
  return (
    <div className="work-page terminal-page">
      <div className="work-bar">
        <Icon name="terminal" className="muted" />
        <span className="small muted ellipsis grow" title={tab.cwd}>
          {tr('terminalTab.shellIn', { cwd: tab.cwd })}
        </span>
        <button className="chip-btn" disabled={!selection.trim()} onClick={() => composerRef.current?.insert(`\n\`\`\`\n${selection.trim()}\n\`\`\`\n`)} title={tr('terminalTab.sendSelectionTip')}>
          <Icon name="comment" /> {tr('terminalTab.sendSelection')}
        </button>
        <button className="chip-btn" onClick={() => sh?.term.clear()} title={tr('terminalTab.clearTip')}>
          <Icon name="clear-all" /> {tr('terminalTab.clear')}
        </button>
        <button
          className="chip-btn"
          onClick={() => {
            if (!sh) return
            if (sh.pty) void window.glassbox.terminal.close(sh.pty)
            sh.pty = undefined
            sh.term.reset()
            void start(sh)
          }}
          title={tr('terminalTab.newShellTip')}
        >
          <Icon name="refresh" /> {tr('terminalTab.newShell')}
        </button>
      </div>
      <div className="work-body terminal-body" ref={box} />
    </div>
  )
}

/** A session closed: its terminal goes too. */
export function disposeTerminal(tabId: string) {
  const sh = shells.get(tabId)
  if (!sh) return
  if (sh.pty) void window.glassbox.terminal.close(sh.pty)
  sh.term.dispose()
  shells.delete(tabId)
}
