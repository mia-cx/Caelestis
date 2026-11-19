import type { ServerAssetKind } from '@caelestis/shared'

/** The editable public presentation of one server. Empty strings mean "not set". */
export interface ServerDetailsFields {
  readonly name: string
  readonly description: string
  readonly discordInviteUrl: string
  readonly homeCopy: string
  readonly logoText: string
}

export interface ServerDetailsModel extends ServerDetailsFields {
  /** False closes the dialog; it emits `closed` once its exit ends, and the host removes it. */
  readonly open: boolean
  /** Which server this edits, shown so a rack of servers cannot be confused. */
  readonly owner: string
  /** Browser-loadable URLs of the current uploads, or null when none is set. */
  readonly logoImageUrl: string | null
  readonly previewImageUrl: string | null
  readonly busy: boolean
  readonly error?: string | undefined
  readonly notice?: string | undefined
  /** Bumped after every committed write so the form re-seeds from the model. */
  readonly revision: number
}

export type ServerDetailsIntent =
  | { readonly type: 'close' }
  | { readonly type: 'closed' }
  | { readonly type: 'save'; readonly fields: ServerDetailsFields }
  | { readonly type: 'upload'; readonly kind: ServerAssetKind; readonly file: File }
  | { readonly type: 'clear-asset'; readonly kind: ServerAssetKind }
