import {
  PALETTE_SIZE,
  type TemplateSurface,
  TRANSPARENT_INDEX,
  WPLACE_PALETTE,
} from '@caelestis/shared'
import { getState, getSurfaceAppearance, type State } from '../state.js'
import { type Appearance, isColourHidden } from '../templates/appearance.js'
import {
  appearancePreviewRevision,
  appearanceWithPreview,
  hasAppearancePreview,
} from '../templates/appearance-preview.js'
import { hiddenColoursFor } from '../templates/colour-filter.js'
import { appearanceOf, isTemplateVisible, type PlacedTemplate } from '../templates/local-store.js'
import { serverNodesRevision } from '../templates/server-nodes.js'
import { isPaintOpen, selectedColour } from '../wplace-paint.js'
import { appearanceTransitionSet } from './appearance-transition.js'
import { ramps } from './fade.js'

export interface SceneTemplate {
  readonly template: PlacedTemplate
  readonly appearance: Appearance
  readonly fade: number
  readonly outlineFade: number
  /** RGBA per palette index. Never mutated: a new array means new bytes, the same one the same. */
  readonly palette: Uint8Array | null
}

export interface SceneTemplates {
  readonly templates: readonly SceneTemplate[]
  readonly animating: boolean
}

export interface SceneMarkerTemplate {
  readonly rendered: SceneTemplate
  readonly mismatchFade: number
  readonly selectedFades: readonly { readonly index: number; readonly fade: number }[]
}

export interface SceneMarkers {
  readonly templates: readonly SceneMarkerTemplate[]
  readonly animating: boolean
}

interface RetainedTemplate {
  readonly visible: boolean
  readonly target: Appearance
  readonly hidden: readonly number[]
  readonly reducedMotion: boolean
  readonly interactive: boolean
  readonly rendered: SceneTemplate
  readonly done: boolean
}

const sameNumbers = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

const sameAppearance = (left: Appearance, right: Appearance): boolean =>
  left === right ||
  Object.entries(left).every(([key, value]) => {
    const other = right[key as keyof Appearance]
    return Array.isArray(value) && Array.isArray(other)
      ? sameNumbers(value, other)
      : value === other
  })

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false
  return true
}

/**
 * Everything a scene entry reads besides its template, the surface and the motion preference.
 *
 * Each value is replaced, or its revision moves, whenever what it covers changes: the state holds
 * folder, scope and server switches, hidden colours and the follow-selection mode; `inherited` is
 * the surface's defaults with any uncommitted slider gesture; `previews` covers per-template
 * previews; `nodes` the servers' folder trees; and the paint drawer feeds follow-selection.
 */
interface SceneInputs {
  readonly state: State
  readonly inherited: Appearance
  readonly previews: number
  readonly nodes: number
  readonly paintOpen: boolean
  readonly paintColour: number | null
}

const sceneInputs = (surface: TemplateSurface): SceneInputs => ({
  state: getState(),
  inherited: getSurfaceAppearance(surface),
  previews: appearancePreviewRevision(),
  nodes: serverNodesRevision(),
  paintOpen: isPaintOpen(),
  paintColour: selectedColour(),
})

const sameInputs = (left: SceneInputs, right: SceneInputs): boolean =>
  left.state === right.state &&
  left.inherited === right.inherited &&
  left.previews === right.previews &&
  left.nodes === right.nodes &&
  left.paintOpen === right.paintOpen &&
  left.paintColour === right.paintColour

/**
 * Owns every host-independent transition in one render scene.
 *
 * The world and artboard adapters provide projection, clipping, native pixels, movement, layer
 * insertion, and frame scheduling. They do not maintain their own visibility or appearance state.
 */
