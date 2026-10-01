/// <reference types="vite/client" />
import type { GlassboxApi } from '../../preload'

declare global {
  interface Window {
    glassbox: GlassboxApi
  }
}
