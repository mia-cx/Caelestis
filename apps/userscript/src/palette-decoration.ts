import { formatCount, formatPixels, shortcutLabel } from '@caelestis/shared'
import type { CaelestisElement } from '@caelestis/ui/elements'
import { activeAllianceSurface } from './alliance-surface.js'
import { onCanvasWrite } from './canvas-write.js'
import { registerDebugEntry } from './console-api.js'
import { count } from './debug.js'
import { frameQueue } from './frame-queue.js'
import {
  canvasWriteTouchesArtboard,
  onArtboardPixelsChange,
  onHeadquartersTilesChange,
} from './gl/artboard-pixels.js'
import { onMapFrame } from './map-view.js'
import {
  colourKindOrder,
  navigateFocusedColour,
  paintPaletteProgress,
} from './palette-navigation.js'
import { onServerStatusChange } from './server-status.js'
import { onStateChange } from './settings.js'
import { activeShortcutBindings, currentShortcutPlatform } from './shortcuts.js'
import { onLocalChange } from './templates/catalog.js'
import { installDraftProjection } from './templates/draft-projection.js'
import { pixelAccounting } from './templates/mismatch.js'
import { focusedTemplate } from './templates/nearest.js'
import { applyWplaceTheme } from './ui/theme.js'
import { paintPaletteIndexOf } from './wplace-dom.js'
import { currentPaintSwatches, isPaintOpen, onPaintSwatchesChange } from './wplace-paint.js'

/**
 * Wplace's palette swatches, decorated with how many pixels of each colour the focused template
 * still needs, and wired so a middle click jumps to the nearest one.
 */

const originalLabels = new WeakMap<HTMLElement, string>()
const originalTitles = new WeakMap<HTMLElement, string | null>()
const wired = new WeakSet<HTMLElement>()

/** How a swatch's label tells the user to jump: by mouse, and by key while one is assigned. */
const jumpInstruction = (): string => {
  const key = shortcutLabel(activeShortcutBindings()['fly-to-colour'], currentShortcutPlatform())
  return key === '' ? 'Middle-click' : `Middle-click, or select it and press ${key},`
}

const wire = (swatch: HTMLElement, index: number): void => {
  if (wired.has(swatch)) return
  wired.add(swatch)
  swatch.addEventListener('pointerdown', (event) => {
    if (event.button === 1) event.preventDefault()
  })
  swatch.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return
    event.preventDefault()
    event.stopPropagation()
    void navigateFocusedColour(index)
  })
}

const render = (): void => {
  const swatches = currentPaintSwatches()
  count('paint:palette renders')
  count('paint:palette swatches', swatches.length)
  // Mismatch and telemetry updates also arrive while Wplace's paint drawer is closed. Do not walk
  // every visible template and aggregate its colour totals for a UI that has no mounted consumer.
  if (swatches.length === 0) return
  const progress = new Map(paintPaletteProgress().map((entry) => [entry.index, entry]))
  const navigationLabel = colourKindOrder().join(', then ')
  count('paint:palette progress colours', progress.size)
  for (const element of swatches) {
    const index = paintPaletteIndexOf(element)
    if (index === null) continue
    wire(element, index)
    const entry = progress.get(index)
    const existing = element.querySelector<CaelestisElement<'caelestis-palette-progress'>>(
      ':scope > caelestis-palette-progress',
    )
    const remaining = entry === undefined ? 0 : Math.max(0, entry.total - entry.completed)
    if (remaining === 0) {
      existing?.remove()
      const original = originalLabels.get(element)
      if (original !== undefined) element.setAttribute('aria-label', original)
      if (originalTitles.has(element)) {
        const title = originalTitles.get(element)
        if (title == null) element.removeAttribute('title')
        else element.title = title
        originalTitles.delete(element)
      }
      continue
    }
    const label =
      originalLabels.get(element) ?? element.getAttribute('aria-label') ?? `Colour ${index + 1}`
    originalLabels.set(element, label)
    element.setAttribute(
      'aria-label',
      `${label}. ${formatPixels(remaining)} left in the focused template. ${jumpInstruction()} to go to its nearest ${navigationLabel} pixel.`,
    )
    if (!originalTitles.has(element)) originalTitles.set(element, element.getAttribute('title'))
    const originalTitle = originalTitles.get(element)
    element.title = `${originalTitle ? `${originalTitle}. ` : ''}${formatPixels(remaining)} left in the focused template`
    const badge = existing ?? document.createElement('caelestis-palette-progress')
    badge.className = 'caelestis-palette-progress'
    if (existing === null) applyWplaceTheme(badge)
    const text = formatCount(remaining)
    if (badge.model?.value !== text) badge.model = { value: text }
    if (existing === null) element.appendChild(badge)
  }
}

let focusedTemplateId: string | null = null

// A hidden debug tab suspends animation frames entirely, but Wplace can still mount the drawer
// through automation or restored state. A zero-delay task keeps updates batched without making
// palette decoration depend on the map actively painting frames.
const queueTask = frameQueue(render, (callback) => setTimeout(callback, 0))

const queueRender = (): void => {
  if (isPaintOpen()) queueTask()
}

/** Refresh the counters only when panning or zooming changes which template owns them. */
const refreshPaintPaletteFocus = (): void => {
  if (!isPaintOpen()) return
  const next = focusedTemplate()?.id ?? null
  if (next === focusedTemplateId) return
  focusedTemplateId = next
  queueRender()
}

let installed = false

/** Keep Wplace's transient swatches decorated across its Svelte drawer remounts. */
export const installPaintPaletteProgress = (): void => {
  if (installed) return
  installed = true
  /** The exact focused-template counts currently decorating Wplace's native paint palette. */
  registerDebugEntry('paletteProgress', () => paintPaletteProgress())
  installDraftProjection(queueRender)
  onServerStatusChange(queueRender)
  pixelAccounting.onChange(queueRender)
  pixelAccounting.onDraftChange(queueRender)
  onStateChange(queueRender)
  onLocalChange(queueRender)
  onArtboardPixelsChange(queueRender)
  onHeadquartersTilesChange(queueRender)
  onCanvasWrite((canvas) => {
    const active = activeAllianceSurface()
    if (active !== null && canvasWriteTouchesArtboard(active, canvas)) queueRender()
  })
  // Picking a colour changes marker styling, not the draft totals, so only new swatch elements
  // need decorating: a mount, or Svelte replacing them while the drawer stays open.
  onPaintSwatchesChange(queueRender)
  onMapFrame(refreshPaintPaletteFocus, 'Paint palette focus')
  queueRender()
}