export class RenderScene {
  private prepared: {
    readonly key: object | undefined
    readonly templates: readonly PlacedTemplate[]
    readonly surface: TemplateSurface
    readonly reducedMotion: boolean
    readonly inputs: SceneInputs
    readonly result: SceneTemplates
  } | null = null
  private preparedMarkers: {
    readonly templates: readonly SceneTemplate[]
    readonly selectedColour: number | null
    readonly result: SceneMarkers
  } | null = null
  private readonly retained = new Map<string, RetainedTemplate>()
  private ids = new Set<string>()
  private readonly templateFades = ramps()
  private readonly colourFades = ramps({ startAt: 'target' })
  private readonly outlineFades = ramps({ startAt: 'target' })
  private readonly markerFades = ramps({ startAt: 'target' })
  private readonly selectedColourFades = ramps()
  private readonly selectedMarkerColours = new Set<number>()
  private latestSelectedMarkerColour: number | null = null
  private readonly appearances = appearanceTransitionSet()

  /** The template's palette now, or `previous` itself when the bytes came out the same. */
  private palette(
    templateId: string,
    hidden: readonly number[],
    now: number,
    previous: Uint8Array | null,
  ): { readonly data: Uint8Array; readonly done: boolean } {
    const off = new Set(hidden)
    const data = new Uint8Array(PALETTE_SIZE * 4)
    let done = true
    for (let index = 0; index < PALETTE_SIZE; index++) {
      const colour = WPLACE_PALETTE[index]
      const shown = colour !== undefined && index !== TRANSPARENT_INDEX && !off.has(index)
      const fade = this.colourFades.advance(`${templateId}:${index}`, shown ? 1 : 0, now)
      if (!fade.done) done = false
      data[index * 4] = colour?.rgb[0] ?? 0
      data[index * 4 + 1] = colour?.rgb[1] ?? 0
      data[index * 4 + 2] = colour?.rgb[2] ?? 0
      data[index * 4 + 3] = Math.round(fade.value * 255)
    }
    return { data: previous !== null && sameBytes(previous, data) ? previous : data, done }
  }

  /**
   * Advance every template's transitions to `now`.
   *
   * Callers sharing `frame`, a key unique to this host's current frame, advance it once. Once
   * nothing is moving, a later frame with the same templates and inputs reuses the result outright.
   */
  advanceTemplates(
    templates: readonly PlacedTemplate[],
    surface: TemplateSurface,
    now: number,
    reducedMotion: boolean,
    frame?: object,
  ): SceneTemplates {
    const inputs = sceneInputs(surface)
    const prepared = this.prepared
    if (
      prepared !== null &&
      ((frame !== undefined && prepared.key === frame) || !prepared.result.animating) &&
      prepared.surface === surface &&
      prepared.reducedMotion === reducedMotion &&
      sameInputs(prepared.inputs, inputs) &&
      prepared.templates.length === templates.length &&
      templates.every((template, index) => template === prepared.templates[index])
    )
      return prepared.result
    if (templates.length !== this.ids.size || templates.some(({ id }) => !this.ids.has(id))) {
      this.ids = new Set(templates.map(({ id }) => id))
      this.templateFades.prune(this.ids)
      this.outlineFades.prune(this.ids)
      this.appearances.prune(this.ids)
      for (const id of this.retained.keys()) if (!this.ids.has(id)) this.retained.delete(id)
      this.colourFades.prune(
        new Set(
          templates.flatMap((template) =>
            Array.from({ length: PALETTE_SIZE }, (_, index) => `${template.id}:${index}`),
          ),
        ),
      )
    }

    let animating = false
    const rendered = templates.map((template): SceneTemplate => {
      const visible = isTemplateVisible(template)
      const target = appearanceWithPreview(template.id, appearanceOf(template))
      const interactive = hasAppearancePreview(template.id)
      const hidden = hiddenColoursFor(target, surface)
      const held = this.retained.get(template.id)
      if (
        held?.done &&
        held.rendered.template === template &&
        held.visible === visible &&
        held.reducedMotion === reducedMotion &&
        held.interactive === interactive &&
        sameAppearance(held.target, target) &&
        sameNumbers(held.hidden, hidden)
      )
        return held.rendered

      const fade = this.templateFades.advance(template.id, visible ? 1 : 0, now)
      const transitioned = this.appearances.advance(
        template.id,
        target,
        now,
        reducedMotion,
        interactive,
      )
      const outline = this.outlineFades.advance(
        template.id,
        transitioned.appearance.contrastOutline ? 1 : 0,
        now,
      )
      const palette =
        fade.value > 0
          ? this.palette(template.id, hidden, now, held?.rendered.palette ?? null)
          : null
      const done =
        fade.done && transitioned.done && outline.done && (palette === null || palette.done)
      if (!done) animating = true
      const rendered = {
        template,
        appearance: transitioned.appearance,
        fade: fade.value,
        outlineFade: outline.value,
        palette: palette?.data ?? null,
      }
      this.retained.set(template.id, {
        visible,
        target,
        hidden: hidden.slice(),
        reducedMotion,
        interactive,
        rendered,
        done,
      })
      return rendered
    })
    const result = { templates: rendered, animating }
    // The world passes its current quad array, replaced at every captured map frame. Other hosts
    // may omit the key. Each host owns its scene, so nothing prepared crosses a host.
    this.prepared = { key: frame, templates, surface, reducedMotion, inputs, result }
    return result
  }

