/**
 * Keeps Wplace's standard (non-pixel) UI applied from a saved Caelestis choice.
 *
 * Wplace's `standard` flag is a getter-only derived value, true only on the dashboard routes,
 * with no setter and no setting, so the only way to opt in elsewhere is the `data-standard-ui`
 * attribute its root layout toggles. That layout effect re-runs on every navigation and clears
 * the attribute on non-dashboard pages, so a MutationObserver re-applies it whenever it goes
 * missing while the user has it switched on.
 *
 * The choice is surfaced as a "Pixelated UI" switch cloned into Wplace's Accessibility settings
 * panel, directly above "Pixelated fonts". It is checked by default (Wplace's look anyway) and
 * switching it off applies the standard UI. Pixelated fonts is left alone: the attribute already
 * switches `--font-sans` to Geist. Cursors follow instantly through the keyword fallbacks of
 * Wplace's own `--cursor-*` properties; icons are Wplace's own Material Symbols, reached by
 * widening its `standard` getter from the page world, so they follow on the next load or route
 * change. Once Wplace ships its own option for this, the switch steps aside and the attribute
 * stops being forced.
 */

import { log } from './debug.js'

const STORAGE_KEY = 'caelestis.standard-ui.v1'
const ATTRIBUTE = 'data-standard-ui'
const PANEL_ID = 'settings-panel-accessibility'
const WPLACE_SETTINGS_KEY = 'wplace:settings:v1'
const LABEL = 'Pixelated UI'
const ROW_MARKER = 'data-caelestis-standard-ui'
/** URL paths where Wplace's own `standard` flag is true (the dashboard is standard UI anyway). */
const DASHBOARD_PATH = /^\/dashboard(\/|$)/
/** Wplace's own version of this switch, however named ("Standard UI", "Pixelated style", ...). */
const NATIVE_LABEL = /standard|pixel\w*\s+(ui|interface|style)/i
/** The same, for keys inside `wplace:settings:v1` ("standardUi", "pixelUi", ...). */
const NATIVE_SETTINGS_KEY = /standard|pixel(ated)?ui/i

/**
 * Wplace's `--cursor-*` custom properties (key = the suffix after `--cursor-`), each mapped to
 * the browser cursor keyword Wplace's own pixel-art SVG falls back to. Under standard UI the
 * pixel art is out of place, so the custom property is set straight to the keyword and the
 * derived aliases (`--cursor-pencil`, `--cursor-auto`, `--cursor-col-resize`) follow along.
 */
const CURSOR_KEYWORDS = {
  default: 'default',
  pointer: 'pointer',
  crosshair: 'crosshair',
  grab: 'grab',
  grabbing: 'grabbing',
  move: 'move',
  text: 'text',
  'not-allowed': 'not-allowed',
  wait: 'wait',
  help: 'help',
  copy: 'copy',
  'zoom-in': 'zoom-in',
  'zoom-out': 'zoom-out',
  'ew-resize': 'ew-resize',
  'ns-resize': 'ns-resize',
  'nesw-resize': 'nesw-resize',
  'nwse-resize': 'nwse-resize',
  eraser: 'crosshair',
  'color-picker': 'crosshair',
} as const

/**
 * Marks `<html>` while the saved choice is standard UI. Wplace never touches it: it bridges to
 * the page world, where the widened `standard` getter reads it to render Material Symbols.
 */
const FORCE_ATTRIBUTE = 'data-caelestis-standard'
const CURSOR_STYLE_ID = 'caelestis-standard-ui-cursors'
// `html:root` outranks Wplace's `:root[data-theme=dark]`, where the pixel cursors are defined.
const CURSOR_CSS = `html:root[${ATTRIBUTE}]{${Object.entries(CURSOR_KEYWORDS)
  .map(([suffix, keyword]) => `--cursor-${suffix}:${keyword}`)
  .join(';')}}`

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

/**
 * Runs in the page world: finds the module alias the root layout reads `standard` from, imports
 * that module, and widens the getter to also honour the force attribute, so Wplace's icon
 * components render their Material Symbols variant under standard UI. Self-contained on purpose:
 * it is serialised with `.toString()` into a page script and cannot reference anything outside
 * its body.
 */
