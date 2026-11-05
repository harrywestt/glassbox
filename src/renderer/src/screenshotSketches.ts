import { useSyncExternalStore } from 'react'
import type { Sketch } from './session'
import { tr } from '../../shared/i18n'

/**
 * Screenshots you add to Sketches to mark up (pins, arrows, drawings), per session and kept across
 * restarts. Each is a sketch of one version: the picture at its own size, page pixels being image pixels.
 */

const KEY = 'glassbox.screenshotSketches'
type Store = Record<string, Sketch[]>

function load(): Store {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Store
  } catch {
    return {}
  }
}

let store: Store = load()
const listeners = new Set<() => void>()
const NONE: Sketch[] = []
function save(next: Store) {
  store = next
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    /* this run only */
  }
  listeners.forEach((l) => l())
}

export function useScreenshotSketches(tabId: string): Sketch[] {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => store[tabId] ?? NONE
  )
}

/** The sketch Sketches should show next (one just added), taken once. */
let showNext: { tabId: string; id: string } | null = null
export function takeShowNext(tabId: string): string | null {
  if (showNext?.tabId !== tabId) return null
  const id = showNext.id
  showNext = null
  return id
}

const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i
export const isImagePath = (p: string) => IMAGE.test(p)

/** Adds an image file as a screenshot to mark up; resolves with its sketch id, or null when it isn't an image. */
export async function addScreenshot(tabId: string, path: string, title?: string): Promise<string | null> {
  if (!isImagePath(path)) return null
  const size = await window.glassbox.sketch.imageSize(path)
  if (!size) return null
  const at = Date.now()
  const id = `screenshot-${at.toString(36)}`
  const src = encodeURI(`file:///${path.replace(/\\/g, '/').replace(/^\/+/, '')}`)
  const html = `<style>html, body { margin: 0; padding: 0; background: #fff; } img { display: block; }</style><img src="${src}" width="${size.width}" height="${size.height}" alt="">`
  const name = title || tr('screenshotSketches.title', { file: path.split(/[\\/]/).pop() ?? path })
  const sketch: Sketch = { id, title: name, at, screenshot: true, image: path, versions: [{ html, width: Math.max(320, size.width), at, bare: true }] }
  save({ ...store, [tabId]: [...(store[tabId] ?? []), sketch] })
  showNext = { tabId, id }
  return id
}

export function removeScreenshot(tabId: string, id: string) {
  save({ ...store, [tabId]: (store[tabId] ?? []).filter((s) => s.id !== id) })
}
