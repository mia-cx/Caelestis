import { TRANSPARENT_INDEX } from '@caelestis/shared'
import { activeAllianceEditorStage } from './alliance-surface.js'
import { log } from './debug.js'
import { simulatedInputAllowed } from './simulated-input.js'
import {
  OPEN_DIALOG,
  paintDrawer,
  paintDrawerCloseButton,
  paintDrawerCommitButton,
  paintHistoryButton,
  paintOpenButton,
  paintPaletteIndexOf,
  paintPaletteSwatches,
  readSelectedColour,
} from './wplace-dom.js'

/**
 * Wplace's paint state, and the actions that drive its paint drawer.
 *
 * The drawer existing *is* the signal that painting has started: Wplace's swatches are only in the
 * document while it is open. Both facts change without navigation (Svelte mounts and unmounts the
 * drawer, and selecting a colour rewrites one class), so a MutationObserver watches for them. This
 * is the only module that tracks them; everything else reads `isPaintOpen` and `selectedColour`.
 */

let selected: number | null = null
let open = false
let swatches: readonly HTMLElement[] = []
const selectionListeners = new Set<() => void>()
const swatchListeners = new Set<() => void>()

/** Our palette index of the colour Wplace has selected. Null whenever the drawer is closed. */
export const selectedColour = (): number | null => selected

export const isPaintOpen = (): boolean => open

/** Notified when the drawer opens or closes, or the selected colour changes. */
export const onPaintSelectionChange = (listener: () => void): (() => void) => {
  selectionListeners.add(listener)
  return () => selectionListeners.delete(listener)
}

/** Notified when Wplace mounts, replaces or removes its swatch elements. */
export const onPaintSwatchesChange = (listener: () => void): (() => void) => {
  swatchListeners.add(listener)
  return () => swatchListeners.delete(listener)
}

/** Where Wplace's paint controls live right now: the open alliance editor's dialog, else the page. */
const activePaintRoot = (): ParentNode =>
  activeAllianceEditorStage()?.closest(OPEN_DIALOG) ?? document

/** Wplace's paint swatches in the active root, read now rather than as of the last frame. */
export const currentPaintSwatches = (): HTMLElement[] => paintPaletteSwatches(activePaintRoot())

/** Select one of Wplace's own paint swatches without owning a second palette state. */
export const selectPaintColour = (index: number): boolean => {
  if (!Number.isInteger(index) || index < 0 || index >= TRANSPARENT_INDEX) return false
  const swatch = currentPaintSwatches().find(
    (candidate) => paintPaletteIndexOf(candidate) === index,
  )
  if (swatch === undefined) return false
  swatch.click()
  return true
}

const clickEnabled = (button: HTMLButtonElement | null): boolean => {
  if (button === null || button.disabled) return false
  button.click()
  return true
}

/**
 * Ask Wplace's own paint drawer to move through its authoritative draft history.
 *
 * The native controls own pixel recency, redo invalidation after a new paint, and the draft payload
 * eventually submitted to Wplace. Driving those controls keeps all of that state in one place; the
 * resulting canvas writes then flow through our canonical pixel-accounting interception exactly
 * like a hand-painted pixel.
 */
const movePaintHistory = (control: 'undo' | 'redo'): boolean => {
  const drawer = paintDrawer(activePaintRoot())
  return clickEnabled(drawer === null ? null : paintHistoryButton(drawer, control))
}

/** Undo the most recently drafted pixel, if Wplace currently has one. */
export const undoPaintDraft = (): boolean => movePaintHistory('undo')

/** Redo the most recently undone draft pixel, if Wplace currently has one. */
export const redoPaintDraft = (): boolean => movePaintHistory('redo')

/**
 * Open Wplace's paint mode, or submit through the drawer's own Paint button when it is already
 * open. Wplace flags a simulated click on that button (`UntrustedPaintSubmit`), so an open drawer
 * is left alone unless the `paint-commit` switch allows it. A mounted palette whose controls cannot
 * be identified must not fall through to an unrelated action elsewhere on the page.
 */
export const performPaintAction = (): boolean => {
  const root = activePaintRoot()
  if (paintPaletteSwatches(root).length > 0) {
    if (!simulatedInputAllowed('paint-commit')) return false
    const drawer = paintDrawer(root)
    return clickEnabled(drawer === null ? null : paintDrawerCommitButton(drawer))
  }
  const button = paintOpenButton(root)
  button?.click()
  return button !== null
}

/** Discard the current native Wplace draft, leaving unrelated Escape handling alone when closed. */
export const cancelPaintDraft = (): boolean => {
  const drawer = paintDrawer(activePaintRoot())
  return clickEnabled(drawer === null ? null : paintDrawerCloseButton(drawer))
}

const sameElements = (left: readonly Element[], right: readonly Element[]): boolean =>
  left.length === right.length && left.every((element, index) => element === right[index])

const read = (): void => {
  const next = currentPaintSwatches()
  const nextOpen = next.length > 0
  const nextSelected = readSelectedColour(next)
  const remounted = !sameElements(swatches, next)
  const changed = nextOpen !== open || nextSelected !== selected
  swatches = next
  open = nextOpen
  selected = nextSelected
  if (remounted) for (const listener of swatchListeners) listener()
  if (!changed) return
  log('install', 'paint selection changed', { open, selected })
  for (const listener of selectionListeners) listener()
}

/**
 * Once per frame, not once per mutation batch.
 *
 * `read` scans the whole document for `[id^="color-"]`, an unindexed attribute-prefix match, and
 * Wplace re-renders its chrome continuously, so reading per mutation batch scanned the document on
 * every one of its mutations. Opening a drawer and picking a colour happen on human timescales.
 * A hidden tab suspends animation frames, but Wplace can still mount the drawer there through
 * automation or restored state, so a hidden tab reads on the next task instead.
 */
let queued = false

const queueRead = (): void => {
  if (queued) return
  queued = true
  const run = (): void => {
    queued = false
    read()
  }
  if (document.hidden) setTimeout(run, 0)
  else requestAnimationFrame(run)
}

/**
 * Start watching. Observes the document node itself, which exists at `document-start` before
 * `<html>` does, so this is safe to call from the entry point.
 */
export const watchPaintSelection = (): void => {
  read()
  new MutationObserver(queueRead).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'aria-pressed'],
  })
}
