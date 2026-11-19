import type { Millis } from '@caelestis/shared'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { RelationalStore } from '../../adapters/relational-store.js'
import { tileBlobGcState, tileBlobObjects } from '../../db/schema.js'
import type {
  TileBlobCandidateResult,
  TileBlobClaimResult,
  TileBlobObject,
  TileBlobReservation,
  TileBlobScanState,
  TileBlobStore,
} from './store.js'

const toTileBlobObject = (row: typeof tileBlobObjects.$inferSelect): TileBlobObject => ({
  blobKey: row.blobKey,
  hash: row.sha256,
  state: row.state,
  discoveredAt: row.discoveredAtMs,
  deleteStartedAt: row.deleteStartedAtMs,
  deleteAttempts: row.deleteAttempts,
  reclaimedAt: row.reclaimedAtMs,
})

/**
 * Whether the `tile_blob_objects` row being updated still holds bytes something needs: a live
 * reservation of its key (binds `now`), or SQL references while no other key of its hash is active.
 */
const CLAIMED_OBJECT_REFERENCED = `EXISTS (
    SELECT 1 FROM tile_blob_reservations
    WHERE sha256 = tile_blob_objects.sha256
      AND blob_key = tile_blob_objects.blob_key AND expires_at_ms > ?
  ) OR (
    (
      EXISTS (SELECT 1 FROM tile_history WHERE sha256 = tile_blob_objects.sha256)
      OR EXISTS (SELECT 1 FROM canvas_tiles WHERE sha256 = tile_blob_objects.sha256)
    ) AND NOT EXISTS (
      SELECT 1 FROM tile_blob_objects AS active
      WHERE active.sha256 = tile_blob_objects.sha256
        AND active.blob_key <> tile_blob_objects.blob_key
        AND active.state = 'active'
    )
  )`

export class RelationalTileBlobStore extends RelationalStore implements TileBlobStore {
  async readTileBlob(hash: string): Promise<TileBlobObject | null> {
    const rows = await this.database
      .select()
      .from(tileBlobObjects)
      .where(and(eq(tileBlobObjects.sha256, hash), eq(tileBlobObjects.state, 'active')))
      .orderBy(asc(tileBlobObjects.blobKey))
      .limit(1)
    return rows[0] === undefined ? null : toTileBlobObject(rows[0])
  }