const overrideWplaceStandard = async (layoutUrl: string, forceAttribute: string): Promise<void> => {
  try {
    const source = await (await fetch(layoutUrl)).text()
    const alias = source.match(/toggleAttribute\(`data-standard-ui`,([\w$]+)\.standard\)/)?.[1]
    if (alias === undefined) throw new Error('root layout no longer reads standard')
    const escaped = alias.replace(/\$/g, '\\$')
    const specifier = source.match(
      new RegExp(`import\\{[^}]*\\bt as ${escaped}\\b[^}]*\\}from"([^"]+)"`),
    )?.[1]
    if (specifier === undefined) throw new Error('standard module import not found')
    const module: Record<string, unknown> = await import(new URL(specifier, layoutUrl).href)
    const owner = Object.values(module).find(
      (value): value is object =>
        typeof value === 'object' &&
        value !== null &&
        typeof Object.getOwnPropertyDescriptor(value, 'standard')?.get === 'function',
    )
    const original = owner && Object.getOwnPropertyDescriptor(owner, 'standard')?.get
    if (owner === undefined || original === undefined) throw new Error('standard getter not found')
    Object.defineProperty(owner, 'standard', {
      configurable: true,
      get(this: object) {
        return original.call(this) || document.documentElement.hasAttribute(forceAttribute)
      },
    })
  } catch (error) {
    console.debug('[caelestis] Wplace standard icons unavailable', error)
  }
}

/** Wplace offering its own standard-UI setting, detected from its stored settings keys. */
const wplaceSettingsOfferStandard = (): boolean => {
  try {
    const raw = globalThis.localStorage?.getItem(WPLACE_SETTINGS_KEY)
    if (!raw) return false
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return false
    return Object.keys(parsed).some((key) => NATIVE_SETTINGS_KEY.test(key))
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
    if (document.getElementById(CURSOR_STYLE_ID) === null) {
      const style = document.createElement('style')
      style.id = CURSOR_STYLE_ID
      style.textContent = CURSOR_CSS
      root.append(style)
    }
    if (enabled && !native) {
      if (!root.hasAttribute(ATTRIBUTE)) root.setAttribute(ATTRIBUTE, '')
      if (!root.hasAttribute(FORCE_ATTRIBUTE)) root.setAttribute(FORCE_ATTRIBUTE, '')
    }
  }

  // Injected regardless of the saved choice, so a later switch also takes effect on the next
  // render. Runs once the root layout's modulepreload link exists, which doubles as the signal
  // that Wplace's modules are about to load.
  let iconsOverridden = false
  const armIconOverride = (): void => {
    if (iconsOverridden) return
    const link = document.querySelector<HTMLLinkElement>(
      'link[rel="modulepreload"][href*="/nodes/0."]',
    )
    const root = document.documentElement
    if (link === null || root === null) return
    iconsOverridden = true
    // A page script runs in the page world even when the userscript itself is sandboxed.
    const script = document.createElement('script')
    script.textContent = `(${overrideWplaceStandard.toString()})(${JSON.stringify(link.href)}, ${JSON.stringify(FORCE_ATTRIBUTE)})`
    root.append(script)
  }

  const ourRow = (): HTMLElement | null =>
    document.getElementById(PANEL_ID)?.querySelector(`label[${ROW_MARKER}]`) ?? null

  const syncToggle = (): void => {
    const panel = document.getElementById(PANEL_ID)
    if (!panel) return

    // A native version of this switch: any row that is not ours whose label fits the bill.
    const nativeLabel =
      native ||
      [...panel.querySelectorAll('label')].some(
        (label) => !label.hasAttribute(ROW_MARKER) && NATIVE_LABEL.test(label.textContent ?? ''),
      )
    if (nativeLabel) {
      ourRow()?.remove()
      document.documentElement?.removeAttribute(FORCE_ATTRIBUTE)
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
    // The switch shows the pixel UI, so it is checked while `enabled` (standard UI) is off.
    input.checked = !enabled
    input.addEventListener('change', () => {
      enabled = !input.checked
      writeEnabled(enabled)
      if (enabled) apply()
      else {
        document.documentElement?.removeAttribute(FORCE_ATTRIBUTE)
        if (!DASHBOARD_PATH.test(location.pathname))
          document.documentElement?.removeAttribute(ATTRIBUTE)
      }
      log('install', `standard UI ${enabled ? 'on' : 'off'}`)
    })
    anchor.before(row)
  }

  apply()
  syncToggle()
  armIconOverride()

  const observer = new MutationObserver(() => {
    apply()
    syncToggle()
    armIconOverride()
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
    document.getElementById(CURSOR_STYLE_ID)?.remove()
    document.documentElement?.removeAttribute(FORCE_ATTRIBUTE)
  }
}
