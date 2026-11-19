import { type Millis, millis } from '@caelestis/shared'
import type { SqlConnection, SqlStatement } from '../../adapters/sql-connection.js'
import type { sqlDialect } from '../../adapters/sql-dialect.js'
import { parseColourStatuses, parseColourTotals } from '../../db/colour-status.js'
import type { TileObservationCommit, TileObservationCommitRequest } from './store.js'

/**
 * Stands in until a projection rebuild publishes real fingerprints. `fingerprints_dirty = 1` on the
 * same row is what marks it; this value is never compared.
 */
export const UNPUBLISHED_FINGERPRINT = '0'.repeat(64)

/** Binds the reservation id, then the hash. Every write past the activation gates on it. */
const RESERVATION_ACTIVE = `EXISTS (
  SELECT 1 FROM tile_blob_reservations AS reservation
  INNER JOIN tile_blob_objects AS object ON object.blob_key = reservation.blob_key
  WHERE reservation.id = ? AND reservation.sha256 = ? AND object.state = 'active'
)`

/** Incoming statuses apply only to a template's current version. */
const CURRENT_TEMPLATE = `INNER JOIN templates AS template
  ON template.id = incoming.template_id
 AND template.current_version_id = incoming.version_id`

/** Binds whether the reporter may target an unpublished template. */
const VISIBLE_TEMPLATE = '(? = 1 OR template.published_at IS NOT NULL)'

/** A newer observation replaces a stored status; an authoritative one also replaces a reporter's. */
const mayReplace = (stored: string, incoming: string, authoritative: boolean): string =>
  `(${authoritative ? `${stored}.server_owned = 0 OR ` : ''}${stored}.observed_at_ms <= ${incoming}.observed_at_ms)`

const countsDiffer = (stored: string, incoming: string): string =>
  `(${['correct', 'wrong', 'blank', 'colours_json', 'observed_at_ms']
    .map((column) => `${stored}.${column} <> ${incoming}.${column}`)
    .join(' OR ')})`

/** Whether an incoming status (`incoming`, left-joined `status`) would change what is stored. */
const statusChanges = (authoritative: boolean): string =>
  `(status.template_id IS NULL OR (${mayReplace('status', 'incoming', authoritative)} AND ${countsDiffer('status', 'incoming')}))`

type AcceptedStatusRow = {
  template_id: string
  version_id: string
  tile_x: number
  tile_y: number
  changed: number
  previous_correct: number | null
  previous_wrong: number | null
  previous_blank: number | null
  previous_colours_json: string | null
  previous_observed_at_ms: number | null
  previous_template_correct: number
  previous_template_observed_at_ms: number
  published: number
  total_pixels: number
  colour_totals_json: string | null
}

const statusKey = (templateId: string, versionId: string, x: number, y: number) =>
  `${templateId}\u0000${versionId}\u0000${x}/${y}`

