/**
 * Caelestis's own rows inside Wplace's Settings › Accessibility panel.
 *
 * Wplace's own switches (Legacy UI, Pixelated fonts, Use native OS cursor) live in the same
 * panel; ours are clones of its row so they look native. Each switch maps to an opt-out
 * attribute on `<html>` (`data-caelestis-falsetype="off"`, `data-caelestis-cursors="off"`), so
 * the default-on behaviour needs no JS timing: the matching stylesheet skips while the attribute
 * is present.
 *
 * Wplace's rows are found structurally, not by label text, so the lookup survives its UI
 * translations: the panel's toggle labels that are not ours, in order, are Legacy UI,
 * Pixelated fonts and Use native OS cursor. If fewer than three are there, nothing is injected.
 * A row is disabled under the same conditions as Wplace's own dependencies (Legacy UI's
 * `data-standard-ui`, native cursor's `data-native-cursor`, pixel fonts' `data-pixel-fonts`),
 * and a disabled row shows its effective value, like Wplace's do.
 */

import { log } from './debug.js'
import { CURSORS_ATTRIBUTE } from './wplace-cursors.js'
import { FALSETYPE_ATTRIBUTE } from './wplace-font.js'

const STORAGE_KEY = 'caelestis.wplace-options.v1'
const PANEL_ID = 'settings-panel-accessibility'
const ROW_MARKER = 'data-caelestis-option'

// biome-ignore lint/suspicious/noExplicitAny: userscript-manager APIs exist only in their sandbox
const gm = globalThis as any

interface Prefs {
  falseType: boolean
  cursors: boolean
}

const DEFAULTS: Prefs = { falseType: true, cursors: true }

const readPrefs = (): Prefs => {
  try {
    const raw =
      typeof gm.GM_getValue === 'function'
        ? gm.GM_getValue(STORAGE_KEY, '{}')
        : (globalThis.localStorage?.getItem(STORAGE_KEY) ?? '{}')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULTS }
    const merged = { ...DEFAULTS }
    for (const key of Object.keys(merged) as (keyof Prefs)[]) {
      const value = (parsed as Record<string, unknown>)[key]
      if (typeof value === 'boolean') merged[key] = value
    }
    return merged
  } catch {
    return { ...DEFAULTS }
  }
}

const writePrefs = (prefs: Prefs): void => {
  try {
    const raw = JSON.stringify(prefs)
    if (typeof gm.GM_setValue === 'function') gm.GM_setValue(STORAGE_KEY, raw)
    else globalThis.localStorage?.setItem(STORAGE_KEY, raw)
  } catch {
    // The switch still applies for this session.
  }
}

interface Row {
  /** Prefs key this row reads and writes. */
  readonly key: keyof Prefs
  readonly label: string
  /** Index into the panel's Wplace toggle rows; our row is inserted after it. */
  readonly afterWplaceRow: number
  /** Opt-out attribute set on `<html>` while the pref is off. */
  readonly attribute: string
  /** Extra caption markup inside the label's text span, like Wplace's own hints. */
  readonly hint?: string
  /** Conditions under which the switch has no effect, mirroring Wplace's own dependencies. */
  readonly disabled: (root: HTMLElement) => boolean
}

const ROWS: readonly Row[] = [
  {
    key: 'falseType',
    label: 'FalseType font',
    afterWplaceRow: 1, // directly after Pixelated fonts
    attribute: FALSETYPE_ATTRIBUTE,
    hint: '<span class="text-base-content/80 mt-1 block text-sm leading-relaxed"><a class="link" href="https://github.com/patchstep/FalseType" target="_blank" rel="noopener noreferrer">patchstep/FalseType</a></span>',
    disabled: (root) =>
      root.hasAttribute('data-standard-ui') || root.getAttribute('data-pixel-fonts') === 'false',
  },
  {
    key: 'cursors',
    label: 'Caelestis cursors',
    afterWplaceRow: 2, // directly after Use native OS cursor
    attribute: CURSORS_ATTRIBUTE,
    disabled: (root) =>
      root.hasAttribute('data-standard-ui') || root.hasAttribute('data-native-cursor'),
  },
]

/**
 * Installs Caelestis's rows into Wplace's settings panel and applies the saved opt-out
 * attributes as soon as `<html>` exists. Returns a disposer that disconnects the observer and
 * removes our rows and attributes, for tests.
 */
export const installWplaceSettings = (): (() => void) => {
  const prefs = readPrefs()

  const applyAttributes = (): void => {
    const root = document.documentElement
    if (root === null) return
    for (const row of ROWS) {
      if (prefs[row.key]) root.removeAttribute(row.attribute)
      else root.setAttribute(row.attribute, 'off')
    }
  }

  const ourRow = (key: string): HTMLElement | null =>
    document.getElementById(PANEL_ID)?.querySelector(`label[${ROW_MARKER}="${key}"]`) ?? null

  const syncRows = (): void => {
    const panel = document.getElementById(PANEL_ID)
    const root = document.documentElement
    if (!panel || !root) return

    // Wplace's rows are its toggle labels that are not ours, in order:
    // Legacy UI, Pixelated fonts, Use native OS cursor.
    const wplaceRows = [...panel.querySelectorAll('label')].filter(
      (label) =>
        !label.hasAttribute(ROW_MARKER) &&
        label.querySelector('input.toggle[type="checkbox"]') !== null,
    )
    if (wplaceRows.length < 3) return

    for (const def of ROWS) {
      const anchor = wplaceRows[def.afterWplaceRow]
      if (anchor === undefined) continue
      let row = ourRow(def.key)
      if (row === null) {
        row = anchor.cloneNode(true) as HTMLElement
        row.setAttribute(ROW_MARKER, def.key)
        const text = row.querySelector('.font-medium')
        if (text) {
          text.textContent = def.label
          // Drop anything else in the text span (e.g. a copied hint).
          const span = text.parentElement
          if (span)
            for (const child of [...span.children]) {
              if (child !== text) child.remove()
            }
          if (def.hint) span?.insertAdjacentHTML('beforeend', def.hint)
        }
        const input = row.querySelector('input[type="checkbox"]')
        if (!(input instanceof HTMLInputElement)) continue
        input.addEventListener('change', () => {
          prefs[def.key] = input.checked
          writePrefs(prefs)
          applyAttributes()
          syncRows()
          log('install', `${def.label} ${input.checked ? 'on' : 'off'}`)
        })
        anchor.after(row)
      }
      const input = row.querySelector('input[type="checkbox"]')
      if (!(input instanceof HTMLInputElement)) continue
      const disabled = def.disabled(root)
      input.disabled = disabled
      input.checked = prefs[def.key] && !disabled
      row.classList.toggle('opacity-60', disabled)
    }
  }

  applyAttributes()
  syncRows()

  const observer = new MutationObserver(() => {
    applyAttributes()
    syncRows()
  })
  observer.observe(document, {
    attributes: true,
    attributeFilter: ['data-standard-ui', 'data-pixel-fonts', 'data-native-cursor'],
    childList: true,
    subtree: true,
  })

  return () => {
    observer.disconnect()
    const root = document.documentElement
    for (const row of ROWS) {
      ourRow(row.key)?.remove()
      root?.removeAttribute(row.attribute)
    }
  }
}
