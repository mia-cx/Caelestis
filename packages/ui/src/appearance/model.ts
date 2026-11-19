export type AppearanceNumberKey =
  | 'size'
  | 'radius'
  | 'translateX'
  | 'translateY'
  | 'rotation'
  | 'opacity'
  | 'contrastOutlineSize'
  | 'unpaintedLimit'
  | 'markerSize'
  | 'selectedMarkerSize'
  | 'otherOpacity'

export type AppearanceBooleanKey =
  | 'contrastOutline'
  | 'markMismatch'
  | 'markUnpainted'
  | 'markSelectedColour'
  | 'dimOthers'

export type AppearanceColourKey = 'markerColour' | 'selectedMarkerColour' | 'otherColour'

export type AppearanceGroupKey = 'pixels' | 'markers' | 'colours'

export interface AppearanceGroupModel {
  readonly owned: boolean
  readonly locked?: boolean
}

export interface AppearanceValuesModel {
  readonly size: number
  readonly radius: number
  readonly translateX: number
  readonly translateY: number
  readonly rotation: number
  readonly opacity: number
  readonly contrastOutline: boolean
  readonly contrastOutlineSize: number
  readonly markMismatch: boolean
  readonly markUnpainted: boolean
  readonly unpaintedLimit: number
  readonly markerColour: string
  readonly markerSize: number
  readonly markSelectedColour: boolean
  readonly selectedMarkerColour: string
  readonly selectedMarkerSize: number
  readonly dimOthers: boolean
  readonly otherOpacity: number
  readonly otherColour: string | null
}

export interface AppearanceSliderModel {
  readonly key: AppearanceNumberKey
  /** Pixel sliders list in model order; marker sliders sit under the switch they refine. */
  readonly group: 'pixels' | 'markers'
  readonly label: string
  readonly value: number
  readonly defaultValue: number
  readonly min: number
  readonly max: number
  readonly step: number
  readonly format: 'percent' | 'degrees' | 'pixels' | 'decimal-pixels'
  readonly disabled?: boolean
}

export interface AppearancePresetModel {
  readonly id: string
  readonly label: string
  readonly active: boolean
  readonly disabled?: boolean
}

export interface AppearancePaletteColourModel {
  readonly index: number
  readonly name: string
  readonly hex: string
  readonly kind: 'free' | 'premium'
  readonly visible: boolean
}

export interface AppearanceEditorModel {
  /** The global defaults page, or one template's compact overlay menu with collapsible groups. */
  readonly variant: 'defaults' | 'overlay'
  readonly values: AppearanceValuesModel
  readonly sliders: readonly AppearanceSliderModel[]
  readonly pixelPresets: readonly AppearancePresetModel[]
  readonly colourPresets: readonly AppearancePresetModel[]
  readonly palette: readonly AppearancePaletteColourModel[]
  readonly onlySelectedColour: boolean
  readonly showOnlySelectedColour?: boolean
  /** Marker accounting is unavailable on drawing surfaces that do not expose paint snapshots. */
  readonly showMarkers?: boolean
  readonly paintOpen: boolean
  readonly selectedColourName?: string
  readonly markerBudget?: number
  readonly markerBudgetOptions?: readonly number[]
  readonly groups?: Readonly<Record<AppearanceGroupKey, AppearanceGroupModel>>
  readonly disabled?: boolean
}

export type AppearanceEditorIntent =
  | { readonly type: 'layout'; readonly settled?: boolean }
  /** A colour picker opened or closed; hosts hold rebuilds while one is open. */
  | { readonly type: 'picker'; readonly open: boolean }
  | {
      readonly type: 'preview-number'
      readonly key: AppearanceNumberKey
      readonly value: number
    }
  | {
      readonly type: 'commit-number'
      readonly key: AppearanceNumberKey
      readonly value: number
    }
  | {
      readonly type: 'set-boolean'
      readonly key: AppearanceBooleanKey
      readonly value: boolean
    }
  | {
      readonly type: 'set-colour'
      readonly key: AppearanceColourKey
      readonly value: string | null
    }
  | { readonly type: 'preview-colour'; readonly key: AppearanceColourKey; readonly value: string }
  | { readonly type: 'commit-colour'; readonly key: AppearanceColourKey; readonly value: string }
  | { readonly type: 'pixel-preset'; readonly id: string }
  | { readonly type: 'colour-preset'; readonly id: string }
  | { readonly type: 'toggle-colour'; readonly index: number; readonly visible: boolean }
  | { readonly type: 'only-selected-colour'; readonly value: boolean }
  | { readonly type: 'marker-budget'; readonly value: number }
  | {
      readonly type: 'set-group-owned'
      readonly group: AppearanceGroupKey
      readonly owned: boolean
    }
