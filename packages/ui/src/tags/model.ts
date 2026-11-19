import type { TemplateTag } from '@caelestis/shared'

export interface TagManagerModel {
  /** False closes the dialog; it emits `closed` once its exit ends, and the host removes it. */
  readonly open: boolean
  readonly owner: string
  readonly targetName?: string
  readonly tags: readonly TemplateTag[]
  readonly selected: readonly string[]
  readonly loading: boolean
  readonly ready: boolean
  readonly busy: boolean
  readonly error?: string | undefined
  readonly revision: number
}

export type TagManagerIntent =
  | { readonly type: 'close' }
  | { readonly type: 'closed' }
  | { readonly type: 'retry' }
  | { readonly type: 'create'; readonly name: string }
  | { readonly type: 'rename'; readonly id: string; readonly name: string }
  | { readonly type: 'delete'; readonly id: string }
  | { readonly type: 'assign'; readonly id: string; readonly attached: boolean }
