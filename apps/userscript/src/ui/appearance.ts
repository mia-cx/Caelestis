import { type TemplateSurface, TRANSPARENT_INDEX, WPLACE_PALETTE } from '@caelestis/shared'
import type {
  AppearanceEditorIntent,
  AppearanceEditorModel,
  AppearanceGroupKey,
} from '@caelestis/ui/elements'
import { redraw } from '../map-view.js'
import { MARKER_BUDGET_OPTIONS } from '../marker-budget.js'
import {
  getState,
  getSurfaceAppearance,
  onlySelectedColourFor,
  previewSurfaceAppearance,
  setOnlySelectedColourFor,
  setState,
  setSurfaceAppearance,
} from '../settings.js'
import {
  APPEARANCE_CONTROLS,
  type Appearance,
  DEFAULT_APPEARANCE,
  GROUP_FIELDS,
  PIXEL_STYLE_PRESETS,
  pixelStylePresetOf,
} from '../templates/appearance.js'
import { hiddenColoursFor } from '../templates/colour-filter.js'
import { ownedColours } from '../wplace-account.js'
import { isPaintOpen, selectedColour } from '../wplace-paint.js'
import { activeColourPreset, type ColourPresetId, hiddenForPreset } from './colours.js'
import type { AppearanceUpdater } from './overlay-appearance-state.js'

/**
 * One appearance editor over two stores: a canvas's defaults in the panel, and one template's own
 * values in its overlay menu. Both build the same model and read the same intents; only where a
 * change is kept differs.
 */

const COLOUR_PRESETS: readonly (readonly [ColourPresetId, string])[] = [
  ['all', 'All'],
  ['free', 'Free'],
  ['premium', 'Premium'],
  ['owned', 'Owned'],
]

const isColourPreset = (id: string): id is ColourPresetId =>
  COLOUR_PRESETS.some(([preset]) => preset === id)

const sliderFormat = (key: (typeof APPEARANCE_CONTROLS)[number]['key']) =>
  key === 'rotation' ? 'degrees' : key === 'contrastOutlineSize' ? 'decimal-pixels' : 'percent'

interface AppearanceSource {
  /** The values on screen, any unsaved preview included. */
  readonly values: Appearance
  /** What each slider resets to. */
  readonly defaults: Appearance
  /** Colours actually hidden on the canvas, after only-selected-colour. */
  readonly hidden: ReadonlySet<number>
  readonly disabled?: boolean
  /** Grey out the Owned preset while the account's colours are unknown. */
  readonly ownedUnknown?: boolean
}

/** The parts of the editor's model both stores share. */
export const appearanceEditorModel = ({
  values,
  defaults,
  hidden,
  disabled = false,
  ownedUnknown = false,
}: AppearanceSource): Pick<
  AppearanceEditorModel,
  'values' | 'sliders' | 'pixelPresets' | 'colourPresets' | 'palette' | 'paintOpen'
> => {
  const activePixelPreset = pixelStylePresetOf(values)
  const activePreset = activeColourPreset(values.hiddenColours)
  return {
    values,
    sliders: APPEARANCE_CONTROLS.map((control) => ({
      key: control.key,
      label: control.label,
      value: values[control.key],
      defaultValue: defaults[control.key],
      min: control.min,
      max: control.max,
      step: control.step,
      format: sliderFormat(control.key),
      ...(disabled || (control.key === 'contrastOutlineSize' && !values.contrastOutline)
        ? { disabled: true }
        : {}),
    })),
    pixelPresets: PIXEL_STYLE_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      active: preset.id === activePixelPreset,
    })),
    colourPresets: COLOUR_PRESETS.map(([id, label]) => ({
      id,
      label,
      active: id === activePreset,
      ...(id === 'owned' && ownedUnknown ? { disabled: true } : {}),
    })),
    palette: WPLACE_PALETTE.filter((colour) => colour.index !== TRANSPARENT_INDEX).map(
      (colour) => ({
        index: colour.index,
        name: colour.name,
        hex: colour.hex,
        kind: colour.kind,
        visible: !hidden.has(colour.index),
      }),
    ),
    paintOpen: isPaintOpen(),
  }
}

/** One change to save: what it touches, how a refusal names it, and the patch over stored values. */
export interface AppearanceChange {
  readonly properties: readonly string[]
  readonly label: string
  readonly patch: AppearanceUpdater
  /** Whether the stored values already say what was asked, for a store that retries. */
  readonly satisfied?: () => boolean
}

/** Where an appearance editor keeps what it changes. */
export interface AppearanceStore {
  /** Show a dragged value without saving it. */
  readonly preview: <K extends keyof Appearance>(key: K, value: Appearance[K]) => void
  /** Save the value a drag ended on, labelled for a refusal. */
  readonly commitPreview: <K extends keyof Appearance>(
    key: K,
    value: Appearance[K],
    label: string,
  ) => void
  readonly commit: (change: AppearanceChange) => void
  readonly toggleColour: (index: number, visible: boolean) => void
  readonly layout?: (settled: boolean) => void
  readonly onlySelectedColour?: (on: boolean) => void
  readonly markerBudget?: (budget: number) => void
  readonly groupOwned?: (group: AppearanceGroupKey, owned: boolean) => void
}

