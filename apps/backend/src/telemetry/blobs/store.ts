import type { Millis } from '@caelestis/shared'

export type TileBlobObjectState = 'uploading' | 'active' | 'candidate' | 'deleting' | 'deleted'

export interface TileBlobObject {
  /** Key relative to `tiles/`. A suffix makes a restored generation immune to an older delete. */
  readonly blobKey: string
  readonly hash: string
  readonly state: TileBlobObjectState
  readonly discoveredAt: Millis
  readonly deleteStartedAt: Millis | null
  readonly deleteAttempts: number
  readonly reclaimedAt: Millis | null
}

/** A live ingest claim. GC may not fence this hash until the claim commits or expires. */
export interface TileBlobReservation {
  readonly id: string
  readonly hash: string
  readonly blobKey: string
  readonly expiresAt: Millis
}

export type TileBlobCandidateResult = 'candidate' | 'referenced' | 'deleting' | 'deleted'
export type TileBlobClaimResult = 'claimed' | 'blocked' | 'missing'

export interface TileBlobScanState {
  readonly cursor?: string
  readonly completedSweeps: number
}

/**
 * Tile bytes' lifecycle: ingest reserves an object, `TileStore.commitTileObservation` consumes the
 * reservation, and garbage collection fences and reclaims one.
 */
export interface TileBlobStore {
  /** The preferred readable physical object for a hash, if one is registered and unfenced. */
  readTileBlob(hash: string): Promise<TileBlobObject | null>

  /**
   * Reserve existing bytes for an observation. A candidate returns to active before its fence;
   * a deleting hash refuses until its old physical key has been reconciled.
   */
  reserveTileBlob(
    hash: string,
    reservationId: string,
    now: Millis,
    expiresAt: Millis,
  ): Promise<TileBlobReservation | null>

  /** Reuse an active/uploading generation, or reserve a fresh key before its bytes are written. */
  reserveTileBlobUpload(
    hash: string,
    blobKey: string,
    reservationId: string,
    now: Millis,
    expiresAt: Millis,
  ): Promise<TileBlobReservation | null>

  releaseTileBlobReservation(reservationId: string): Promise<void>

  /** Record one object found by a bounded scan and classify it against live SQL references. */
  noteTileBlobObject(hash: string, blobKey: string, now: Millis): Promise<TileBlobCandidateResult>

  /** Deleting rows come first so interrupted work resumes before new candidates start. */
  listTileBlobDeletionWork(limit: number): Promise<readonly TileBlobObject[]>

  /** Fence a candidate only after atomically rechecking both reference tables and reservations. */
  claimTileBlobDeletion(blobKey: string, now: Millis): Promise<TileBlobClaimResult>

  /** Finalize an idempotent delete. Only a fenced row can become deleted. */
  finishTileBlobDeletion(blobKey: string, reclaimedAt: Millis): Promise<void>

  readTileBlobScanState(): Promise<TileBlobScanState>

  writeTileBlobScanState(cursor: string | undefined): Promise<void>
}
