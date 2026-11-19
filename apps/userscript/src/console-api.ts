import { CONSOLE_PROPERTY } from './page-markers.js'
import { pageWindow } from './page-world.js'

/** The page's `__caelestis` console object. Each module adds its own entries as it installs. */
const api: Record<string, unknown> = {}

/** Expose a diagnostic as `__caelestis.<name>` in the page console. */
export const registerDebugEntry = (name: string, entry: unknown): void => {
  api[name] = entry
}

/** Put `__caelestis` on the page's global; entries registered later appear on it as they arrive. */
export const exposeDebugApi = (): void => {
  try {
    Object.defineProperty(pageWindow(), CONSOLE_PROPERTY, {
      value: api,
      writable: true,
      configurable: true,
    })
  } catch {
    // Debug access is optional; a locked page global must not abort the userscript at document-start.
  }
}
