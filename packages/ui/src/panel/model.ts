import type { AppearanceEditorIntent, AppearanceEditorModel } from '../appearance/model.js'
import type { SettingsIntent, SettingsModel } from '../settings/model.js'
import type { TemplateTreeIntent, TemplateTreeModel } from '../tree/model.js'

export type PanelView = 'tree' | 'settings' | 'appearance'

export interface PanelModel {
  readonly view: PanelView
  readonly title?: string
  readonly showSettings?: boolean
  readonly width: number
  readonly minWidth: number
  readonly maxWidth: number
  readonly tree?: TemplateTreeModel
  readonly work?: {
    readonly tree: TemplateTreeModel
    readonly error: string
    readonly canShowOthers: boolean
    readonly presence?: PresenceSummaryModel
  }
  readonly showOtherClaims?: boolean
  readonly appearance?: AppearanceEditorModel
  readonly settings?: SettingsModel
}

/** One painter near the viewport, as the Painters drawer lists them. */
export interface PainterRowModel {
  /** Their presence session; stable across renders. */
  readonly key: string
  readonly name: string
  readonly userId: number
  /** The painter's presence colour, as CSS. */
  readonly colour: string
  /** What they are up to: "painting 120 px", "browsing", or "online" without a viewport. */
  readonly activity: string
  /** Whether Fly to has somewhere to go: their drafted pixels or their viewport. */
  readonly canFly: boolean
}

/** One region claim, as the Painters drawer lists them. */
export interface ClaimRowModel {
  /** The claim's logical id; stable across renders. */
  readonly key: string
  /** The claimant's display name; "You" for the current painter. */
  readonly name: string
  readonly userId: number
  /** The claimant's presence colour, as CSS. */
  readonly colour: string
  /** The shapes and bounding size: "rectangle · 320×180". */
  readonly description: string
  /** Whether this claim belongs to the current painter. */
  readonly mine: boolean
  /** Whether the current connection can explicitly clear this claim. */
  readonly canClear?: boolean
  readonly clearing?: boolean
}

/** The server's painter headcount, and the painters it sends for the current viewport. */
export interface PresenceSummaryModel {
  readonly online: number
  readonly connected: boolean
  readonly players: readonly PainterRowModel[]
  /** Every known region claim, the current painter's first. */
  readonly claims?: readonly ClaimRowModel[]
  /** Whether the claim tool can start: signed in, connected, and not already open. */
  readonly canClaim: boolean
  readonly pending?: boolean
  readonly message?: string
}

export type PanelIntent =
  | { readonly type: 'work-retry' }
  | { readonly type: 'work-visibility'; readonly showOtherClaims: boolean }
  | { readonly type: 'region-claim' }
  | { readonly type: 'presence-fly'; readonly key: string }
  | { readonly type: 'claim-fly'; readonly key: string }
  | { readonly type: 'claim-clear'; readonly key: string }
  | { readonly type: 'work-tree'; readonly intent: TemplateTreeIntent }
  | { readonly type: 'navigate'; readonly view: PanelView }
  | { readonly type: 'close' }
  | { readonly type: 'reload-tiles' }
  | { readonly type: 'popout'; readonly open: boolean }
  | { readonly type: 'resize-preview'; readonly width: number }
  | { readonly type: 'resize-commit'; readonly width: number }
  | { readonly type: 'tree'; readonly intent: TemplateTreeIntent }
  | { readonly type: 'appearance'; readonly intent: AppearanceEditorIntent }
  | { readonly type: 'settings'; readonly intent: SettingsIntent }
