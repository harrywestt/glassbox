import { app, clipboard, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { tr } from '../shared/i18n'

/**
 * The right-click menu (Windows) / Control-click or two-finger-click menu (macOS). Electron shows
 * nothing by default, so text boxes get the usual edit actions, selected text gets Copy, and links
 * get Open and Copy link. Spelling suggestions come first when the word under the cursor is misspelt.
 */
export function attachContextMenu(win: BrowserWindow) {
  win.webContents.on('context-menu', (_e, p) => {
    const items: MenuItemConstructorOptions[] = []
    const sep = () => items.length && items[items.length - 1].type !== 'separator' && items.push({ type: 'separator' })

    if (p.isEditable && p.misspelledWord) {
      for (const word of p.dictionarySuggestions.slice(0, 5)) items.push({ label: word, click: () => win.webContents.replaceMisspelling(word) })
      if (!p.dictionarySuggestions.length) items.push({ label: tr('mainContextMenu.noSuggestions'), enabled: false })
      items.push({ label: tr('mainContextMenu.addToDictionary'), click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) })
      sep()
    }

    if (p.linkURL) {
      items.push({ label: tr('mainContextMenu.openLink'), click: () => void shell.openExternal(p.linkURL) })
      items.push({ label: tr('mainContextMenu.copyLink'), click: () => clipboard.writeText(p.linkURL) })
      sep()
    }

    if (p.isEditable) {
      const f = p.editFlags
      items.push(
        { role: 'undo', enabled: f.canUndo },
        { role: 'redo', enabled: f.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: f.canCut },
        { role: 'copy', enabled: f.canCopy },
        { role: 'paste', enabled: f.canPaste },
        ...(process.platform === 'darwin' ? [{ role: 'pasteAndMatchStyle', enabled: f.canPaste } as MenuItemConstructorOptions] : []),
        { type: 'separator' },
        { role: 'selectAll', enabled: f.canSelectAll }
      )
    } else if (p.selectionText.trim()) {
      items.push({ role: 'copy' })
    }

    if (items[items.length - 1]?.type === 'separator') items.pop()
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win })
  })
}

/**
 * macOS routes Cmd+C, Cmd+V, Cmd+A and friends through the menu bar, so the app needs an Edit
 * menu for them to work in text boxes. Windows keeps Electron's default (hidden) menu.
 */
export function setMacMenu() {
  if (process.platform !== 'darwin') return
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' }
    ])
  )
}