  /** Advance marker fades. Settled templates and an unchanged selection reuse the last result. */
  advanceMarkers(
    templates: readonly SceneTemplate[],
    selectedColour: number | null,
    now: number,
  ): SceneMarkers {
    const prepared = this.preparedMarkers
    if (
      prepared !== null &&
      !prepared.result.animating &&
      prepared.templates === templates &&
      prepared.selectedColour === selectedColour
    )
      return prepared.result
    let animating = false
    if (selectedColour !== null && selectedColour !== this.latestSelectedMarkerColour) {
      this.selectedMarkerColours.add(selectedColour)
      this.latestSelectedMarkerColour = selectedColour
    }
    const selectedKeys = new Set<string>()
    const selectedFades: { readonly index: number; readonly fade: number }[] = []
    for (const index of [...this.selectedMarkerColours]) {
      const key = String(index)
      const target = index === this.latestSelectedMarkerColour ? 1 : 0
      const fade = this.selectedColourFades.advance(key, target, now)
      if (!fade.done) animating = true
      if (target > 0 || fade.value > 0 || !fade.done) selectedKeys.add(key)
      if (fade.value > 0) selectedFades.push({ index, fade: fade.value })
      if (target === 0 && fade.done) this.selectedMarkerColours.delete(index)
    }
    this.selectedColourFades.prune(selectedKeys)

    const markerKeys = new Set<string>()
    const rendered = templates.map((scene): SceneMarkerTemplate => {
      const { template, appearance, fade: templateFade } = scene
      const mismatchKey = `mismatch:${template.id}`
      const selectedKey = `selected:${template.id}`
      markerKeys.add(mismatchKey)
      markerKeys.add(selectedKey)
      const mismatch = this.markerFades.advance(mismatchKey, appearance.markMismatch ? 1 : 0, now)
      const selected = this.markerFades.advance(
        selectedKey,
        appearance.markSelectedColour &&
          selectedColour !== null &&
          !isColourHidden(appearance, selectedColour)
          ? 1
          : 0,
        now,
      )
      if (!mismatch.done || !selected.done) animating = true
      return {
        rendered: scene,
        mismatchFade: mismatch.value * templateFade,
        selectedFades: selectedFades
          .filter(({ index }) => !isColourHidden(appearance, index))
          .map(({ index, fade }) => ({
            index,
            fade: fade * selected.value * templateFade,
          })),
      }
    })
    this.markerFades.prune(markerKeys)
    const result = { templates: rendered, animating }
    this.preparedMarkers = { templates, selectedColour, result }
    return result
  }

  resetMarkers(): void {
    this.preparedMarkers = null
    this.selectedMarkerColours.clear()
    this.latestSelectedMarkerColour = null
    this.selectedColourFades.prune(new Set())
    this.markerFades.prune(new Set())
  }
}

export const worldRenderScene = new RenderScene()
