import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { loader } from '@monaco-editor/react'

// Bundle Monaco locally instead of @monaco-editor/react's default CDN load.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
loader.config({ monaco })

const LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', md: 'markdown', py: 'python', cs: 'csharp', go: 'go', rs: 'rust', java: 'java', rb: 'ruby',
  php: 'php', sql: 'sql', yml: 'yaml', yaml: 'yaml', html: 'html', css: 'css', scss: 'scss', sh: 'shell',
  ps1: 'powershell', tf: 'hcl', xml: 'xml', toml: 'ini', ini: 'ini', dockerfile: 'dockerfile'
}

export function languageFor(path: string): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (name === 'dockerfile') return 'dockerfile'
  return LANGUAGES[name.split('.').pop() ?? ''] ?? 'plaintext'
}

/** `#rrggbb` with an alpha, as Monaco's theme colours want (#rrggbbaa). */
const alpha = (hex: string, a: number) => (/^#[0-9a-f]{6}$/i.test(hex) ? hex + Math.round(a * 255).toString(16).padStart(2, '0') : hex)

/**
 * Code and diff views in Glassbox's own colours rather than Monaco's stock VS Code theme: the
 * monitor's screen colour behind the code, bezel hairlines, and diff lines tinted 12% green and red
 * like the inline edit cards. Returns the theme's name (one per palette, defined once).
 */
export function monacoTheme(t: import('./theme').ThemeTokens): string {
  const name = `glassbox-${t.base}-${(t.bg + t.accent + t.ok + t.err).replace(/#/g, '')}`
  if (defined.has(name)) return name
  defined.add(name)
  monaco.editor.defineTheme(name, {
    base: t.base === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': t.bg,
      'editor.foreground': t.fg,
      'editorGutter.background': t.bg,
      'editorLineNumber.foreground': t.subtle,
      'editorLineNumber.activeForeground': t.muted,
      'editor.lineHighlightBackground': alpha(t.fg, 0.03),
      'editor.lineHighlightBorder': alpha(t.fg, 0),
      'editor.selectionBackground': t.selection,
      'editor.inactiveSelectionBackground': t.selection,
      'editorCursor.foreground': t.accent,
      'editorWidget.background': t.elevated,
      'editorWidget.border': t.border,
      'editorHoverWidget.background': t.elevated,
      'editorHoverWidget.border': t.border,
      'scrollbarSlider.background': alpha(t.fg, 0.12),
      'scrollbarSlider.hoverBackground': alpha(t.fg, 0.2),
      'scrollbarSlider.activeBackground': alpha(t.fg, 0.26),
      'editorOverviewRuler.border': alpha(t.border, 0),
      'diffEditor.insertedLineBackground': alpha(t.ok, 0.12),
      'diffEditor.removedLineBackground': alpha(t.err, 0.12),
      'diffEditor.insertedTextBackground': alpha(t.ok, 0.22),
      'diffEditor.removedTextBackground': alpha(t.err, 0.22),
      'diffEditorGutter.insertedLineBackground': alpha(t.ok, 0.16),
      'diffEditorGutter.removedLineBackground': alpha(t.err, 0.16),
      'diffEditor.border': t.border,
      'diffEditor.diagonalFill': alpha(t.border, 0.7),
      'diffEditor.unchangedRegionBackground': t.surface,
      'diffEditor.unchangedRegionForeground': t.muted
    }
  })
  return name
}
const defined = new Set<string>()
