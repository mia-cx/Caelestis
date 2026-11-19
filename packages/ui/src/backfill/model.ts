import type { BackfillCoverage, BackfillProgress } from '@caelestis/shared'

export interface BackfillModel {
  readonly name: string
  /** Templates a folder import covers; null when the form imports one template. */
  readonly templates: number | null
  readonly previewUrl: string | null
  readonly preview: BackfillCoverage | null
  readonly job: BackfillProgress | null
  readonly selectedSnapshot: number | null
  readonly loading: boolean
  readonly busy: boolean
  readonly error: string | null
}

export type BackfillIntent =
  | { readonly type: 'close' | 'reload' | 'start' | 'cancel' }
  | { readonly type: 'select'; readonly snapshotId: number }
