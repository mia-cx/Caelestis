/**
 * Keeps Wplace's standard (non-pixel) UI applied from a saved Caelestis choice.
 *
 * Wplace's `standard` flag is a getter-only derived value — true only on the dashboard routes —
 * with no setter and no setting, so the only way to opt in elsewhere is the `data-standard-ui`
 * attribute its root layout toggles. That layout effect re-runs on every navigation and clears
 * the attribute on non-dashboard pages, so a MutationObserver re-applies it whenever it goes
 * missing while the user has it switched on.
 */

const STORAGE_KEY = 'caelestis.standard-ui.v1'
const ATTRIBUTE = 'data-standard-ui'

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

/**
 * Installs the saved Standard UI choice. Applies the attribute synchronously so it is set
 * before first paint, then watches for Wplace's layout effect clearing it. Returns a disposer
 * that disconnects the observer — used by tests.
 */
export const installStandardUi = (): (() => void) => {
  const enabled = readEnabled()

  const apply = (): void => {
    if (enabled && !document.documentElement.hasAttribute(ATTRIBUTE))
      document.documentElement.setAttribute(ATTRIBUTE, '')
  }

  apply()

  const observer = new MutationObserver(apply)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [ATTRIBUTE],
  })

  return () => observer.disconnect()
}
