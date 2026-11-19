import { PALETTE_RGB, PALETTE_SIZE, TRANSPARENT_INDEX } from '@caelestis/shared'
import {
  findWplaceLabelled,
  hasWplaceLabel,
  type WplaceLabel,
  wplaceLabel,
} from './wplace-messages.js'

/**
 * What Wplace is showing, read from its rendered markup.
 *
 * Wplace exposes no state for its paint drawer, palette or tools, so Caelestis reads them from the
 * DOM. Every selector for that markup lives here, so a Wplace redesign changes one file. Controls
 * are found by their translated labels (`wplace-messages.ts`) or by structure, never by English
 * text (#624). Paint queries take the root to search: `wplace-paint.ts` knows which one is active.
 */

/** Wplace's MapLibre canvas. It exists only once Wplace's page has rendered. */
export const MAP_CANVAS = 'canvas.maplibregl-canvas'

/**
 * What counts as "on the map". The container as well as the canvas: MapLibre puts markers and
 * their own overlays inside it, and a click that lands on one of those is still a click on the
 * map. Our own panel and menus are outside it.
 */
export const MAP_SURFACE = '.maplibregl-canvas-container, canvas.maplibregl-canvas'

/** An open Wplace modal: an alliance editor, or its settings. */
export const OPEN_DIALOG = 'dialog[open]'

/** World swatches carry `color-N`, where N is Wplace's palette index (ours plus one). */
const WORLD_SWATCH = '[id^="color-"]'
/** Alliance swatches carry no id; their label is the translated colour name. */
const ALLIANCE_SWATCH = 'button.game-color-swatch[aria-pressed]:not([id^="color-"])'
/** Alliance swatches paint their colour inline, as `background: rgb(60 60 60)`. */
const SWATCH_RGB = /rgb\((\d+)[\s,]+(\d+)[\s,]+(\d+)/

/** Wplace's mounted world or alliance paint swatches, in their rendered order. */
export const paintPaletteSwatches = (root: ParentNode): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(WORLD_SWATCH),
  ...root.querySelectorAll<HTMLElement>(ALLIANCE_SWATCH),
]

/**
 * Our palette index for a swatch. Alliance swatches are identified by their inline colour.
 *
 * Transparent is deliberately not mapped. It is paintable for Wplace, but as a template colour it
 * means "may be anything", so "show only the selected colour" has nothing to show for it. Its
 * swatch shows a checkerboard image rather than a colour.
 */
export const paintPaletteIndexOf = (element: Element): number | null => {
  const raw = Number(element.id.slice('color-'.length))
  const rgb = element.getAttribute('style')?.match(SWATCH_RGB)?.slice(1).map(Number)
  const index =
    Number.isInteger(raw) && raw > 0
      ? raw - 1
      : rgb === undefined
        ? -1
        : PALETTE_RGB.findIndex((colour) => colour.every((channel, at) => channel === rgb[at]))
  if (index < 0 || index >= PALETTE_SIZE || index === TRANSPARENT_INDEX) return null
  return index
}

/** World swatches mark the selection with `ring-primary`, alliance ones with `aria-pressed`. */
const isSelectedSwatch = (swatch: Element): boolean =>
  swatch.className.includes('ring-primary') || swatch.getAttribute('aria-pressed') === 'true'

/** The colour selected among these swatches. */
export const readSelectedColour = (swatches: readonly Element[]): number | null => {
  const selected = swatches.find(isSelectedSwatch)
  return selected === undefined ? null : paintPaletteIndexOf(selected)
}

/** Whether Wplace's world paint panel, and with it the listeners that flag input, is mounted. */
export const worldPaintMounted = (): boolean => document.querySelector(WORLD_SWATCH) !== null

const paintControl = (
  root: ParentNode,
  label: 'undo' | 'redo' | 'close',
): HTMLButtonElement | null => findWplaceLabelled(root, 'button', label)

/** The drawer is the smallest ancestor holding Wplace's Undo and Redo. */
const isPaintDrawer = (element: Element): boolean =>
  paintControl(element, 'undo') !== null && paintControl(element, 'redo') !== null

/** Whether an element sits inside a paint drawer, whose Close discards a draft. */
export const insidePaintDrawer = (element: Element): boolean => {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    if (node === document.body) return false
    if (isPaintDrawer(node)) return true
  }
  return false
}

/** Wplace's paint drawer under `root`: the smallest ancestor of a swatch holding its history. */
export const paintDrawer = (root: ParentNode): HTMLElement | null => {
  const swatch = paintPaletteSwatches(root)[0]
  if (swatch === undefined) return null
  for (let drawer = swatch.parentElement; drawer !== null; drawer = drawer.parentElement) {
    if (drawer === document.body || drawer === document.documentElement) return null
    if (isPaintDrawer(drawer)) return drawer
    if (drawer === root) return null
  }
  return null
}

/** The drawer's Undo or Redo. */
export const paintHistoryButton = (
  drawer: HTMLElement,
  control: 'undo' | 'redo',
): HTMLButtonElement | null => paintControl(drawer, control)

