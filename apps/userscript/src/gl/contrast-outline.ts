/**
 * Theme lookup for the black-or-white silhouette rendered below Wplace's art.
 *
 * `data-theme` decides when it says dark or light; otherwise the root's computed `color-scheme`
 * does. Reading computed style forces a style recalculation, so the answer is cached and refreshed
 * only when the root's attributes or the system colour scheme change, never inside a render.
 */

const listeners = new Set<() => void>()
let dark: boolean | null = null

const read = (root: HTMLElement): boolean => {
  const theme = root.dataset.theme
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return getComputedStyle(root).colorScheme === 'dark'
}

const refresh = (): void => {
  const next = read(document.documentElement)
  if (next === dark) return
  dark = next
  for (const listener of listeners) listener()
}

const watch = (): void => {
  new MutationObserver(refresh).observe(document.documentElement, { attributes: true })
  globalThis.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', refresh)
}

/** Whether the map is dark. Cheap: reads the cached answer. */
export const isDarkMapTheme = (): boolean => {
  if (dark === null) {
    dark = read(document.documentElement)
    watch()
  }
  return dark
}

/** Run `listener` whenever the answer of {@link isDarkMapTheme} changes. */
export const onMapThemeChange = (listener: () => void): void => {
  isDarkMapTheme()
  listeners.add(listener)
}
