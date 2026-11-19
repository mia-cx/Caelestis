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
  /** The control to focus when the menu mounts, by its `focus` intent key; else the close button. */
  readonly focus?: string
}

export type OverlayControlsIntent =
  | { readonly type: 'close' }
  /** Focus moved to a control in the menu, named by a stable key, or to something unnamed. */
  | { readonly type: 'focus'; readonly control: string | null }
  | { readonly type: 'update-artwork' }
  | { readonly type: 'appearance'; readonly intent: AppearanceEditorIntent }
