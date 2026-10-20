import DOMPurify from 'dompurify'
import { marked, type Token, type Tokens } from 'marked'
import mermaid from 'mermaid'
import * as monaco from 'monaco-editor'
import { absPath, mediaKind, mediaUrl } from './lib'
import { monacoTheme } from './monaco'
import type { ThemeTokens } from './theme'

/**
 * A Markdown file as a document (the Markdown viewer): the same Markdown as Claude's replies, plus
 * what a file has that a reply doesn't. YAML front matter becomes a small table, each top-level
 * block carries the source lines it came from (so a selection or a click maps back to the file),
 * and images and links resolve against the file's own folder.
 */

export type MarkdownDoc = { html: string; words: number }

const URI_OK = /^(?:(?:https?|mailto|tel|media|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i
const FRONT = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const lines = (s: string) => (s.match(/\n/g) ?? []).length

/** The file's folder, forward slashes. */
export const folderOf = (path: string) => path.replace(/\\/g, '/').replace(/\/[^/]*$/, '')

export function renderDocument(text: string, dir: string): MarkdownDoc {
  let body = text
  let offset = 0
  let front = ''
  const fm = FRONT.exec(text)
  if (fm) {
    body = text.slice(fm[0].length)
    offset = lines(fm[0])
    const rows = fm[1]
      .split(/\r?\n/)
      .map((l) => /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m && !!m[2])
    if (rows.length) front = `<dl class="md-front" data-line="1" data-end="${offset}">${rows.map((m) => `<dt>${escape(m[1])}</dt><dd>${escape(m[2].replace(/^["']|["']$/g, ''))}</dd>`).join('')}</dl>`
  }

  const tokens = marked.lexer(body)
  marked.walkTokens(tokens, (t) => {
    if (t.type === 'image') {
      const href = String((t as Tokens.Image).href ?? '')
      if (!href || /^(https?:|data:|media:)/i.test(href) || !mediaKind(href)) return
      ;(t as Tokens.Image).href = mediaUrl(absPath(dir, decodeURI(href.replace(/^file:\/\/\/?/i, ''))))
    }
  })

  // Each top-level block rendered on its own, tagged with the lines it came from.
  let line = offset + 1
  const parts: string[] = []
  for (const tok of tokens as Token[]) {
    const span = lines(tok.raw)
    const end = line + Math.max(0, span - (/\n$/.test(tok.raw) ? 1 : 0))
    if (tok.type !== 'space') {
      const one = Object.assign([tok], { links: tokens.links }) as unknown as Parameters<typeof marked.parser>[0]
      const html = marked.parser(one)
      parts.push(html.replace(/^(\s*<[a-z][a-z0-9]*)/i, `$1 data-line="${line}" data-end="${end}"`))
    }
    line += span
  }
  const html = DOMPurify.sanitize(front + parts.join(''), { ALLOWED_URI_REGEXP: URI_OK })
  const words = (body.replace(/```[\s\S]*?```/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length
  return { html, words }
}

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens. */
export function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

const ALERTS: Record<string, string> = { NOTE: 'info', TIP: 'lightbulb', IMPORTANT: 'report', WARNING: 'warning', CAUTION: 'error' }

/**
 * What runs after the HTML is in place: heading anchors, GitHub's [!NOTE] callouts, task lists,
 * code blocks highlighted with the editor's colours (a language label and a copy button on each),
 * and ```mermaid blocks drawn as diagrams. Returns the headings for the outline.
 */
export function enhance(root: HTMLElement, theme: ThemeTokens, labels: { copy: string; copied: string; alert: (kind: string) => string }) {
  const seen = new Map<string, number>()
  const heads: { id: string; text: string; level: number }[] = []
  for (const h of root.querySelectorAll<HTMLElement>('h1, h2, h3, h4')) {
    const base = slug(h.textContent ?? '') || 'section'
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    h.id = n ? `${base}-${n}` : base
    heads.push({ id: h.id, text: h.textContent ?? '', level: Number(h.tagName[1]) })
  }

  for (const q of root.querySelectorAll<HTMLElement>('blockquote')) {
    const p = q.querySelector('p')
    const m = p && /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(p.innerHTML)
    if (!p || !m) continue
    const kind = m[1].toUpperCase()
    p.innerHTML = p.innerHTML.slice(m[0].length).replace(/^<br>\s*/, '')
    if (!p.innerHTML.trim()) p.remove()
    q.classList.add('md-alert', `md-alert-${kind.toLowerCase()}`)
    const title = document.createElement('div')
    title.className = 'md-alert-title'
    title.innerHTML = `<i class="codicon codicon-${ALERTS[kind]}" aria-hidden="true"></i>`
    title.append(labels.alert(kind.toLowerCase()))
    q.prepend(title)
  }

  for (const box of root.querySelectorAll<HTMLInputElement>('li > input[type="checkbox"]:first-child')) {
    box.parentElement!.classList.add('md-task')
    box.closest('ul, ol')?.classList.add('md-tasks')
    box.tabIndex = -1
  }

  const blocks = [...root.querySelectorAll<HTMLElement>('pre > code')]
  let themed = false
  for (const code of blocks) {
    const pre = code.parentElement as HTMLPreElement
    if (pre.dataset.done) continue
    const plain = pre.parentElement
    if (plain?.classList.contains('code-wrap')) {
      plain.before(pre)
      plain.remove()
    }
    pre.dataset.done = '1'
    const lang = (/language-([\w#+.-]+)/.exec(code.className)?.[1] ?? '').toLowerCase()
    const source = code.textContent ?? ''
    if (lang === 'mermaid') {
      void drawMermaid(pre, source, theme)
      continue
    }
    const wrap = document.createElement('div')
    wrap.className = 'md-code'
    pre.replaceWith(wrap)
    wrap.append(pre)
    const head = document.createElement('div')
    head.className = 'md-code-head'
    if (lang) {
      const tag = document.createElement('span')
      tag.textContent = lang
      head.append(tag)
    }
    const copy = document.createElement('button')
    copy.className = 'md-copy'
    copy.title = labels.copy
    copy.setAttribute('aria-label', labels.copy)
    copy.innerHTML = '<i class="codicon codicon-copy" aria-hidden="true"></i>'
    copy.onclick = () => {
      void navigator.clipboard.writeText(source)
      copy.innerHTML = '<i class="codicon codicon-check" aria-hidden="true"></i>'
      copy.title = labels.copied
      setTimeout(() => {
        copy.innerHTML = '<i class="codicon codicon-copy" aria-hidden="true"></i>'
        copy.title = labels.copy
      }, 1400)
    }
    head.append(copy)
    wrap.prepend(head)
    const id = monacoLanguage(lang)
    if (!id) continue
    if (!themed) {
      // Colorize uses the editor theme's token colours: make sure Glassbox's is the one loaded.
      monaco.editor.setTheme(monacoTheme(theme))
      themed = true
    }
    void monaco.editor.colorize(source.replace(/\n$/, ''), id, { tabSize: 2 }).then((html) => {
      if (code.isConnected) code.innerHTML = html
    })
  }
  return heads
}

const ALIASES: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', sh: 'shell', bash: 'shell', zsh: 'shell', console: 'shell', ps: 'powershell', ps1: 'powershell', pwsh: 'powershell', yml: 'yaml', py: 'python', rb: 'ruby', rs: 'rust', cs: 'csharp', 'c#': 'csharp', md: 'markdown', tf: 'hcl', jsonc: 'json', html: 'html', xml: 'xml', dockerfile: 'dockerfile' }

function monacoLanguage(lang: string): string | null {
  if (!lang) return null
  const want = ALIASES[lang] ?? lang
  const all = monaco.languages.getLanguages()
  const hit = all.find((l) => l.id === want) ?? all.find((l) => l.aliases?.some((a) => a.toLowerCase() === want) || l.extensions?.includes(`.${lang}`))
  return hit?.id ?? null
}

let drawn = 0

async function drawMermaid(pre: HTMLElement, source: string, theme: ThemeTokens) {
  const box = document.createElement('figure')
  box.className = 'md-mermaid'
  pre.replaceWith(box)
  try {
    initMermaid(theme)
    const { svg } = await mermaid.render(`md-mermaid-${++drawn}`, source)
    // At its natural size (Mermaid shrinks it to the column, which makes its labels unreadable); wide ones scroll.
    box.innerHTML = svg.replace(/style="max-width:[^"]*"/, '').replace(/width="100%"/, '')
    const el = box.querySelector('svg')
    const view = el?.viewBox.baseVal
    if (el && view?.width) {
      // A little too wide shrinks to fit (labels stay readable); much too wide scrolls sideways.
      const room = box.clientWidth - 34
      const scale = view.width > room && room / view.width >= 0.85 ? room / view.width : 1
      el.setAttribute('width', String(Math.floor(view.width * scale)))
      el.setAttribute('height', String(Math.floor(view.height * scale)))
    }
  } catch (err) {
    // Not a diagram Mermaid understands: show it as the code it is, with why.
    box.className = 'md-mermaid failed'
    box.append(pre)
    const why = document.createElement('figcaption')
    why.textContent = String(err).split('\n')[0]
    box.append(why)
  }
}

/** Glassbox's own colours on Mermaid's classic look (its newer default adds heavy drop shadows). */
export function initMermaid(theme: ThemeTokens) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    fontFamily: 'inherit',
    look: 'classic',
    theme: 'base',
    themeVariables: {
      darkMode: theme.base === 'dark',
      background: theme.bg,
      primaryColor: theme.surface,
      primaryTextColor: theme.fg,
      primaryBorderColor: theme.border,
      secondaryColor: theme.elevated,
      tertiaryColor: theme.surface2,
      lineColor: theme.muted,
      textColor: theme.fg,
      mainBkg: theme.surface,
      nodeBorder: theme.border,
      clusterBkg: theme.surface2,
      clusterBorder: theme.border,
      edgeLabelBackground: theme.bg,
      noteBkgColor: theme.elevated,
      noteTextColor: theme.fg,
      noteBorderColor: theme.border
    }
  })
}
