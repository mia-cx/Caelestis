/**
 * Wplace's control labels in the reader's language.
 *
 * Wplace translates its UI with Paraglide into twelve locales, so a control found by its English
 * `aria-label` disappears for everyone reading another language (#624). Wplace's locale module
 * exports a getter for the active message catalog; `wplace-modules.ts` hands it over once the map
 * exists. Until then, or if the module cannot be found, the English labels stand in.
 */
const ENGLISH = {
  undo: 'Undo',
  redo: 'Redo',
  close: 'Close',
  cancel: 'Cancel',
  eraser: 'Eraser',
  color_picker: 'Color Picker',
  paint: 'Paint',
  paint_pixel: 'Paint pixel',
  territory_shade_swap: 'Swap shade',
  alliance_hq_canvas: 'Headquarters canvas',
  alliance_asset_canvas: 'Alliance asset canvas',
} as const

export type WplaceLabel = keyof typeof ENGLISH

export type Catalog = () => Readonly<Record<string, unknown>>

let catalog: Catalog | null = null

/** Wplace's text for `key` in the language it is currently showing. */
export const wplaceLabel = (key: WplaceLabel): string => {
  const translated = catalog?.()[key]
  return typeof translated === 'string' ? translated : ENGLISH[key]
}

/** Whether the element's `aria-label` or `title` is Wplace's `key` label. */
export const hasWplaceLabel = (element: Element, key: WplaceLabel): boolean => {
  const label = wplaceLabel(key)
  return element.getAttribute('aria-label') === label || element.getAttribute('title') === label
}

/** The first `selector` match under `root` labelled with Wplace's `key` label. */
export const findWplaceLabelled = <E extends Element = HTMLButtonElement>(
  root: ParentNode,
  selector: string,
  key: WplaceLabel,
): E | null =>
  [...root.querySelectorAll<E>(selector)].find((element) => hasWplaceLabel(element, key)) ?? null

/** Read labels from this getter for Wplace's active catalog; null falls back to English. */
export const useWplaceCatalog = (read: Catalog | null): void => {
  catalog = read
}