/** Prefer native Close labels; retain the unlabeled header control used by older Wplace drawers. */
export const paintDrawerCloseButton = (drawer: HTMLElement): HTMLButtonElement | null => {
  const close = paintControl(drawer, 'close')
  if (close !== null) return close
  const header = Array.from(drawer.children).find((child) => paintControl(child, 'undo') !== null)
  if (header === undefined) return null
  const directButtons = Array.from(header.children).filter(
    (child): child is HTMLButtonElement =>
      child instanceof HTMLButtonElement &&
      !child.hasAttribute('title') &&
      !child.hasAttribute('aria-label') &&
      child.textContent?.trim() === '',
  )
  return directButtons.length === 1 ? (directButtons[0] ?? null) : null
}

/** A countdown Wplace appends to its Paint label, as in "Paint (0:25)". */
const PAINT_COUNTDOWN = /^\s*\([^)]*\)$/

/** Match only the drawer's Paint action, including its optional countdown, without layout classes. */
export const paintDrawerCommitButton = (drawer: HTMLElement): HTMLButtonElement | null => {
  const paint = wplaceLabel('paint').toLowerCase()
  const candidates = [...drawer.querySelectorAll<HTMLButtonElement>('button')].filter((button) => {
    const label = (
      button.getAttribute('aria-label') ??
      button.getAttribute('title') ??
      button.textContent ??
      ''
    )
      .trim()
      .toLowerCase()
    return (
      label.startsWith(paint) &&
      (label === paint || PAINT_COUNTDOWN.test(label.slice(paint.length)))
    )
  })
  return candidates.length === 1 ? (candidates[0] ?? null) : null
}

/**
 * Wplace's bottom-centre Paint button, found by its horizontally centred dock. Wplace translates
 * the label ("Peindre" in French) once its locale loads, so matching the text loses the button
 * a moment after page load for anyone not reading English (issue #624).
 */
export const paintDockButton = (root: ParentNode = document): HTMLButtonElement | null => {
  for (const button of root.querySelectorAll<HTMLButtonElement>('button.btn-primary.btn-lg')) {
    const dock = button.parentElement?.classList
    if (
      dock?.contains('absolute') === true &&
      dock.contains('left-1/2') &&
      dock.contains('-translate-x-1/2')
    )
      return button
  }
  return null
}

/** The control that opens paint mode: an exact Paint label first, then the dock button. */
export const paintOpenButton = (root: ParentNode): HTMLButtonElement | null => {
  const labels = new Set(
    [wplaceLabel('paint'), wplaceLabel('paint_pixel')].map((label) => label.toLowerCase()),
  )
  for (const button of root.querySelectorAll<HTMLButtonElement>('button')) {
    const label = (button.getAttribute('aria-label') ?? button.getAttribute('title') ?? '')
      .trim()
      .toLowerCase()
    if (labels.has(label)) return button
  }
  return paintDockButton(root)
}

export type NativeTool = Extract<WplaceLabel, 'color_picker' | 'eraser'>

/**
 * The picker's icon outlines, for when its label cannot be matched: Wplace's material-symbol icon
 * and the Legacy UI's pixel icon.
 */
const PICKER_ICON_PREFIXES = ['M120-120v-190', 'M3 21h2v2H1v-4h2v2Z']

/**
 * Wplace's buttons for a paint tool. Prefer the label; the picker also falls back to its visible
 * tooltip and then its icon, which survive an untranslated label and the Legacy UI.
 */
const nativeToolButtons = (tool: NativeTool): HTMLButtonElement[] => {
  const labelled = [...document.querySelectorAll('button')].filter((button) =>
    hasWplaceLabel(button, tool),
  )
  if (labelled.length > 0 || tool !== 'color_picker') return labelled
  const picker = wplaceLabel(tool)
  for (const tooltip of document.querySelectorAll('.tooltip')) {
    const label = tooltip.querySelector('.tooltip-content')?.textContent ?? ''
    if (!label.includes(picker)) continue
    const button = tooltip.querySelector('button')
    if (button instanceof HTMLButtonElement) return [button]
  }
  for (const path of document.querySelectorAll('button path')) {
    const outline = path.getAttribute('d')
    if (!PICKER_ICON_PREFIXES.some((prefix) => outline?.startsWith(prefix))) continue
    const button = path.closest('button')
    if (button instanceof HTMLButtonElement) return [button]
  }
  return []
}

/** Wplace marks the active tool `btn-primary`, a toggled one `aria-pressed`. */
const isActiveControl = (button: Element): boolean =>
  button.classList.contains('btn-primary') || button.getAttribute('aria-pressed') === 'true'

/** The tool's button while that Wplace tool is active, else null. */
export const activeNativeTool = (tool: NativeTool): HTMLButtonElement | null =>
  nativeToolButtons(tool).find(isActiveControl) ?? null

/** Text fields, where Space types instead of painting. Wplace's paint hold skips the same ones. */
const TEXT_FIELD =
  'input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"]), textarea, select, [contenteditable]:not([contenteditable="false"])'

/** Whether a key event is typing into a text field, which Wplace's paint hold ignores. */
export const typingInTextField = (event: Event): boolean =>
  event.composedPath().some((target) => target instanceof Element && target.matches(TEXT_FIELD))
