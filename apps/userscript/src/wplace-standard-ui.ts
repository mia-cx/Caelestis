/**
 * Keeps Wplace's standard (non-pixel) UI applied from a saved Caelestis choice.
 *
 * Wplace's `standard` flag is a getter-only derived value, true only on the dashboard routes,
 * with no setter and no setting, so the only way to opt in elsewhere is the `data-standard-ui`
 * attribute its root layout toggles. That layout effect re-runs on every navigation and clears
 * the attribute on non-dashboard pages, so a MutationObserver re-applies it whenever it goes
 * missing while the user has it switched on.
 *
 * The choice is surfaced as a "Standard UI" toggle cloned into Wplace's Accessibility settings
 * panel, directly under "Pixelated fonts". Pixelated fonts is left alone: the attribute already
 * switches `--font-sans` to Geist, and Wplace's icons stay pixel icons either way. Once Wplace
 * ships its own standard-UI option, the toggle steps aside and the attribute stops being forced.
 */

import { log } from './debug.js'

const STORAGE_KEY = 'caelestis.standard-ui.v1'
const ATTRIBUTE = 'data-standard-ui'
const PANEL_ID = 'settings-panel-accessibility'
const WPLACE_SETTINGS_KEY = 'wplace:settings:v1'
const LABEL = 'Standard UI'
const ROW_MARKER = 'data-caelestis-standard-ui'
/** URL paths where Wplace's own `standard` flag is true (the dashboard is standard UI anyway). */
const DASHBOARD_PATH = /^\/dashboard(\/|$)/

// biome-ignore lint/suspicious/noExplicitAny: userscript-manager APIs exist only in their sandbox
const gm = globalThis as any

const readEnabled = (): boolean => {
  try {
    const raw =
      typeof gm.GM_getValue === 'function'
        ? gm.GM_getValue(STORAGE_KEY, '0')
        : (globalThis.localStorage?.getItem(STORAGE_KEY) ?? '0')
    return raw === '1'
  } catch {
    return false
  }
}

const writeEnabled = (enabled: boolean): void => {
  try {
    const raw = enabled ? '1' : '0'
    if (typeof gm.GM_setValue === 'function') gm.GM_setValue(STORAGE_KEY, raw)
    else globalThis.localStorage?.setItem(STORAGE_KEY, raw)
  } catch {
    // The switch still applies for this session.
  }
}

/** Wplace offering its own standard-UI setting, detected from its stored settings keys. */
const wplaceSettingsOfferStandard = (): boolean => {
  try {
    const raw = globalThis.localStorage?.getItem(WPLACE_SETTINGS_KEY)
    if (!raw) return false
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return false
    return Object.keys(parsed).some((key) => /standard/i.test(key))
  } catch {
    return false
  }
}

/**
 * Installs the saved Standard UI choice and the settings toggle. Applies the attribute
 * immediately when `<html>` exists, or as soon as it is inserted at document-start, so it is
 * set before first paint. Then watches for Wplace's layout effect clearing it and for the
 * settings panel opening. Returns a disposer that disconnects the observer and removes our
 * row, for tests.
 */
export const installStandardUi = (): (() => void) => {
  let enabled = readEnabled()
  let native = wplaceSettingsOfferStandard()

  const apply = (): void => {
    const root = document.documentElement
    if (root === null) return
    if (enabled && !native && !root.hasAttribute(ATTRIBUTE)) root.setAttribute(ATTRIBUTE, '')
  }

  const ourRow = (): HTMLElement | null =>
    document.getElementById(PANEL_ID)?.querySelector(`label[${ROW_MARKER}]`) ?? null

  const syncToggle = (): void => {
    const panel = document.getElementById(PANEL_ID)
    if (!panel) return

    // A native option for standard UI: any toggle row that is not ours mentioning "standard".
    const nativeLabel =
      native ||
      [...panel.querySelectorAll('label')].some(
        (label) => !label.hasAttribute(ROW_MARKER) && /standard/i.test(label.textContent ?? ''),
      )
    if (nativeLabel) {
      ourRow()?.remove()
      native = true
      return
    }

    if (ourRow()) return

    // Clone Wplace's "Pixelated fonts" row so the toggle looks native in both themes.
    const anchor = panel.querySelector('input.toggle[type="checkbox"]')?.closest('label')
    if (!(anchor instanceof HTMLElement)) return
    const row = anchor.cloneNode(true) as HTMLElement
    row.setAttribute(ROW_MARKER, '')
    const text = row.querySelector('.font-medium')
    if (text) {
      text.textContent = LABEL
      // Drop anything else in the text span (e.g. a future hint) that cloning copied.
      const span = text.parentElement
      if (span)
        for (const child of [...span.children]) {
          if (child !== text) child.remove()
        }
    }
    const input = row.querySelector('input[type="checkbox"]')
    if (!(input instanceof HTMLInputElement)) return
    input.checked = enabled
    input.addEventListener('change', () => {
      enabled = input.checked
      writeEnabled(enabled)
      if (enabled) apply()
      else if (!DASHBOARD_PATH.test(location.pathname))
        document.documentElement?.removeAttribute(ATTRIBUTE)
      log('install', `standard UI ${enabled ? 'on' : 'off'}`)
    })
    anchor.after(row)
  }

  apply()
  syncToggle()

  const observer = new MutationObserver(() => {
    apply()
    syncToggle()
  })
  // Observing `document` (not `<html>`, which can still be null at document-start) also
  // catches the element being inserted, so apply() runs as soon as there is a root.
  observer.observe(document, {
    attributes: true,
    attributeFilter: [ATTRIBUTE],
    childList: true,
    subtree: true,
  })

  return () => {
    observer.disconnect()
    ourRow()?.remove()
  }
}
