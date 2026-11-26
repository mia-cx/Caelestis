import {
  type Millis,
  type Seconds,
  seconds,
  type TemplateStatus,
  type TileCoord,
  type TileHistoryFrame,
  timelapseCaptureIncludesTile,
} from '@caelestis/shared'
import { and, asc, eq, gte, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { RelationalStore } from '../../adapters/relational-store.js'
import type { SqlStatement } from '../../adapters/sql-connection.js'
import {
  type ColourStatus,
  parseColourStatuses,
  parseColourTotals,
} from '../../db/colour-status.js'
import {
  chunkRows,
  TILE_HISTORY_KEYS_PER_DELETE,
  TILE_HISTORY_ROWS_PER_INSERT,
  TILE_MEASUREMENT_ROWS_PER_INSERT,
} from '../../db/d1-limits.js'
import {
  canvasTiles,
  templates,
  templateTileMeasurements,
  templateTileStatuses,
  templateVersions,
  tileHistory,
  versionTiles,
} from '../../db/schema.js'
import { DECAY_FOLD_GROUP_LIMIT, foldCutoff } from '../decay.js'
import { commitTileObservation } from './commit.js'
import {
  foldTileFrames,
  foldTileReporterRows,
  TILE_HISTORY_DECAY_EDGES,
  TILE_HISTORY_RESOLUTIONS,
  type TileHistoryReporterRow,
} from './ladder.js'
import {
  assertValidTileHistoryQuery,
  type LatestTileObservation,
  type MeasuredTileFrame,
  type TelemetryTarget,
  type TileHistoryQuery,
  type TileMeasurement,
  type TileObservationCommit,
  type TileObservationCommitRequest,
  type TileStore,
} from './store.js'

/** History rows on the tiles of the template version bound as `?1`, in its template's season. */
const VERSION_TILE_HISTORY = `
  FROM version_tiles AS chunk
  INNER JOIN template_versions AS version ON version.id = chunk.version_id
  INNER JOIN templates AS template ON template.id = version.template_id
  INNER JOIN tile_history AS history ON history.season = template.season
    AND history.tile_x = chunk.tile_x AND history.tile_y = chunk.tile_y
  WHERE chunk.version_id = ?1`

/**
 * The `winners` CTE: each history bucket's winning hash among the version's rows that also match
 * `filter`. The vote is `foldTileFrames`'s: most distinct reporters, then the smaller hash.
 */
const bucketWinners = (filter: string) => `
  votes AS (
    SELECT history.tile_x, history.tile_y, history.resolution_s, history.bucket_start_s,
      history.sha256, COUNT(DISTINCT history.reported_by_user_id) AS reporters
    ${VERSION_TILE_HISTORY} ${filter}
    GROUP BY history.tile_x, history.tile_y, history.resolution_s, history.bucket_start_s, history.sha256
  ), ranked AS (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY tile_x, tile_y, resolution_s, bucket_start_s
      ORDER BY reporters DESC, sha256 ASC
    ) AS vote_rank FROM votes
  ), winners AS (
    SELECT * FROM ranked WHERE vote_rank = 1
  )`

export class RelationalTileStore extends RelationalStore implements TileStore {
  commitTileObservation(
    commit: TileObservationCommitRequest,
  ): Promise<TileObservationCommit | null> {
    return commitTileObservation(this.client, this.syntax, commit)
  }

  async listTelemetryTargets(
    season: number,
    tile: { readonly x: number; readonly y: number },
    includeUnpublished: boolean,
  ): Promise<readonly TelemetryTarget[]> {
    return this.database
      .select({
        templateId: templates.id,
        versionId: templateVersions.id,
        tileX: versionTiles.tileX,
        tileY: versionTiles.tileY,
        hash: versionTiles.hash,
        minX: templateVersions.minX,
        minY: templateVersions.minY,
        maxX: templateVersions.maxX,
        maxY: templateVersions.maxY,
        totalPixels: templateVersions.totalPixels,
        colourTotalsJson: templateVersions.colourTotalsJson,
        finishedAt: templates.finishedAt,
        publishedAt: templates.publishedAt,
      })
      .from(versionTiles)
      .innerJoin(templateVersions, eq(templateVersions.id, versionTiles.versionId))
      .innerJoin(
        templates,
        and(
          eq(templates.id, templateVersions.templateId),
          eq(templates.currentVersionId, templateVersions.id),
        ),
      )
      .where(
        and(
          eq(templates.season, season),
          eq(templates.surfaceKind, 'world'),
          isNull(templates.allianceId),
          eq(versionTiles.tileX, tile.x),
          eq(versionTiles.tileY, tile.y),
          includeUnpublished ? undefined : isNotNull(templates.publishedAt),
        ),
      )
      .then((rows) =>
        rows.map((row) => {
          const colourTotals = parseColourTotals(row.colourTotalsJson)
          return {
            templateId: row.templateId,
            versionId: row.versionId,
            tileX: row.tileX,
            tileY: row.tileY,
            hash: row.hash,
            bbox: { minX: row.minX, minY: row.minY, maxX: row.maxX, maxY: row.maxY },
            finished: row.finishedAt !== null,
            published: row.publishedAt !== null,
            totalPixels: row.totalPixels,
            ...(colourTotals === undefined ? {} : { colourTotals }),
          }
        }),
      )
  }

  async readLatestTile(season: number, tile: { readonly x: number; readonly y: number }) {
    const rows = await this.database
      .select()
      .from(canvasTiles)
      .where(
        and(
          eq(canvasTiles.season, season),
          eq(canvasTiles.tileX, tile.x),
          eq(canvasTiles.tileY, tile.y),
        ),
      )
      .limit(1)
    const row = rows[0]
    return row === undefined
      ? null
      : {
          season: row.season,
          tile: { x: row.tileX, y: row.tileY },
          hash: row.sha256,
          observedAt: row.observedAtMs,
        }
  }

  async readFirstTemplateObservation(versionId: string): Promise<Seconds | null> {
    const row = await this.client
      .prepare(`
      SELECT MIN(history.bucket_start_s) AS at ${VERSION_TILE_HISTORY}
    `)
      .bind(versionId)
      .first<{ at: number | null }>()
    return row?.at == null ? null : seconds(row.at)
  }

  async readTemplateProgressFrames(
    versionId: string,
    from: Seconds,
    to: Seconds,
    resolution: number,
    lifetime?: { readonly fromSeconds: Seconds; readonly toSeconds: Seconds },
  ): Promise<readonly MeasuredTileFrame[]> {
    // Explicit resolution list lets SQLite/D1 seek `bucket_start_s` directly on the primary key
    // `(season, tile_x, tile_y, resolution_s, bucket_start_s)` instead of scanning every tier.
    const resolutions = TILE_HISTORY_RESOLUTIONS.filter((tier) => tier <= resolution)
    const lower = Math.max(from, lifetime?.fromSeconds ?? from)
    const lifetimeTo = lifetime?.toSeconds ?? Number.MAX_SAFE_INTEGER
    const upper = Math.min(to, lifetimeTo)
    if (resolutions.length === 0 || lower >= upper) return []
    const result = await this.client
      .prepare(`
      WITH ${bucketWinners(`AND history.resolution_s IN (${resolutions.join(', ')})
        AND history.bucket_start_s >= ?2 AND history.bucket_start_s < ?3
        AND history.bucket_start_s + history.resolution_s <= ?5`)}, frames AS (
        SELECT *, CASE WHEN ?4 = 0 THEN bucket_start_s
          ELSE CAST(bucket_start_s / ?4 AS BIGINT) * ?4 END AS target_start
        FROM winners
      ), selected AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY tile_x, tile_y, target_start
          ORDER BY bucket_start_s DESC, resolution_s ASC
        ) AS frame_rank FROM frames WHERE target_start >= ?6
      )
      SELECT frame.tile_x AS "tileX", frame.tile_y AS "tileY", frame.target_start AS "bucketStart",
        frame.sha256 AS hash, measurement.correct, measurement.wrong
      FROM selected AS frame LEFT JOIN template_tile_measurements AS measurement
        ON measurement.version_id = ?1 AND measurement.tile_x = frame.tile_x
        AND measurement.tile_y = frame.tile_y AND measurement.sha256 = frame.sha256
      WHERE frame.frame_rank = 1 ORDER BY frame.target_start, frame.tile_x, frame.tile_y
    `)
      .bind(versionId, lower, upper, resolution, lifetimeTo, from)
      .all<MeasuredTileFrame>()
    return result.results
  }

  async readTemplateProgressAt(
    versionId: string,
    at: Seconds,
  ): Promise<readonly MeasuredTileFrame[]> {
    // Seek the single latest bucket per (tile, resolution) via the primary key instead of grouping
    // every historical observation before `at`.
    const resolutionRows = TILE_HISTORY_RESOLUTIONS.map(
      (tier) => `SELECT ${tier} AS resolution_s`,
    ).join(' UNION ALL ')
    const result = await this.client
      .prepare(`
      WITH latest_buckets AS (
        SELECT chunk.tile_x, chunk.tile_y, template.season, r.resolution_s,
          (SELECT MAX(h.bucket_start_s)
           FROM tile_history AS h
           WHERE h.season = template.season
             AND h.tile_x = chunk.tile_x
             AND h.tile_y = chunk.tile_y
             AND h.resolution_s = r.resolution_s
             AND h.bucket_start_s < ?2
             AND h.bucket_start_s <= ?2 - r.resolution_s) AS bucket_start_s
        FROM version_tiles AS chunk
        INNER JOIN template_versions AS version ON version.id = chunk.version_id
        INNER JOIN templates AS template ON template.id = version.template_id
        CROSS JOIN (${resolutionRows}) AS r
        WHERE chunk.version_id = ?1
      ), votes AS (
        SELECT lb.tile_x, lb.tile_y, lb.resolution_s, lb.bucket_start_s,
          history.sha256, COUNT(DISTINCT history.reported_by_user_id) AS reporters
        FROM latest_buckets AS lb
        INNER JOIN tile_history AS history
          ON history.season = lb.season
          AND history.tile_x = lb.tile_x
          AND history.tile_y = lb.tile_y
          AND history.resolution_s = lb.resolution_s
          AND history.bucket_start_s = lb.bucket_start_s
        WHERE lb.bucket_start_s IS NOT NULL
        GROUP BY lb.tile_x, lb.tile_y, lb.resolution_s, lb.bucket_start_s, history.sha256
      ), ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY tile_x, tile_y, resolution_s, bucket_start_s
          ORDER BY reporters DESC, sha256 ASC
        ) AS vote_rank FROM votes
      ), winners AS (
        SELECT * FROM ranked WHERE vote_rank = 1
      ), latest AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY tile_x, tile_y ORDER BY bucket_start_s DESC, resolution_s ASC
        ) AS frame_rank FROM winners
      )
      SELECT frame.tile_x AS "tileX", frame.tile_y AS "tileY", frame.bucket_start_s AS "bucketStart",
        frame.sha256 AS hash, measurement.correct, measurement.wrong
      FROM latest AS frame LEFT JOIN template_tile_measurements AS measurement
        ON measurement.version_id = ?1 AND measurement.tile_x = frame.tile_x
        AND measurement.tile_y = frame.tile_y AND measurement.sha256 = frame.sha256
      WHERE frame.frame_rank = 1 ORDER BY frame.tile_x, frame.tile_y
    `)
      .bind(versionId, at)
      .all<MeasuredTileFrame>()
    return result.results
  }

  async writeTileMeasurements(
    versionId: string,
    tile: TileCoord,
    measurements: readonly TileMeasurement[],
  ): Promise<void> {
    for (const group of chunkRows(measurements, TILE_MEASUREMENT_ROWS_PER_INSERT)) {
      await this.database
        .insert(templateTileMeasurements)
        .values(
          group.map((measurement) => ({ versionId, tileX: tile.x, tileY: tile.y, ...measurement })),
        )
        .onConflictDoNothing()
    }
  }

  async foldTileHistory(
    season: number,
    tile: { readonly x: number; readonly y: number },
    now: Seconds,
  ): Promise<void> {
    const frozenTemplates = await this.database
      .select({
        frozenAt: templates.timelapseFrozenAt,
        minX: templateVersions.minX,
        minY: templateVersions.minY,
        maxX: templateVersions.maxX,
        maxY: templateVersions.maxY,
      })
      .from(templates)
      .innerJoin(templateVersions, eq(templateVersions.id, templates.currentVersionId))
      .where(
        and(
          eq(templates.season, season),
          eq(templates.surfaceKind, 'world'),
          isNotNull(templates.timelapseFrozenAt),
        ),
      )
    const frozenThrough = Math.max(
      -1,
      ...frozenTemplates
        .filter((template) =>
          timelapseCaptureIncludesTile(
            {
              minX: template.minX,
              minY: template.minY,
              maxX: template.maxX,
              maxY: template.maxY,
            },
            tile,
          ),
        )
        .map((template) => template.frozenAt ?? -1),
    )

    for (const edge of TILE_HISTORY_DECAY_EDGES) {
      // Keep detail around artwork changes, including tiles removed by the replacement.
      // Otherwise folding erases which side of the change supplied an observation.
      const targetStart = `CAST(history.bucket_start_s / ${edge.target} AS BIGINT) * ${edge.target}`
      const chosen = `
        SELECT ${targetStart} AS target_start
        FROM tile_history AS history
        WHERE history.season = ? AND history.tile_x = ? AND history.tile_y = ?
          AND history.resolution_s = ${edge.source}
          AND ${targetStart} + ${edge.target} <= ?
          AND NOT EXISTS (
            SELECT 1 FROM version_tiles AS chunk
            INNER JOIN template_versions AS covered ON covered.id = chunk.version_id
            INNER JOIN template_versions AS version ON version.template_id = covered.template_id
            INNER JOIN templates AS template ON template.id = version.template_id
            WHERE template.season = history.season
              AND chunk.tile_x = history.tile_x AND chunk.tile_y = history.tile_y
              AND version.created_at_ms >= (${targetStart} + 1) * 1000
              AND version.created_at_ms < (${targetStart} + ${edge.target}) * 1000
          )
          AND NOT EXISTS (
            SELECT 1 FROM tile_history AS finer
            WHERE finer.season = history.season
              AND finer.tile_x = history.tile_x
              AND finer.tile_y = history.tile_y
              AND finer.resolution_s < ${edge.source}
              AND finer.bucket_start_s >= ${targetStart}
              AND finer.bucket_start_s < ${targetStart} + ${edge.target}
          )
          AND ${targetStart} * 1000 > ?
        GROUP BY target_start
        ORDER BY target_start
        LIMIT ?`
      const query = `
        WITH chosen AS (${chosen})
        SELECT history.season, history.tile_x, history.tile_y,
          history.resolution_s, history.bucket_start_s, history.sha256,
          history.reported_with_token, history.reported_by_user_id
        FROM tile_history AS history
        INNER JOIN chosen
          ON chosen.target_start = CAST(history.bucket_start_s / ${edge.target} AS BIGINT) * ${edge.target}
        WHERE history.season = ? AND history.tile_x = ? AND history.tile_y = ?
          AND history.resolution_s = ${edge.source}
        ORDER BY history.bucket_start_s, history.sha256, history.reported_by_user_id`
      const cutoff = foldCutoff(edge, now)
      const selected = await this.client
        .prepare(query)
        .bind(
          season,
          tile.x,
          tile.y,
          cutoff,
          frozenThrough,
          DECAY_FOLD_GROUP_LIMIT,
          season,
          tile.x,
          tile.y,
        )
        .all<{
          season: number
          tile_x: number
          tile_y: number
          resolution_s: number
          bucket_start_s: number
          sha256: string
          reported_with_token: string
          reported_by_user_id: number
        }>()
      const rows: TileHistoryReporterRow[] = selected.results.map((row) => ({
        season: row.season,
        tile: { x: row.tile_x, y: row.tile_y },
        resolution: row.resolution_s,
        bucketStart: seconds(row.bucket_start_s),
        hash: row.sha256,
        reportedWithToken: row.reported_with_token,
        reportedByUserId: row.reported_by_user_id,
      }))
      if (rows.length === 0) continue
      const folded = foldTileReporterRows(rows, edge.target)
      const statements: SqlStatement[] = []
      for (const group of chunkRows(folded, TILE_HISTORY_ROWS_PER_INSERT)) {
        const values = group.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
        statements.push(
          this.client
            .prepare(
              `INSERT INTO tile_history (
                season, tile_x, tile_y, resolution_s, bucket_start_s, sha256,
                reported_with_token, reported_by_user_id
              ) VALUES ${values}
              ON CONFLICT(
                season, tile_x, tile_y, resolution_s, bucket_start_s, sha256,
                reported_by_user_id
              ) DO UPDATE SET reported_with_token = excluded.reported_with_token`,
            )
            .bind(
              ...group.flatMap((row) => [
                row.season,
                row.tile.x,
                row.tile.y,
                row.resolution,
                row.bucketStart,
                row.hash,
                row.reportedWithToken,
                row.reportedByUserId,
              ]),
            ),
        )
      }
      // Delete only the reporter rows that participated in this fold. A new observation can land
      // after the SELECT above; deleting by the whole target window would erase that unrepresented
      // row. Exact primary keys leave it for the next touch instead.
      for (const group of chunkRows(rows, TILE_HISTORY_KEYS_PER_DELETE)) {
        const keys = group.map(() => '(?, ?, ?)').join(', ')
        statements.push(
          this.client
            .prepare(
              `DELETE FROM tile_history
               WHERE season = ? AND tile_x = ? AND tile_y = ? AND resolution_s = ${edge.source}
                 AND (bucket_start_s, sha256, reported_by_user_id) IN (${keys})`,
            )
            .bind(
              season,
              tile.x,
              tile.y,
              ...group.flatMap((row) => [row.bucketStart, row.hash, row.reportedByUserId]),
            ),
        )
      }
      await this.client.batch(statements)
    }
  }

  async readTemplateStatuses(
    season: number,
    includeUnpublished: boolean,
  ): Promise<readonly TemplateStatus[]> {
    const rows = await this.database
      .select({
        templateId: templates.id,
        correct: sql<number>`sum(${templateTileStatuses.correct})`,
        wrong: sql<number>`sum(${templateTileStatuses.wrong})`,
        blank: sql<number>`sum(${templateTileStatuses.blank})`,
        total: templateVersions.totalPixels,
        colourTotalsJson: templateVersions.colourTotalsJson,
        colourRowsJson: this.syntax.jsonAggregate(templateTileStatuses.coloursJson),
        observedAt: sql<number>`max(${templateTileStatuses.observedAtMs})`,
      })
      .from(templates)
      .innerJoin(templateVersions, eq(templateVersions.id, templates.currentVersionId))
      .innerJoin(
        templateTileStatuses,
        and(
          eq(templateTileStatuses.templateId, templates.id),
          eq(templateTileStatuses.versionId, templateVersions.id),
        ),
      )
      .where(
        and(
          eq(templates.season, season),
          includeUnpublished ? undefined : isNotNull(templates.publishedAt),
        ),
      )
      .groupBy(templates.id, templateVersions.totalPixels, templateVersions.colourTotalsJson)
      .orderBy(asc(templates.id))
    return rows.map((row) => {
      const storedTotals = parseColourTotals(row.colourTotalsJson)
      const classified = new Map<number, Omit<ColourStatus, 'index'>>()
      const colourRows: unknown = JSON.parse(row.colourRowsJson)
      if (Array.isArray(colourRows)) {
        for (const encoded of colourRows) {
          if (typeof encoded !== 'string') continue
          for (const colour of parseColourStatuses(encoded)) {
            const held = classified.get(colour.index)
            classified.set(colour.index, {
              correct: (held?.correct ?? 0) + colour.correct,
              wrong: (held?.wrong ?? 0) + colour.wrong,
              blank: (held?.blank ?? 0) + colour.blank,
              total: (held?.total ?? 0) + colour.total,
            })
          }
        }
      }
      // Versions created before colour histograms were stored still have exact per-colour totals in
      // every classified tile row. Once those rows cover the whole template, their totals are the
      // missing histogram. Do not expose a partial partition: the wire schema deliberately requires
      // colour rows to add up to the template total.
      const classifiedTotals = [...classified].map(([index, colour]) => ({
        index,
        total: colour.total,
      }))
      const totals =
        storedTotals ??
        (classifiedTotals.reduce((sum, colour) => sum + colour.total, 0) === row.total
          ? classifiedTotals.sort((left, right) => left.index - right.index)
          : undefined)
      return {
        templateId: row.templateId,
        correct: Number(row.correct),
        wrong: Number(row.wrong),
        blank: Number(row.blank),
        total: row.total,
        ...(totals === undefined
          ? {}
          : {
              colours: totals.map(({ index, total }) => ({
                index,
                total,
                correct: classified.get(index)?.correct ?? 0,
                wrong: classified.get(index)?.wrong ?? 0,
                blank: classified.get(index)?.blank ?? 0,
              })),
            }),
        observedAt: Number(row.observedAt) as Millis,
      }
    })
  }

  async readStatusProjectionRevision(season: number): Promise<number> {
    if (!Number.isSafeInteger(season) || season < 0) throw new RangeError('invalid season')
    const row = await this.client
      .prepare('SELECT revision FROM status_read_model_revisions WHERE season = ?')
      .bind(season)
      .first<{ revision: number }>()
    return row?.revision ?? 0
  }

  async commitStatusProjectionRevision(
    season: number,
    expectedRevision: number,
    retainRevision: boolean,
    publicFingerprint: string,
    adminFingerprint: string,
  ): Promise<number | null> {
    if (
      !Number.isSafeInteger(season) ||
      season < 0 ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      !/^[0-9a-f]{64}$/.test(publicFingerprint) ||
      !/^[0-9a-f]{64}$/.test(adminFingerprint)
    ) {
      throw new RangeError('invalid status projection revision metadata')
    }
    const row = await this.client
      .prepare(
        `INSERT INTO status_read_model_revisions (
           season, revision, public_fingerprint, admin_fingerprint, fingerprints_dirty
         ) SELECT ?1, 1, ?4, ?5, 0
           WHERE ?2 = 0 OR EXISTS (
             SELECT 1 FROM status_read_model_revisions
             WHERE season = ?1 AND revision = ?2
           )
         ON CONFLICT (season) DO UPDATE SET
           revision = status_read_model_revisions.revision + CASE
             WHEN status_read_model_revisions.fingerprints_dirty = 1 AND ?3 = 1 THEN 0
             WHEN status_read_model_revisions.fingerprints_dirty = 1
               OR status_read_model_revisions.public_fingerprint <> excluded.public_fingerprint
               OR status_read_model_revisions.admin_fingerprint <> excluded.admin_fingerprint
             THEN 1 ELSE 0 END,
           public_fingerprint = excluded.public_fingerprint,
           admin_fingerprint = excluded.admin_fingerprint,
           fingerprints_dirty = 0
         WHERE status_read_model_revisions.revision = ?2
         RETURNING revision`,
      )
      .bind(season, expectedRevision, retainRevision ? 1 : 0, publicFingerprint, adminFingerprint)
      .first<{ revision: number }>()
    if (row === null) return null
    if (!Number.isSafeInteger(row.revision) || row.revision < 1)
      throw new Error('status projection revision commit returned an invalid revision')
    return row.revision
  }

  async listLatestTiles(season: number): Promise<readonly LatestTileObservation[]> {
    const rows = await this.database
      .select()
      .from(canvasTiles)
      .where(eq(canvasTiles.season, season))
      .orderBy(asc(canvasTiles.tileX), asc(canvasTiles.tileY))
    return rows.map((row) => ({
      season: row.season,
      tile: { x: row.tileX, y: row.tileY },
      hash: row.sha256,
      observedAt: row.observedAtMs,
    }))
  }

  async readTileHistory(query: TileHistoryQuery): Promise<readonly TileHistoryFrame[]> {
    assertValidTileHistoryQuery(query)
    const rows = await this.database
      .select({
        bucketStart: tileHistory.bucketStartS,
        hash: tileHistory.sha256,
        // Distinct accounts, not rows, so quorum stays honest whatever else the key separates.
        reporters: sql<number>`count(distinct ${tileHistory.reportedByUserId})`,
      })
      .from(tileHistory)
      .where(
        and(
          eq(tileHistory.season, query.season),
          eq(tileHistory.tileX, query.tile.x),
          eq(tileHistory.tileY, query.tile.y),
          eq(tileHistory.resolutionS, seconds(query.resolution)),
          gte(tileHistory.bucketStartS, query.fromSeconds),
          lt(tileHistory.bucketStartS, query.toSeconds),
        ),
      )
      .groupBy(tileHistory.bucketStartS, tileHistory.sha256)
    return foldTileFrames(rows)
  }
}