/** Apply one editor intent to a store. */
export const handleAppearanceIntent = (
  store: AppearanceStore,
  intent: AppearanceEditorIntent,
): void => {
  switch (intent.type) {
    case 'layout':
      store.layout?.(intent.settled === true)
      break
    case 'preview-number':
      store.preview(intent.key, intent.value)
      break
    case 'preview-colour':
      store.preview(intent.key, intent.value)
      break
    case 'commit-number':
      store.commitPreview(
        intent.key,
        intent.value,
        APPEARANCE_CONTROLS.find((control) => control.key === intent.key)?.label.toLowerCase() ??
          intent.key,
      )
      break
    case 'commit-colour':
      store.commitPreview(intent.key, intent.value, intent.key)
      break
    case 'set-boolean':
    case 'set-colour': {
      const { key, value } = intent
      store.commit({ properties: [key], label: key, patch: () => ({ [key]: value }) })
      break
    }
    case 'pixel-preset': {
      const preset = PIXEL_STYLE_PRESETS.find((candidate) => candidate.id === intent.id)
      if (preset === undefined) break
      store.commit({
        properties: GROUP_FIELDS.pixels,
        label: 'pixel style',
        patch: () => preset.values,
      })
      break
    }
    case 'colour-preset': {
      if (!isColourPreset(intent.id)) break
      const hiddenColours = hiddenForPreset(intent.id)
      store.commit({
        properties: ['hiddenColours'],
        label: 'colour preset',
        patch: () => ({ hiddenColours }),
      })
      break
    }
    case 'toggle-colour':
      store.toggleColour(intent.index, intent.visible)
      break
    case 'only-selected-colour':
      store.onlySelectedColour?.(intent.value)
      break
    case 'marker-budget':
      store.markerBudget?.(intent.value)
      break
    case 'set-group-owned':
      store.groupOwned?.(intent.group, intent.owned)
      break
  }
}

/** The panel's editor for a canvas's defaults: the world's, or one alliance canvas's. */
export const surfaceAppearanceModel = (surface: TemplateSurface): AppearanceEditorModel => {
  const values = getSurfaceAppearance(surface)
  const selected = selectedColour()
  const selectedColourName = selected === null ? undefined : WPLACE_PALETTE[selected]?.name
  return {
    ...appearanceEditorModel({
      values,
      defaults: DEFAULT_APPEARANCE,
      hidden: new Set(hiddenColoursFor(values, surface)),
      ownedUnknown: ownedColours() === null,
    }),
    onlySelectedColour: onlySelectedColourFor(surface),
    showOnlySelectedColour: true,
    showMarkers: true,
    ...(selectedColourName === undefined ? {} : { selectedColourName }),
    markerBudget: getState().markerBudget,
    markerBudgetOptions: MARKER_BUDGET_OPTIONS,
  }
}

/**
 * A canvas's defaults as a store. Committed changes notify state listeners, which redraw; a
 * preview notifies nobody, so it redraws itself.
 */
export const surfaceAppearanceStore = (surface: TemplateSurface): AppearanceStore => {
  const commit = (next: Appearance): void => {
    if (surface.kind !== 'world') {
      setSurfaceAppearance(surface, next)
      return
    }
    // The world keeps its hidden colours apart from the rest of its appearance.
    if (next.hiddenColours !== getSurfaceAppearance(surface).hiddenColours)
      setState({ hiddenColours: next.hiddenColours })
    else setState({ appearance: next })
  }
  return {
    preview: (key, value) => {
      previewSurfaceAppearance(surface, { ...getSurfaceAppearance(surface), [key]: value })
      redraw()
    },
    commitPreview: (key, value) => commit({ ...getSurfaceAppearance(surface), [key]: value }),
    commit: ({ patch }) => {
      const values = getSurfaceAppearance(surface)
      commit({ ...values, ...patch(values) })
    },
    toggleColour: (index, visible) => {
      const values = getSurfaceAppearance(surface)
      const base =
        onlySelectedColourFor(surface) && isPaintOpen()
          ? hiddenColoursFor(values, surface)
          : values.hiddenColours
      const hidden = new Set(base)
      if (visible) hidden.delete(index)
      else hidden.add(index)
      if (surface.kind === 'world') {
        setState({ hiddenColours: [...hidden], onlySelectedColour: false })
      } else {
        setSurfaceAppearance(surface, { ...values, hiddenColours: [...hidden] })
        setOnlySelectedColourFor(surface, false)
      }
    },
    onlySelectedColour: (on) => setOnlySelectedColourFor(surface, on),
    markerBudget: (budget) => {
      const option = MARKER_BUDGET_OPTIONS.find((candidate) => candidate === budget)
      if (option !== undefined) setState({ markerBudget: option })
    },
  }
}