  async reserveTileBlob(
    hash: string,
    reservationId: string,
    now: Millis,
    expiresAt: Millis,
  ): Promise<TileBlobReservation | null> {
    const results = await this.client.batch([
      this.client.prepare('DELETE FROM tile_blob_reservations WHERE expires_at_ms <= ?').bind(now),
      this.client
        .prepare(
          `INSERT INTO tile_blob_reservations (id, sha256, blob_key, expires_at_ms)
           SELECT ?, object.sha256, object.blob_key, ?
           FROM tile_blob_objects AS object
           WHERE object.sha256 = ?
             AND object.state IN ('active', 'candidate', 'uploading')
             AND NOT EXISTS (
               SELECT 1 FROM tile_blob_objects AS deleting
               WHERE deleting.sha256 = object.sha256 AND deleting.state = 'deleting'
             )
           ORDER BY CASE object.state WHEN 'active' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,
             object.blob_key
           LIMIT 1
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(reservationId, expiresAt, hash),
      this.client
        .prepare(
          `UPDATE tile_blob_objects SET state = 'active', reclaimed_at_ms = NULL
           WHERE blob_key = (
             SELECT blob_key FROM tile_blob_reservations WHERE id = ?
           ) AND state IN ('candidate', 'uploading')`,
        )
        .bind(reservationId),
    ])
    if (Number(results[1]?.meta.changes) === 0) return null
    return this.readReservation(reservationId)
  }

  async reserveTileBlobUpload(
    hash: string,
    blobKey: string,
    reservationId: string,
    now: Millis,
    expiresAt: Millis,
  ): Promise<TileBlobReservation | null> {
    const results = await this.client.batch([
      this.client.prepare('DELETE FROM tile_blob_reservations WHERE expires_at_ms <= ?').bind(now),
      this.client
        .prepare(
          `INSERT INTO tile_blob_objects (
             blob_key, sha256, state, discovered_at_ms, delete_attempts
           )
           SELECT ?, ?, 'uploading', ?, 0
           WHERE NOT EXISTS (
             SELECT 1 FROM tile_blob_objects
             WHERE sha256 = ? AND state = 'deleting'
           ) AND NOT EXISTS (
             SELECT 1 FROM tile_blob_objects
             WHERE sha256 = ? AND state IN ('active', 'uploading')
           )
           ON CONFLICT(blob_key) DO NOTHING`,
        )
        .bind(blobKey, hash, now, hash, hash),
      this.client
        .prepare(
          `INSERT INTO tile_blob_reservations (id, sha256, blob_key, expires_at_ms)
           SELECT ?, object.sha256, object.blob_key, ?
           FROM tile_blob_objects AS object
           WHERE object.sha256 = ?
             AND object.state IN ('active', 'uploading')
             AND NOT EXISTS (
               SELECT 1 FROM tile_blob_objects AS deleting
               WHERE deleting.sha256 = object.sha256 AND deleting.state = 'deleting'
             )
           ORDER BY CASE object.state WHEN 'active' THEN 0 ELSE 1 END, object.blob_key
           LIMIT 1
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(reservationId, expiresAt, hash),
    ])
    if (Number(results[2]?.meta.changes) === 0) return null
    return this.readReservation(reservationId)
  }

  private async readReservation(reservationId: string): Promise<TileBlobReservation | null> {
    const row = await this.client
      .prepare(
        'SELECT id, sha256, blob_key, expires_at_ms FROM tile_blob_reservations WHERE id = ?',
      )
      .bind(reservationId)
      .first<{ id: string; sha256: string; blob_key: string; expires_at_ms: number }>()
    return row === null
      ? null
      : {
          id: row.id,
          hash: row.sha256,
          blobKey: row.blob_key,
          expiresAt: row.expires_at_ms as Millis,
        }
  }

  async releaseTileBlobReservation(reservationId: string): Promise<void> {
    await this.client
      .prepare('DELETE FROM tile_blob_reservations WHERE id = ?')
      .bind(reservationId)
      .run()
  }

  async noteTileBlobObject(
    hash: string,
    blobKey: string,
    now: Millis,
  ): Promise<TileBlobCandidateResult> {
    await this.client
      .prepare(
        `INSERT INTO tile_blob_objects (
           blob_key, sha256, state, discovered_at_ms, delete_attempts
         )
         SELECT ?, ?, CASE
           WHEN EXISTS (
             SELECT 1 FROM tile_blob_reservations
             WHERE sha256 = ? AND blob_key = ? AND expires_at_ms > ?
           ) OR (
             (
               EXISTS (SELECT 1 FROM tile_history WHERE sha256 = ?)
               OR EXISTS (SELECT 1 FROM canvas_tiles WHERE sha256 = ?)
             ) AND (
               EXISTS (
                 SELECT 1 FROM tile_blob_objects
                 WHERE blob_key = ? AND sha256 = ? AND state = 'active'
               ) OR NOT EXISTS (
                 SELECT 1 FROM tile_blob_objects
                 WHERE sha256 = ? AND blob_key <> ? AND state = 'active'
               )
             )
           ) THEN 'active' ELSE 'candidate' END, ?, 0
         ON CONFLICT(blob_key) DO UPDATE SET
           sha256 = excluded.sha256,
           state = CASE
             WHEN tile_blob_objects.state = 'deleting' THEN 'deleting'
             ELSE excluded.state
           END,
           reclaimed_at_ms = CASE
             WHEN tile_blob_objects.state = 'deleting' THEN tile_blob_objects.reclaimed_at_ms
             ELSE NULL
           END,
           delete_started_at_ms = CASE
             WHEN tile_blob_objects.state = 'deleting' THEN tile_blob_objects.delete_started_at_ms
             ELSE NULL
           END`,
      )
      .bind(blobKey, hash, hash, blobKey, now, hash, hash, blobKey, hash, hash, blobKey, now)
      .run()
    const row = await this.client
      .prepare('SELECT state FROM tile_blob_objects WHERE blob_key = ?')
      .bind(blobKey)
      .first<{ state: string }>()
    return row?.state === 'deleting'
      ? 'deleting'
      : row?.state === 'active'
        ? 'referenced'
        : 'candidate'
  }

  async listTileBlobDeletionWork(limit: number): Promise<readonly TileBlobObject[]> {
    const rows = await this.database
      .select()
      .from(tileBlobObjects)
      .where(inArray(tileBlobObjects.state, ['deleting', 'candidate']))
      .orderBy(
        sql`CASE ${tileBlobObjects.state} WHEN 'deleting' THEN 0 ELSE 1 END`,
        asc(tileBlobObjects.discoveredAtMs),
        asc(tileBlobObjects.blobKey),
      )
      .limit(limit)
    return rows.map(toTileBlobObject)
  }

  async claimTileBlobDeletion(blobKey: string, now: Millis): Promise<TileBlobClaimResult> {
    const results = await this.client.batch([
      this.client.prepare('DELETE FROM tile_blob_reservations WHERE expires_at_ms <= ?').bind(now),
      this.client
        .prepare(
          `UPDATE tile_blob_objects SET
             state = CASE WHEN ${CLAIMED_OBJECT_REFERENCED}
               THEN 'active' ELSE 'deleting' END,
             delete_started_at_ms = CASE WHEN ${CLAIMED_OBJECT_REFERENCED}
               THEN NULL ELSE coalesce(delete_started_at_ms, ?) END,
             delete_attempts = CASE WHEN ${CLAIMED_OBJECT_REFERENCED}
               THEN delete_attempts ELSE delete_attempts + 1 END
           WHERE blob_key = ? AND state IN ('candidate', 'deleting')`,
        )
        .bind(now, now, now, now, blobKey),
    ])
    if (Number(results[1]?.meta.changes) === 0) return 'missing'
    const row = await this.client
      .prepare('SELECT state FROM tile_blob_objects WHERE blob_key = ?')
      .bind(blobKey)
      .first<{ state: string }>()
    if (row?.state === 'deleting') return 'claimed'
    if (row?.state === 'active') return 'blocked'
    return 'missing'
  }

  async finishTileBlobDeletion(blobKey: string, reclaimedAt: Millis): Promise<void> {
    await this.client.batch([
      this.client
        .prepare(
          `UPDATE tile_blob_objects
         SET state = 'deleted', reclaimed_at_ms = ?
         WHERE blob_key = ? AND state = 'deleting'`,
        )
        .bind(reclaimedAt, blobKey),
      this.client
        .prepare(`DELETE FROM template_tile_measurements
        WHERE sha256 = (SELECT sha256 FROM tile_blob_objects WHERE blob_key = ? AND state = 'deleted')
          AND NOT EXISTS (SELECT 1 FROM tile_history WHERE tile_history.sha256 = template_tile_measurements.sha256)
          AND NOT EXISTS (SELECT 1 FROM canvas_tiles WHERE canvas_tiles.sha256 = template_tile_measurements.sha256)
      `)
        .bind(blobKey),
    ])
  }

  async readTileBlobScanState(): Promise<TileBlobScanState> {
    const rows = await this.database.select().from(tileBlobGcState).where(eq(tileBlobGcState.id, 1))
    const row = rows[0]
    return row === undefined
      ? { completedSweeps: 0 }
      : {
          ...(row.cursor === null ? {} : { cursor: row.cursor }),
          completedSweeps: row.completedSweeps,
        }
  }

  async writeTileBlobScanState(cursor: string | undefined): Promise<void> {
    await this.database
      .insert(tileBlobGcState)
      .values({ id: 1, cursor: cursor ?? null, completedSweeps: cursor === undefined ? 1 : 0 })
      .onConflictDoUpdate({
        target: [tileBlobGcState.id].map((column) => sql`${sql.identifier(column.name)}`),
        set: {
          cursor: cursor ?? null,
          completedSweeps: sql`${tileBlobGcState.completedSweeps} + ${cursor === undefined ? 1 : 0}`,
        },
      })
  }
}