/** `TileStore.commitTileObservation`, as one D1-compatible batch: D1 has no interactive transactions. */
export const commitTileObservation = async (
  client: SqlConnection,
  syntax: ReturnType<typeof sqlDialect>,
  {
    reservationId,
    now,
    observation,
    statuses,
    recordHistory,
    authoritative,
    includeUnpublished,
  }: TileObservationCommitRequest,
): Promise<TileObservationCommit | null> => {
  const visible = includeUnpublished ? 1 : 0
  const statements: SqlStatement[] = [
    client.prepare('DELETE FROM tile_blob_reservations WHERE expires_at_ms <= ?').bind(now),
    client
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
      client
        .prepare(
          `INSERT INTO tile_history (
             season, tile_x, tile_y, resolution_s, bucket_start_s, sha256,
             reported_with_token, reported_by_user_id
           )
           SELECT ?, ?, ?, 0, ?, ?, ?, ?
           WHERE ${RESERVATION_ACTIVE}
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
    client
      .prepare(
        `INSERT INTO canvas_tiles (
           season, tile_x, tile_y, sha256, observed_at_ms, server_owned, commit_order
         )
         SELECT ?, ?, ?, ?, ?, ?, 1
         WHERE ${RESERVATION_ACTIVE}
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
        authoritative ? 1 : 0,
        reservationId,
        observation.hash,
      ),
  )
  let statusReadResult: number | null = null
  let revisionResult: number | null = null
  if (statuses.length > 0) {
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
    const incoming = `WITH incoming AS (SELECT
      ${syntax.jsonField('templateId', 'text')} AS template_id,
      ${syntax.jsonField('versionId', 'text')} AS version_id,
      ${syntax.jsonField('tileX')} AS tile_x,
      ${syntax.jsonField('tileY')} AS tile_y,
      ${syntax.jsonField('correct')} AS correct,
      ${syntax.jsonField('wrong')} AS wrong,
      ${syntax.jsonField('blank')} AS blank,
      ${syntax.jsonField('colours', 'json')} AS colours_json,
      ${syntax.jsonField('observedAt')} AS observed_at_ms
      FROM ${syntax.jsonEach})`
    const storedStatus = `LEFT JOIN template_tile_statuses AS status
       ON status.template_id = incoming.template_id
      AND status.version_id = incoming.version_id
      AND status.tile_x = incoming.tile_x
      AND status.tile_y = incoming.tile_y`
    statusReadResult = statements.length
    statements.push(
      client
        .prepare(
          `${incoming}
           SELECT incoming.*,
             CASE WHEN ${statusChanges(authoritative)} THEN 1 ELSE 0 END AS changed,
             status.correct AS previous_correct,
             status.wrong AS previous_wrong,
             status.blank AS previous_blank,
             status.colours_json AS previous_colours_json,
             status.observed_at_ms AS previous_observed_at_ms,
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
           ${CURRENT_TEMPLATE}
           INNER JOIN template_versions AS version ON version.id = incoming.version_id
           ${storedStatus}
           WHERE ${VISIBLE_TEMPLATE}`,
        )
        .bind(statusesJson, visible),
    )
    revisionResult = statements.length
    statements.push(
      client
        .prepare(
          `INSERT INTO status_read_model_revisions (
             season, revision, public_fingerprint, admin_fingerprint, fingerprints_dirty
           )
           SELECT ?, 1, ?, ?, 1
           WHERE ${RESERVATION_ACTIVE} AND EXISTS (
             ${incoming}
             SELECT 1 FROM incoming
             ${CURRENT_TEMPLATE}
             ${storedStatus}
             WHERE ${VISIBLE_TEMPLATE} AND ${statusChanges(authoritative)}
           )
           ON CONFLICT(season) DO UPDATE SET
             revision = status_read_model_revisions.revision + 1,
             fingerprints_dirty = 1
           RETURNING revision`,
        )
        .bind(
          observation.season,
          UNPUBLISHED_FINGERPRINT,
          UNPUBLISHED_FINGERPRINT,
          reservationId,
          observation.hash,
          statusesJson,
          visible,
        ),
      client
        .prepare(`${incoming}
          INSERT INTO template_tile_measurements (version_id, tile_x, tile_y, sha256, correct, wrong, blank)
          SELECT incoming.version_id, incoming.tile_x, incoming.tile_y, ?, incoming.correct, incoming.wrong, incoming.blank
          FROM incoming ${CURRENT_TEMPLATE}
          WHERE ${VISIBLE_TEMPLATE} AND ${RESERVATION_ACTIVE}
          ON CONFLICT DO NOTHING`)
        .bind(statusesJson, observation.hash, visible, reservationId, observation.hash),
      client
        .prepare(
          `${incoming}
           INSERT INTO template_tile_statuses (
             template_id, version_id, tile_x, tile_y, correct, wrong, blank,
             colours_json, observed_at_ms, server_owned
           )
           SELECT incoming.template_id, incoming.version_id, incoming.tile_x, incoming.tile_y,
             incoming.correct, incoming.wrong, incoming.blank, incoming.colours_json,
             incoming.observed_at_ms, ?
           FROM incoming
           ${CURRENT_TEMPLATE}
           WHERE ${VISIBLE_TEMPLATE} AND ${RESERVATION_ACTIVE}
           ON CONFLICT(template_id, version_id, tile_x, tile_y) DO UPDATE SET
             correct = excluded.correct,
             wrong = excluded.wrong,
             blank = excluded.blank,
             colours_json = excluded.colours_json,
             observed_at_ms = excluded.observed_at_ms,
             server_owned = excluded.server_owned
           WHERE ${mayReplace('template_tile_statuses', 'excluded', authoritative)}
             AND (${countsDiffer('template_tile_statuses', 'excluded')}
               OR template_tile_statuses.server_owned <> excluded.server_owned)`,
        )
        .bind(statusesJson, authoritative ? 1 : 0, visible, reservationId, observation.hash),
    )
    if (authoritative) {
      statements.push(
        client
          .prepare(
            `${incoming}
             INSERT INTO template_alarm_tile_statuses (
               template_id, version_id, tile_x, tile_y, correct, wrong, blank,
               colours_json, observed_at_ms
             )
             SELECT incoming.template_id, incoming.version_id, incoming.tile_x, incoming.tile_y,
               incoming.correct, incoming.wrong, incoming.blank, incoming.colours_json,
               incoming.observed_at_ms
             FROM incoming
             ${CURRENT_TEMPLATE}
             WHERE ${VISIBLE_TEMPLATE} AND ${RESERVATION_ACTIVE}
             ON CONFLICT(template_id, version_id, tile_x, tile_y) DO UPDATE SET
               correct = excluded.correct,
               wrong = excluded.wrong,
               blank = excluded.blank,
               colours_json = excluded.colours_json,
               observed_at_ms = excluded.observed_at_ms
             WHERE template_alarm_tile_statuses.observed_at_ms <= excluded.observed_at_ms`,
          )
          .bind(statusesJson, visible, reservationId, observation.hash),
      )
    }
  }
  statements.push(
    client.prepare('DELETE FROM tile_blob_reservations WHERE id = ?').bind(reservationId),
  )
  const results = await client.batch(statements)
  if (Number(results[1]?.meta.changes) === 0) return null

  const acceptedRows =
    statusReadResult === null
      ? []
      : ((results[statusReadResult]?.results as AcceptedStatusRow[] | undefined) ?? [])
  const incomingByKey = new Map(
    statuses.map((status) => [
      statusKey(status.templateId, status.versionId, status.tile.x, status.tile.y),
      status,
    ]),
  )
  const statusChangeRows = acceptedRows.flatMap((row) => {
    const current = incomingByKey.get(
      statusKey(row.template_id, row.version_id, row.tile_x, row.tile_y),
    )
    if (current === undefined || Number(row.changed) !== 1) return []
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
                colours: parseColourStatuses(row.previous_colours_json ?? '[]'),
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
  return { revision, statusChanges: statusChangeRows, current }
}
