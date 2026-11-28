import { TRANSPARENT_INDEX } from '@caelestis/shared'
import { activeAllianceDialog } from './alliance-editor-dom.js'
import { log } from './debug.js'
import { frameQueue } from './frame-queue.js'
import { notifyListeners } from './listeners.js'
import { simulatedInputAllowed } from './simulated-input.js'
import {
  arenaCommitButton,
  arenaOpenButton,
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
 * document while it is open. The territory event's Paint panel has no swatches, so its own commit
 * button counts as open too. Both facts change without navigation (Svelte mounts and unmounts the
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
const activePaintRoot = (): ParentNode => activeAllianceDialog() ?? document

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

/** Wplace flags a simulated click on a commit button (`UntrustedPaintSubmit`), so its switch gates it. */
const commitPaint = (button: HTMLButtonElement | null): boolean =>
  simulatedInputAllowed('paint-commit') && clickEnabled(button)

const clickOpen = (button: HTMLButtonElement | null): boolean => {
  button?.click()
  return button !== null
}

/**
 * Open Wplace's paint mode, or submit through the open drawer's or event panel's own Paint button.
 * A mounted palette whose controls cannot be identified must not fall through to an unrelated
 * action elsewhere on the page.
 */
export const performPaintAction = (): boolean => {
  const root = activePaintRoot()
  if (paintPaletteSwatches(root).length > 0) {
    const drawer = paintDrawer(root)
    return commitPaint(drawer === null ? null : paintDrawerCommitButton(drawer))
  }
  const arenaCommit = arenaCommitButton(root, 'paint')
  if (arenaCommit !== null) return commitPaint(arenaCommit)
  return clickOpen(paintOpenButton(root))
}

/** Open the territory event's Swap shade, or submit the open swap through its own button. */
export const performShadeSwapAction = (): boolean => {
  const root = activePaintRoot()
  const commit = arenaCommitButton(root, 'territory_shade_swap')
  if (commit !== null) return commitPaint(commit)
  return clickOpen(arenaOpenButton(root, 'territory_shade_swap'))
}

/**
 * Submit the open world draft for a capture run's slot, through the drawer's Paint button or the
 * territory event panel's own. Never an alliance editor's draft, which has nothing to do with the
 * run. The caller checks the `capture-paint` switch; Wplace flags the click as
 * `UntrustedPaintSubmit`.
 */
export const submitWorldPaintDraft = (): boolean => {
  if (activeAllianceDialog() !== null) return false
  const drawer = paintDrawer(document)
  return clickEnabled(
    drawer === null ? arenaCommitButton(document, 'paint') : paintDrawerCommitButton(drawer),
  )
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
  // The territory event's Paint panel drafts like the drawer but has no palette; its commit
  // button beside Cancel is what shows it open.
  const nextOpen = next.length > 0 || arenaCommitButton(document, 'paint') !== null
  const nextSelected = readSelectedColour(next)
  const remounted = !sameElements(swatches, next)
  const changed = nextOpen !== open || nextSelected !== selected
  swatches = next
  open = nextOpen
  selected = nextSelected
  if (remounted) notifyListeners(swatchListeners, 'paint swatch listener failed')
  if (!changed) return
  log('paint selection changed', { open, selected })
  notifyListeners(selectionListeners, 'paint selection listener failed')
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
const queueRead = frameQueue(read, (callback) => {
  if (document.hidden) setTimeout(callback, 0)
  else requestAnimationFrame(callback)
})

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
