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
  /**
   * The control to focus when the menu mounts: `'close'` for the close button, or a key from a
   * `focus` intent. A key is a position, so it lands on whatever control holds that position now,
   * else on the close button. Omitted, the menu takes no focus.
   */
  readonly focus?: string
}

export type OverlayControlsIntent =
  | { readonly type: 'close' }
  /** Focus moved to a control in the menu, named by an opaque key, or to something else (null). */
  | { readonly type: 'focus'; readonly control: string | null }
  | { readonly type: 'update-artwork' }
  | { readonly type: 'appearance'; readonly intent: AppearanceEditorIntent }
