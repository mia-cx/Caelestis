import {
  latLngToCanvasPixel,
  sameTemplateSurface,
  type TemplateSurface,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { readActiveArtboard } from './active-artboard.js'
import { alliancePointAt } from './alliance-coordinates.js'
import { navigateAllianceArtboardTo } from './alliance-navigation.js'
import { type ActiveAllianceSurface, activeAllianceSurface } from './alliance-surface.js'
import { warn } from './debug.js'
import { getMap } from './map-handle.js'
import { getState } from './settings.js'
import { artboardColourTargets } from './templates/artboard-accounting.js'
import type { PlacedTemplate } from './templates/catalog.js'
import { projectedColourProgress } from './templates/draft-projection.js'
import { pixelAccounting } from './templates/mismatch.js'
import { navigateTo } from './templates/navigate.js'
import { focusedTemplate } from './templates/nearest.js'
import type {
  ColourNavigationTarget,
  ColourTargetKind,
  TemplateColourProgress,
} from './templates/progress-types.js'
import { templateChunks } from './templates/residency.js'
import { paintPaletteIndexOf } from './wplace-dom.js'
import {
  currentPaintSwatches,
  isPaintOpen,
  selectedColour,
  selectPaintColour,
} from './wplace-paint.js'

/**
 * Moving between the focused template's unfinished colours: jumping to a colour's nearest remaining
 * pixel, and selecting the previous or next unfinished swatch.
 */

/** The open alliance editor when it shows `surface`, else null. */
const editorShowing = (surface: TemplateSurface): ActiveAllianceSurface | null => {
  const active = activeAllianceSurface()
  return active !== null && sameTemplateSurface(active.surface, surface) ? active : null
}

/** The colour counts decorating Wplace's palette belong only to the focused active surface. */
export const paintPaletteProgress = (): readonly TemplateColourProgress[] =>
  projectedColourProgress(focusedTemplate())

/** The kinds of unfinished pixel a jump visits, in the painter's chosen order. */
export const colourKindOrder = (): readonly ColourTargetKind[] =>
  getState().colourNavigationOrder === 'mismatched-first'
    ? ['mismatched', 'unpainted']
    : ['unpainted', 'mismatched']

let lastNavigation: { readonly index: number; readonly target: ColourNavigationTarget } | null =
  null

/** The target a cycling jump moves past: the last one, when it was this colour in this template. */
const previousTarget = (
  index: number,
  template: PlacedTemplate,
  cycle: boolean,
): ColourNavigationTarget | null =>
  cycle && lastNavigation?.index === index && lastNavigation.target.templateId === template.id
    ? lastNavigation.target
    : null

const navigateArtboard = async (
  active: ActiveAllianceSurface,
  template: PlacedTemplate,
  index: number,
  cycle: boolean,
): Promise<boolean> => {
  const stage = active.stage.getBoundingClientRect()
  const reference = alliancePointAt(
    active,
    stage.left + stage.width / 2,
    stage.top + stage.height / 2,
  )
  if (reference === null) return false
  const pixels = await templateChunks(template)
  const artboard = readActiveArtboard(active)
  if (artboard === null) return false
  const targets = artboardColourTargets({ ...template, pixels }, artboard, index)
  const previous = previousTarget(index, template, cycle)
  for (const kind of colourKindOrder()) {
    const candidates = targets.filter((target) => target.kind === kind)
    if (candidates.length === 0) continue
    const available = candidates.filter(
      (target) => previous === null || target.x !== previous.x || target.y !== previous.y,
    )
    const pool = available.length > 0 ? available : candidates
    const target = pool.reduce((nearest, candidate) => {
      const distance = (candidate.x - reference.x) ** 2 + (candidate.y - reference.y) ** 2
      const nearestDistance = (nearest.x - reference.x) ** 2 + (nearest.y - reference.y) ** 2
      return distance < nearestDistance ? candidate : nearest
    })
    lastNavigation = { index, target: { ...target, templateId: template.id } }
    return navigateAllianceArtboardTo(active, { x: target.x + 0.5, y: target.y + 0.5 })
  }
  warn('install', `no remaining pixel for palette colour ${index} in template ${template.id}`)
  return false
}

const navigateWorld = async (
  template: PlacedTemplate,
  index: number,
  cycle: boolean,
): Promise<boolean> => {
  const map = getMap()
  if (map === null) return false
  const reference = latLngToCanvasPixel(map.getCenter())
  const accounting = pixelAccounting.read(template)
  const last = previousTarget(index, template, cycle)
  for (const kind of colourKindOrder()) {
    const previous = last?.kind === kind ? last : undefined
    let target = await accounting.nearest(index, kind, reference, previous)
    // Preserve the configured kind priority. If the excluded pixel is the only target of this kind,
    // wrap to it instead of silently dropping into the lower-priority kind.
    if (target === null && previous !== undefined)
      target = await accounting.nearest(index, kind, reference)
    if (target === null) continue
    lastNavigation = { index, target }
    navigateTo({ x: target.x + 0.5, y: target.y + 0.5, width: 1, height: 1 })
    return true
  }
  warn('install', `no remaining pixel for palette colour ${index} in template ${template.id}`)
  return false
}

/** Jump to the colour's nearest remaining pixel in the focused template; `cycle` moves past the last. */
export const navigateFocusedColour = async (index: number, cycle = false): Promise<boolean> => {
  const template = focusedTemplate()
  if (template === null) return false
  const surface = template.surface ?? WORLD_TEMPLATE_SURFACE
  if (surface.kind === 'world') return navigateWorld(template, index, cycle)
  const active = editorShowing(surface)
  return active !== null && active.bounds !== null
    ? navigateArtboard(active, template, index, cycle)
    : false
}

/** The keyboard form of middle-click: use Wplace's current colour and cycle on repeated presses. */
export const navigateFocusedSelectedColour = async (): Promise<boolean> => {
  const index = selectedColour()
  return index === null ? false : await navigateFocusedColour(index, true)
}

const renderedPaletteOrder = (): readonly number[] => {
  const seen = new Set<number>()
  const order: number[] = []
  for (const element of currentPaintSwatches()) {
    const index = paintPaletteIndexOf(element)
    if (index === null || seen.has(index)) continue
    seen.add(index)
    order.push(index)
  }
  return order
}

/** Select the previous or next unfinished colour in the focused template, wrapping at either end. */
export const cycleFocusedColour = (direction: -1 | 1): boolean => {
  if (!isPaintOpen()) return false
  const order = renderedPaletteOrder()
  const remaining = new Set(
    paintPaletteProgress()
      .filter((entry) => entry.completed < entry.total)
      .map((entry) => entry.index),
  )
  if (remaining.size === 0 || order.length === 0) return false

  const selected = selectedColour()
  const selectedAt = selected === null ? -1 : order.indexOf(selected)
  let at = selectedAt >= 0 ? selectedAt : direction > 0 ? order.length - 1 : 0
  for (let visited = 0; visited < order.length; visited++) {
    at = (at + direction + order.length) % order.length
    const next = order[at]
    if (next !== undefined && remaining.has(next)) return selectPaintColour(next)
  }
  return false
}
