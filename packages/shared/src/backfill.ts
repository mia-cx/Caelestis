import type { PixelBounds } from './slice.js'

/** Eralyon snapshot identifiers are hours since 2025-01-01 UTC. */
export interface ArchiveSnapshot {
  readonly id: number
  readonly at: number
}

/** The immutable artwork and position used to interpret archived pixels. */
export interface BackfillBasis {
  readonly templateId: string
  readonly versionId: string
  readonly name: string
  readonly season: number
  readonly bbox: PixelBounds
  readonly total: number
  readonly chunks: readonly {
    readonly tileX: number
    readonly tileY: number
    readonly hash: string
  }[]
}

/** An import's progress, counted in archive tile reads: one per snapshot and tile. */
export interface BackfillProgress {
  readonly id: string
  readonly from: number
  readonly to: number
  readonly status: 'running' | 'cancelled' | 'completed' | 'failed'
  readonly completed: number
  readonly total: number
  readonly imported: number
  readonly skipped: number
  readonly failed: number
  readonly error: string | null
}

export interface BackfillJob extends BackfillProgress {
  readonly basis: BackfillBasis
}

/** One import for every template below a folder, reading each shared archive tile once. */
export interface FolderBackfillJob extends BackfillProgress {
  readonly templateIds: readonly string[]
}

/** What the backfill form offers: snapshots before the history cutoff and the tiles each reads. */
export interface BackfillCoverage {
  readonly snapshots: readonly ArchiveSnapshot[]
  readonly end: number
  readonly tileCount: number
}

export interface BackfillPreview extends BackfillCoverage {
  readonly basis: BackfillBasis
  readonly job: BackfillJob | null
}

/** A folder's coverage spans its templates: snapshots up to the latest cutoff, tiles combined. */
export interface FolderBackfillPreview extends BackfillCoverage {
  readonly bases: readonly BackfillBasis[]
  readonly job: FolderBackfillJob | null
}

/** A complete-template observation, or an explicit gap when any required tile is absent. */
export interface ArchiveProgressSample {
  readonly at: number
  readonly snapshotId: number
  readonly correct: number | null
  readonly mismatched: number | null
  readonly total: number
  /** Composite artwork basis when several imported histories are combined. */
  readonly revision?: string
}

export interface ArchiveTileFrame {
  readonly at: number
  readonly snapshotId: number
  /** A null hash marks missing coverage, never a blank canvas. */
  readonly hash: string | null
}

export interface ArchiveHistory {
  readonly source: 'eralyon'
  readonly basis: BackfillBasis | null
  readonly samples: readonly ArchiveProgressSample[]
  readonly frames: readonly ArchiveTileFrame[]
}
