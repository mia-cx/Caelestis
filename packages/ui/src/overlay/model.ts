import type { AppearanceEditorIntent, AppearanceEditorModel } from '../appearance/model.js'

export interface OverlayFailureModel {
  readonly id: string
  readonly message: string
  readonly announce: boolean
}

export interface OverlayControlsModel {
  readonly name: string
  readonly updateArtwork?: { readonly pending: boolean; readonly disabled: boolean }
  readonly lifecycle?: {
    readonly finished: boolean
    readonly frozen: boolean
    readonly griefed: boolean
  }
  readonly failures: readonly OverlayFailureModel[]
  readonly appearance: AppearanceEditorModel
}

export type OverlayControlsIntent =
  | { readonly type: 'close' }
  | { readonly type: 'update-artwork' }
  | { readonly type: 'appearance'; readonly intent: AppearanceEditorIntent }
