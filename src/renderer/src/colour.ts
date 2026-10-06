/** Colour helpers for a custom accent: conversions, and keeping it readable on the theme. */

export const isHex = (v: string) => /^#[0-9a-f]{6}$/i.test(v)

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Hue in degrees, saturation and lightness 0–1. */
export function hexToHsl(hex: string): [number, number, number] {
  if (!isHex(hex)) return [210, 0.9, 0.6]
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s, l]
}

export function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

/**
 * The colour you picked, lightened (dark theme) or darkened (light theme) just enough that text in
 * it reads on the background (4.5:1). Hue and strength stay yours.
 */
export function readableOn(hex: string, background: string, base: 'dark' | 'light'): string {
  const [h, s, l0] = hexToHsl(hex)
  let l = l0
  for (let i = 0; i < 40 && contrast(hslToHex(h, s, l), background) < 4.5; i++) l = base === 'dark' ? Math.min(0.95, l + 0.02) : Math.max(0.05, l - 0.02)
  return hslToHex(h, s, l)
}

/** Text on an accent-filled button: whichever of near-black and white reads better. */
export const textOn = (accent: string) => (contrast(accent, '#ffffff') >= contrast(accent, '#0b1524') ? '#ffffff' : '#0b1524')
