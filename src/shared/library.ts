/**
 * A project's component library and the screens built from it (see main/library.ts): kept by
 * Glassbox per repo, outside the project.
 */

export type LibraryKind = 'components' | 'screens'

/**
 * A copy of one of the app's components as HTML and CSS (its own <style> inside), drawn in the
 * project's colours. A shell is the app's frame (header, sidebar, padding) with the element where
 * a screen's content goes marked data-slot. An icon is one of the app's own icons, as an inline SVG
 * drawn in currentColor.
 */
export type LibraryComponent = {
  id: string
  name: string
  kind: 'component' | 'shell' | 'icon'
  html: string
  /** Other looks of it (secondary, disabled…), each its own HTML. */
  variants?: { name: string; html: string }[]
  /** The source file it copies, relative to the project. */
  source?: string
  /** A fingerprint of that file when it was saved, to notice when it changes. */
  sourceHash?: string
  /** How code uses it, e.g. import { Button } from '@/components/Button'. */
  usage?: string
  /** The width it's usually drawn at (a shell: the app's width). */
  width?: number
  /** A shell's height. */
  height?: number
  at: number
}

/** A component (or a built-in icon) placed on a screen, at a spot in its content area (px). */
export type ScreenItem = {
  id: string
  /** The library component's id ('' for a built-in icon). */
  component: string
  /** A built-in icon's name (codicons), instead of a component. */
  icon?: string
  /** Its colour: a project colour's name (accent, ok, warn, err, info, fg, muted) or a #hex. A component's accent and text take it. */
  color?: string
  variant?: string
  x: number
  y: number
  /** Its width, when you resized it (otherwise its own). */
  w?: number
  /** Words you changed in it: by the path to the element inside it (child indexes), the new text. */
  text?: Record<string, string>
  /** A shape you drew instead of a component. */
  shape?: 'rect' | 'ellipse' | 'line'
  /** A text box you added instead of a component: its words, size and weight. */
  textBox?: string
  fontSize?: number
  bold?: boolean
  /** An image you added: its file. */
  image?: string
  /** Its height, when you resized it (otherwise its own). */
  h?: number
  /** Corner rounding (px) and opacity (0 to 1). */
  radius?: number
  opacity?: number
  /** Left out of the screen (still in the layers list), or kept from being moved. */
  hidden?: boolean
  locked?: boolean
  /** Your name for it in the layers list. */
  name?: string
  /** Things grouped together share this, and select and move as one. */
  group?: string
}

/** A screen you're building: a frame (blank, or the app's shell) with components placed on it. */
export type LibraryScreen = {
  id: string
  name: string
  frame: { kind: 'blank'; width: number; height: number } | { kind: 'shell'; shell: string; width: number; height: number }
  items: ScreenItem[]
  at: number
}
