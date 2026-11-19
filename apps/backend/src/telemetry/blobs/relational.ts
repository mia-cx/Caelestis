import { type Millis, millis } from '@caelestis/shared'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import {
  parseColourStatuses,
  parseColourTotals,
  RelationalStore,
} from '../../adapters/relational-store.js'
import type { SqlStatement } from '../../adapters/sql-connection.js'
import { tileBlobGcState, tileBlobObjects } from '../../db/schema.js'
import type {
  TemplateTileStatusRecord,
  TileObservation,
  TileObservationCommit,
} from '../tiles/store.js'
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

  async commitTileBlobReservation(
    reservationId: string,
    now: Millis,
    observation: TileObservation,
    statuses: readonly TemplateTileStatusRecord[],
    recordHistory = true,
    forceCurrent = false,
    includeUnpublished = false,
  ): Promise<TileObservationCommit | null> {
    const statements: SqlStatement[] = [
      this.client.prepare('DELETE FROM tile_blob_reservations WHERE expires_at_ms <= ?').bind(now),
      this.client
        .prepare(
          `UPDATE tile_blob_objects SET state = 'active', reclaimed_at_ms = NULL
           WHERE blob_key = (
             SELECT blob_key FROM tile_blob_reservations
             WHERE id = ? AND sha256 = ?
           ) AND NOT EXISTS (
             SELECT 1 FROM tile_blob_objects AS deleting
             WHERE deleting.sha256 = ? AND deleting.state = 'deleting'
           )`,
        )
        .bind(reservationId, observation.hash, observation.hash),
    ]
    if (recordHistory) {
      statements.push(
        this.client
          .prepare(
            `INSERT INTO tile_history (
               season, tile_x, tile_y, resolution_s, bucket_start_s, sha256,
               reported_with_token, reported_by_user_id
             )
             SELECT ?, ?, ?, 0, ?, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM tile_blob_reservations AS reservation
               INNER JOIN tile_blob_objects AS object ON object.blob_key = reservation.blob_key
               WHERE reservation.id = ? AND reservation.sha256 = ? AND object.state = 'active'
             )
             ON CONFLICT DO NOTHING`,
          )
          .bind(
            observation.season,
            observation.tile.x,
            observation.tile.y,
            observation.reportedAt,
            observation.hash,
            observation.reportedWithToken,
            observation.reportedByUserId,
            reservationId,
            observation.hash,
          ),
      )
    }
    const currentResult = statements.length
    statements.push(
      this.client
        .prepare(
          `INSERT INTO canvas_tiles (
             season, tile_x, tile_y, sha256, observed_at_ms, server_owned, commit_order
           )
           SELECT ?, ?, ?, ?, ?, ?, 1
           WHERE EXISTS (
             SELECT 1 FROM tile_blob_reservations AS reservation
             INNER JOIN tile_blob_objects AS object ON object.blob_key = reservation.blob_key
             WHERE reservation.id = ? AND reservation.sha256 = ? AND object.state = 'active'
           )
           ON CONFLICT(season, tile_x, tile_y) DO UPDATE SET
             sha256 = excluded.sha256,
             observed_at_ms = excluded.observed_at_ms,
             server_owned = excluded.server_owned,
             commit_order = canvas_tiles.commit_order + 1
           WHERE canvas_tiles.observed_at_ms <= excluded.observed_at_ms
             OR (excluded.server_owned = 1 AND canvas_tiles.server_owned = 0)
           RETURNING sha256, observed_at_ms, commit_order`,
        )
        .bind(
          observation.season,
          observation.tile.x,
          observation.tile.y,
          observation.hash,
          observation.observedAt,
          forceCurrent ? 1 : 0,
          reservationId,
          observation.hash,
        ),
    )
    const statusesJson = JSON.stringify(
      statuses.map((status) => ({
        templateId: status.templateId,
        versionId: status.versionId,
        tileX: status.tile.x,
        tileY: status.tile.y,
        correct: status.correct,
        wrong: status.wrong,
        blank: status.blank,
        colours: status.colours ?? [],
        observedAt: status.observedAt,
      })),
    )
    const incomingStatuses = `SELECT
      ${this.syntax.jsonField('templateId', 'text')} AS template_id,
      ${this.syntax.jsonField('versionId', 'text')} AS version_id,
      ${this.syntax.jsonField('tileX')} AS tile_x,
      ${this.syntax.jsonField('tileY')} AS tile_y,
      ${this.syntax.jsonField('correct')} AS correct,
      ${this.syntax.jsonField('wrong')} AS wrong,
      ${this.syntax.jsonField('blank')} AS blank,
      ${this.syntax.jsonField('colours', 'json')} AS colours_json,
      ${this.syntax.jsonField('observedAt')} AS observed_at_ms
      FROM ${this.syntax.jsonEach}`
    const statusReadResult =
      statuses.length === 0
        ? null
        : (() => {
            const index = statements.length
            statements.push(
              this.client
                .prepare(
                  `WITH incoming AS (${incomingStatuses})
                   SELECT incoming.*,
                     status.correct AS previous_correct,
                     status.wrong AS previous_wrong,
                     status.blank AS previous_blank,
                     status.colours_json AS previous_colours_json,
                     status.observed_at_ms AS previous_observed_at_ms,
                     status.server_owned AS previous_server_owned,
                     (SELECT coalesce(sum(held.correct), 0) FROM template_tile_statuses AS held
                       WHERE held.template_id = incoming.template_id
                         AND held.version_id = incoming.version_id) AS previous_template_correct,
                     (SELECT coalesce(max(held.observed_at_ms), 0) FROM template_tile_statuses AS held
                       WHERE held.template_id = incoming.template_id
                         AND held.version_id = incoming.version_id) AS previous_template_observed_at_ms,
                     CASE WHEN template.published_at IS NOT NULL THEN 1 ELSE 0 END AS published,
                     version.total_pixels,
                     version.colour_totals_json
                   FROM incoming
                   INNER JOIN templates AS template
                     ON template.id = incoming.template_id
                    AND template.current_version_id = incoming.version_id
                   INNER JOIN template_versions AS version ON version.id = incoming.version_id
                   LEFT JOIN template_tile_statuses AS status
                     ON status.template_id = incoming.template_id
                    AND status.version_id = incoming.version_id
                    AND status.tile_x = incoming.tile_x
                    AND status.tile_y = incoming.tile_y
                   WHERE ? = 1 OR template.published_at IS NOT NULL`,
                )
                .bind(statusesJson, includeUnpublished ? 1 : 0),
            )
            return index
          })()
    const revisionResult =
      statuses.length === 0
        ? null
        : (() => {
            const index = statements.length
            statements.push(
              this.client
                .prepare(
                  `INSERT INTO status_read_model_revisions (
                     season, revision, public_fingerprint, admin_fingerprint, fingerprints_dirty
                   )
                   SELECT ?, 1, ?, ?, 1
                   WHERE EXISTS (
                     SELECT 1 FROM tile_blob_reservations AS reservation
                     INNER JOIN tile_blob_objects AS object
                       ON object.blob_key = reservation.blob_key
                     WHERE reservation.id = ? AND reservation.sha256 = ?
                       AND object.state = 'active'
                   ) AND EXISTS (
                     WITH incoming AS (${incomingStatuses})
                     SELECT 1 FROM incoming
                     INNER JOIN templates AS template
                       ON template.id = incoming.template_id
                      AND template.current_version_id = incoming.version_id
                     LEFT JOIN template_tile_statuses AS status
                       ON status.template_id = incoming.template_id
                      AND status.version_id = incoming.version_id
                      AND status.tile_x = incoming.tile_x
                      AND status.tile_y = incoming.tile_y
                     WHERE (? = 1 OR template.published_at IS NOT NULL)
                       AND (
                         status.template_id IS NULL OR (
                           ((? = 1 AND status.server_owned = 0)
                             OR status.observed_at_ms <= incoming.observed_at_ms)
                           AND (
                             status.correct <> incoming.correct
                             OR status.wrong <> incoming.wrong
                             OR status.blank <> incoming.blank
                             OR status.colours_json <> incoming.colours_json
                             OR status.observed_at_ms <> incoming.observed_at_ms
                           )
                         )
                       )
                   )
                   ON CONFLICT(season) DO UPDATE SET
                     revision = status_read_model_revisions.revision + 1,
                     fingerprints_dirty = 1
                   RETURNING revision`,
                )
                .bind(
                  observation.season,
                  '0'.repeat(64),
                  '0'.repeat(64),
                  reservationId,
                  observation.hash,
                  statusesJson,
                  includeUnpublished ? 1 : 0,
                  forceCurrent ? 1 : 0,
                ),
            )
            return index
          })()
    if (statuses.length > 0) {
      statements.push(
        this.client
          .prepare(`WITH incoming AS (${incomingStatuses})
          INSERT INTO template_tile_measurements (version_id, tile_x, tile_y, sha256, correct, wrong, blank)
          SELECT incoming.version_id, incoming.tile_x, incoming.tile_y, ?, incoming.correct, incoming.wrong, incoming.blank
          FROM incoming INNER JOIN templates AS template ON template.id = incoming.template_id AND template.current_version_id = incoming.version_id
          WHERE (? = 1 OR template.published_at IS NOT NULL) AND EXISTS (
            SELECT 1 FROM tile_blob_reservations AS reservation INNER JOIN tile_blob_objects AS object ON object.blob_key = reservation.blob_key
            WHERE reservation.id = ? AND reservation.sha256 = ? AND object.state = 'active'
          ) ON CONFLICT DO NOTHING`)
          .bind(
            statusesJson,
            observation.hash,
            includeUnpublished ? 1 : 0,
            reservationId,
            observation.hash,
          ),
        this.client
          .prepare(
            `WITH incoming AS (${incomingStatuses})
             INSERT INTO template_tile_statuses (
               template_id, version_id, tile_x, tile_y, correct, wrong, blank,
               colours_json, observed_at_ms, server_owned
             )
             SELECT incoming.template_id, incoming.version_id, incoming.tile_x, incoming.tile_y,
               incoming.correct, incoming.wrong, incoming.blank, incoming.colours_json,
               incoming.observed_at_ms, ?
             FROM incoming
             INNER JOIN templates AS template
               ON template.id = incoming.template_id
              AND template.current_version_id = incoming.version_id
             WHERE (? = 1 OR template.published_at IS NOT NULL)
               AND EXISTS (
                 SELECT 1 FROM tile_blob_reservations AS reservation
                 INNER JOIN tile_blob_objects AS object ON object.blob_key = reservation.blob_key
                 WHERE reservation.id = ? AND reservation.sha256 = ? AND object.state = 'active'
               )
             ON CONFLICT(template_id, version_id, tile_x, tile_y) DO UPDATE SET
               correct = excluded.correct,
               wrong = excluded.wrong,
               blank = excluded.blank,
               colours_json = excluded.colours_json,
               observed_at_ms = excluded.observed_at_ms,
               server_owned = excluded.server_owned
             WHERE (${forceCurrent ? 'template_tile_statuses.server_owned = 0 OR ' : ''}
               template_tile_statuses.observed_at_ms <= excluded.observed_at_ms)
             AND (
               template_tile_statuses.correct <> excluded.correct
               OR template_tile_statuses.wrong <> excluded.wrong
               OR template_tile_statuses.blank <> excluded.blank
               OR template_tile_statuses.colours_json <> excluded.colours_json
               OR template_tile_statuses.observed_at_ms <> excluded.observed_at_ms
               OR template_tile_statuses.server_owned <> excluded.server_owned
             )`,
          )
          .bind(
            statusesJson,
            forceCurrent ? 1 : 0,
            includeUnpublished ? 1 : 0,
            reservationId,
            observation.hash,
          ),
      )
      if (forceCurrent) {
        statements.push(
          this.client
            .prepare(
              `WITH incoming AS (${incomingStatuses})
               INSERT INTO template_alarm_tile_statuses (
                 template_id, version_id, tile_x, tile_y, correct, wrong, blank,
                 colours_json, observed_at_ms
               )
               SELECT incoming.template_id, incoming.version_id, incoming.tile_x, incoming.tile_y,
                 incoming.correct, incoming.wrong, incoming.blank, incoming.colours_json,
                 incoming.observed_at_ms
               FROM incoming
               INNER JOIN templates AS template
                 ON template.id = incoming.template_id
                AND template.current_version_id = incoming.version_id
               WHERE (? = 1 OR template.published_at IS NOT NULL)
                 AND EXISTS (
                   SELECT 1 FROM tile_blob_reservations AS reservation
                   INNER JOIN tile_blob_objects AS object ON object.blob_key = reservation.blob_key
                   WHERE reservation.id = ? AND reservation.sha256 = ? AND object.state = 'active'
                 )
               ON CONFLICT(template_id, version_id, tile_x, tile_y) DO UPDATE SET
                 correct = excluded.correct,
                 wrong = excluded.wrong,
                 blank = excluded.blank,
                 colours_json = excluded.colours_json,
                 observed_at_ms = excluded.observed_at_ms
               WHERE template_alarm_tile_statuses.observed_at_ms <= excluded.observed_at_ms`,
            )
            .bind(statusesJson, includeUnpublished ? 1 : 0, reservationId, observation.hash),
        )
      }
    }
    statements.push(
      this.client.prepare('DELETE FROM tile_blob_reservations WHERE id = ?').bind(reservationId),
    )
    const results = await this.client.batch(statements)
    if (Number(results[1]?.meta.changes) === 0) return null
    type AcceptedStatusRow = {
      template_id: string
      version_id: string
      tile_x: number
      tile_y: number
      previous_correct: number | null
      previous_wrong: number | null
      previous_blank: number | null
      previous_colours_json: string | null
      previous_observed_at_ms: number | null
      previous_server_owned: number | null
      previous_template_correct: number
      previous_template_observed_at_ms: number
      published: number
      total_pixels: number
      colour_totals_json: string | null
    }
    const acceptedRows =
      statusReadResult === null
        ? []
        : ((results[statusReadResult]?.results as AcceptedStatusRow[] | undefined) ?? [])
    const incomingByKey = new Map(
      statuses.map((status) => [
        `${status.templateId}\u0000${status.versionId}\u0000${status.tile.x}/${status.tile.y}`,
        status,
      ]),
    )
    const statusChanges = acceptedRows.flatMap((row) => {
      const current = incomingByKey.get(
        `${row.template_id}\u0000${row.version_id}\u0000${row.tile_x}/${row.tile_y}`,
      )
      if (current === undefined) return []
      if (
        row.previous_observed_at_ms !== null &&
        !(forceCurrent && row.previous_server_owned === 0) &&
        row.previous_observed_at_ms > current.observedAt
      ) {
        return []
      }
      const previousColours = parseColourStatuses(row.previous_colours_json ?? '[]')
      if (
        row.previous_observed_at_ms !== null &&
        Number(row.previous_correct) === current.correct &&
        Number(row.previous_wrong) === current.wrong &&
        Number(row.previous_blank) === current.blank &&
        row.previous_observed_at_ms === current.observedAt &&
        JSON.stringify(previousColours) === JSON.stringify(current.colours ?? [])
      ) {
        return []
      }
      const colourTotals = parseColourTotals(row.colour_totals_json)
      return [
        {
          published: row.published === 1,
          totalPixels: Number(row.total_pixels),
          previousTemplateCorrect: Number(row.previous_template_correct),
          previousTemplateObservedAt: millis(row.previous_template_observed_at_ms),
          ...(colourTotals === undefined ? {} : { colourTotals }),
          previous:
            row.previous_observed_at_ms === null
              ? null
              : {
                  ...current,
                  correct: Number(row.previous_correct),
                  wrong: Number(row.previous_wrong),
                  blank: Number(row.previous_blank),
                  colours: previousColours,
                  observedAt: Number(row.previous_observed_at_ms) as Millis,
                },
          current,
        },
      ]
    })
    const revisionRow =
      revisionResult === null
        ? undefined
        : (results[revisionResult]?.results[0] as { revision?: unknown } | undefined)
    const revision = revisionRow === undefined ? null : Number(revisionRow.revision)
    if (revision !== null && (!Number.isSafeInteger(revision) || revision < 1)) {
      throw new Error('tile status commit returned an invalid projection revision')
    }
    const currentRow = results[currentResult]?.results[0] as
      | { sha256?: unknown; observed_at_ms?: unknown; commit_order?: unknown }
      | undefined
    const current =
      currentRow === undefined ||
      typeof currentRow.sha256 !== 'string' ||
      typeof currentRow.observed_at_ms !== 'number' ||
      typeof currentRow.commit_order !== 'number' ||
      !Number.isSafeInteger(currentRow.commit_order) ||
      currentRow.commit_order < 0
        ? null
        : {
            season: observation.season,
            tile: observation.tile,
            hash: currentRow.sha256,
            observedAt: currentRow.observed_at_ms as Millis,
            commitOrder: currentRow.commit_order,
          }
    return { revision, statusChanges, current }
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
             state = CASE
               WHEN EXISTS (
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
                )
               THEN 'active' ELSE 'deleting' END,
             delete_started_at_ms = CASE
               WHEN EXISTS (
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
                )
               THEN NULL ELSE coalesce(delete_started_at_ms, ?) END,
             delete_attempts = CASE
               WHEN EXISTS (
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
                )
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
