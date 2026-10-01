import { deflateSync } from 'node:zlib'
import { Menu, nativeImage, Tray, type MenuItemConstructorOptions, type NativeImage } from 'electron'

export type TrayState = 'working' | 'waiting' | 'needs-you' | 'error' | 'idle'
export type TraySession = { tabId: string; title: string; state: TrayState }

/** Highest first: the tray shows the most urgent state of any session. */
const PRIORITY: TrayState[] = ['needs-you', 'error', 'working', 'waiting', 'idle']

const WORDS: Record<TrayState, string> = {
  'needs-you': 'needs you',
  error: 'error',
  working: 'working',
  waiting: 'waiting',
  idle: 'idle'
}

type Rgb = [number, number, number]
type Style = { color: Rgb; ring: boolean; dot?: boolean }

const STYLES: Record<TrayState, Style> = {
  // The same tally as the app: red working, amber needs you, green done, a hollow ring when idle.
  'needs-you': { color: [0xe5, 0xa5, 0x3c], ring: false },
  error: { color: [0xf0, 0x60, 0x4f], ring: true },
  working: { color: [0xff, 0x4f, 0x3f], ring: false },
  waiting: { color: [0x43, 0xb9, 0x6f], ring: false },
  idle: { color: [0x9a, 0xa1, 0xab], ring: true }
}

// Minimal PNG encoder so icons are generated in code, with no binary assets.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(size: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** Distance from a point to a line segment. */
function segment(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const k = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(x - (ax + dx * k), y - (ay + dy * k))
}

/**
 * The Glassbox mark at tray size (4x4 supersampling), RGBA: grey code brackets holding the tally
 * lamp in the state's colour (a ring when idle).
 */
function drawIcon(size: number, style: Style): Buffer {
  const px = Buffer.alloc(size * size * 4)
  const s = size / 512
  const w = Math.max(1.3, 46 * s) / 2
  // Each bracket as three strokes on the 512 grid (corners rounded by the stroke caps).
  const strokes: [number, number, number, number][] = [
    [196, 118, 150, 118], [130, 140, 130, 372], [150, 394, 196, 394],
    [316, 118, 362, 118], [382, 140, 382, 372], [362, 394, 316, 394]
  ].map(([a, b, c, d]) => [a * s, b * s, c * s, d * s])
  const corners: [number, number][] = [[150, 138], [150, 374], [362, 138], [362, 374]].map(([a, b]) => [a * s, b * s])
  const lx = 256 * s, ly = 256 * s, lr = 54 * s
  const FRAME: [number, number, number] = [0x9a, 0xa1, 0xab]
  const SS = 4
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let fHits = 0, lHits = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const X = x + (sx + 0.5) / SS, Y = y + (sy + 0.5) / SS
          const onStroke = strokes.some(([a, b, c, d]) => segment(X, Y, a, b, c, d) <= w)
          // The rounded corners: a quarter ring of radius 20 (on the 512 grid) around each corner centre.
          const onCorner = corners.some(([cx, cy]) => Math.abs(Math.hypot(X - cx, Y - cy) - 20 * s) <= w && Math.abs(X - cx) <= 20 * s + w && Math.abs(Y - cy) <= 20 * s + w)
          if (onStroke || onCorner) fHits++
          const ld = Math.hypot(X - lx, Y - ly)
          if (ld <= lr && (!style.ring || ld >= lr - Math.max(1, size * 0.06))) lHits++
        }
      }
      const i = (y * size + x) * 4
      const col = lHits > 0 ? style.color : FRAME
      px[i] = col[0]
      px[i + 1] = col[1]
      px[i + 2] = col[2]
      px[i + 3] = Math.round((Math.max(fHits, lHits) / (SS * SS)) * 255)
    }
  }
  return px
}

function buildIcon(state: TrayState): NativeImage {
  const style = STYLES[state]
  const img = nativeImage.createFromBuffer(encodePng(16, drawIcon(16, style)), { scaleFactor: 1 })
  img.addRepresentation({ scaleFactor: 2, buffer: encodePng(32, drawIcon(32, style)) })
  img.addRepresentation({ scaleFactor: 1.5, buffer: encodePng(24, drawIcon(24, style)) })
  return img
}

export function overallState(sessions: TraySession[]): TrayState {
  for (const s of PRIORITY) if (sessions.some((x) => x.state === s)) return s
  return 'idle'
}

function summaryText(sessions: TraySession[]): string {
  if (!sessions.length) return 'no sessions'
  const parts = PRIORITY.map((s) => [s, sessions.filter((x) => x.state === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${WORDS[s]}`)
  return parts.join(', ')
}

/** Windows caps tray tooltips at 127 characters. */
function tooltipText(sessions: TraySession[]): string {
  const lines = [`Glassbox — ${summaryText(sessions)}`]
  if (sessions.length > 1) for (const s of sessions) lines.push(`${s.title}: ${WORDS[s.state]}`)
  let text = lines.join('\n')
  if (text.length > 127) text = text.slice(0, 126) + '…'
  return text
}

// Windows menus treat & as a mnemonic prefix.
const menuLabel = (s: string) => s.replace(/&/g, '&&')

export class StatusTray {
  private tray: Tray
  private icons = new Map<TrayState, NativeImage>()
  private menuIcons = new Map<TrayState, NativeImage>()
  private lastKey = ''
  private lastState?: TrayState

  constructor(private opts: { onOpen: (tabId?: string) => void; onQuit: () => void }) {
    this.tray = new Tray(this.icon('idle'))
    this.tray.on('click', () => this.opts.onOpen())
    this.update([])
  }

  update(sessions: TraySession[]): void {
    if (this.tray.isDestroyed()) return
    const key = JSON.stringify(sessions.map((s) => [s.tabId, s.title, s.state]))
    if (key === this.lastKey) return
    this.lastKey = key
    const state = overallState(sessions)
    if (state !== this.lastState) {
      this.lastState = state
      this.tray.setImage(this.icon(state))
    }
    this.tray.setToolTip(tooltipText(sessions))
    const items: MenuItemConstructorOptions[] = sessions.map((s) => ({
      label: menuLabel(`${s.title} — ${WORDS[s.state]}`),
      icon: this.menuIcon(s.state),
      click: () => this.opts.onOpen(s.tabId)
    }))
    if (items.length) items.push({ type: 'separator' })
    items.push({ label: 'Open Glassbox', click: () => this.opts.onOpen() }, { label: 'Quit', click: () => this.opts.onQuit() })
    this.tray.setContextMenu(Menu.buildFromTemplate(items))
  }

  dispose(): void {
    if (!this.tray.isDestroyed()) this.tray.destroy()
  }

  private icon(state: TrayState): NativeImage {
    let img = this.icons.get(state)
    if (!img) this.icons.set(state, (img = buildIcon(state)))
    return img
  }

  private menuIcon(state: TrayState): NativeImage {
    let img = this.menuIcons.get(state)
    if (!img) this.menuIcons.set(state, (img = this.icon(state).resize({ width: 12, height: 12, quality: 'best' })))
    return img
  }
}
