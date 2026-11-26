import {
  type ContributionDay,
  type LeaderboardEntry,
  type Millis,
  type Seconds,
  seconds,
} from '@caelestis/shared'
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, type SQL, sql } from 'drizzle-orm'
import { RelationalStore } from '../../adapters/relational-store.js'
import type { SqlStatement } from '../../adapters/sql-connection.js'
import { IDS_PER_STATEMENT, MAX_IDS_PER_READ, tooManyIds } from '../../db/d1-limits.js'
import {
  appliedEvents,
  contributions,
  painterBucketCollection,
  painters,
  painterTelemetryBuckets,
  telemetryBuckets,
  templates,
} from '../../db/schema.js'
import { DECAY_FOLD_GROUP_LIMIT, foldCutoff } from '../decay.js'
import {
  assertValidBuckets,
  assertValidPainterBuckets,
  compareBuckets,
  comparePainterBuckets,
  type PainterTelemetryBucket,
  TELEMETRY_DECAY_EDGES,
  type TelemetryBucket,
} from './ladder.js'
import {
  assertValidContributionQuery,
  type BucketQuery,
  type ContributionQuery,
  compareContributionDays,
  type HistoryStore,
  MAX_PAINTER_HISTORY_IDS,
  type PaintEventAccounting,
  type PaintEventApplication,
  type PainterBucketQuery,
  type PainterTotalRow,
  type PainterTotalsQuery,
  painterLabel,
} from './store.js'

const fromRow = (row: typeof telemetryBuckets.$inferSelect): TelemetryBucket => ({
  templateId: row.templateId,
  resolution: row.resolution,
  bucketStart: seconds(row.bucketStartS),
  placed: row.placed,
  correct: row.correct,
  repairs: row.repairs,
})

/** One bucket table the decay ladder folds. */
interface BucketFold {
  readonly table: 'telemetry_buckets' | 'painter_telemetry_buckets'
  /** Key columns between the template and the tier, carried through a fold unchanged. */
  readonly keys: readonly string[]
  /**
   * Whether a fold adds into an existing target row. Template buckets hold cumulative totals a
   * flush rewrites, so the fold replaces; painter buckets hold per-event sums, and a late report may
   * already sit at the target tier (`painterBucketResolution`), so the fold adds.
   */
  readonly additive: boolean
}

const TEMPLATE_BUCKETS: BucketFold = { table: 'telemetry_buckets', keys: [], additive: false }
const PAINTER_BUCKETS: BucketFold = {
  table: 'painter_telemetry_buckets',
  keys: ['wplace_user_id'],
  additive: true,
}

/**
 * `ids` without repeats, within the read cap. Deduplicate before chunking: each chunk returns its
 * own rows and the merge does not join them, so an id repeated across two chunks would come back
 * twice and double-count it for any consumer summing the result.
 */
const distinctIds = <Id>(ids: readonly Id[], operation: string): Id[] => {
  const distinct = [...new Set(ids)]
  if (distinct.length > MAX_IDS_PER_READ) throw tooManyIds(distinct.length, operation)
  return distinct
}

/**
 * Run `read` over `ids` in bound-parameter-sized chunks and concatenate the rows. Concatenated
 * rather than spread into `push`: a spread passes every row as a separate argument, so a chunk
 * returning more rows than V8's argument limit — around 125,000, which 90 templates at minute
 * resolution reach in under a day — throws RangeError instead of answering. The id count is
 * bounded; the row count is bounded only by the window the caller asks for.
 */
const readIdChunks = async <Id, Row>(
  ids: readonly Id[],
  read: (chunk: readonly Id[]) => Promise<readonly Row[]>,
): Promise<Row[]> => {
  let rows: Row[] = []
  for (let offset = 0; offset < ids.length; offset += IDS_PER_STATEMENT) {
    rows = rows.concat(await read(ids.slice(offset, offset + IDS_PER_STATEMENT)))
  }
  return rows
}

/**
 * A painter's name and last sighting: the newer `seen_at_ms` wins. Binds id, name and time;
 * `guard` gates the write inside a batch.
 */
const upsertPainter = (
  guard: string,
) => `INSERT INTO painters (wplace_user_id, display_name, seen_at_ms)
  SELECT ?, ?, ?
  WHERE ${guard}
  ON CONFLICT(wplace_user_id) DO UPDATE SET
    display_name = excluded.display_name,
    seen_at_ms = excluded.seen_at_ms
  WHERE painters.seen_at_ms <= excluded.seen_at_ms`

export class RelationalHistoryStore extends RelationalStore implements HistoryStore {
  async applyPaintEvent(
    eventId: string,
    wplaceUserId: number,
    displayName: string,
    seenAt: Millis,
    accounting: PaintEventAccounting,
  ): Promise<PaintEventApplication> {
    const encodedAccounting = JSON.stringify(accounting)
    const claim = this.client
      .prepare(
        `INSERT INTO applied_events (event_id, wplace_user_id, seen_at_ms, accounting_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .bind(eventId, wplaceUserId, seenAt, encodedAccounting)
    const statements: SqlStatement[] = [claim]
    if (accounting.contributions.length > 0) {
      statements.push(
        this.client
          .prepare(
            `INSERT INTO contributions (
               wplace_user_id, template_id, day_s, reported_with_token, reported_by_user_id,
               placed, correct, repairs
             )
             SELECT
               ${this.syntax.jsonField('wplaceUserId')},
               ${this.syntax.jsonField('templateId', 'text')},
               ${this.syntax.jsonField('day')},
               ${this.syntax.jsonField('reportedWithToken', 'text')},
               ${this.syntax.jsonField('reportedByUserId')},
               ${this.syntax.jsonField('placed')},
               ${this.syntax.jsonField('correct')},
               ${this.syntax.jsonField('repairs')}
             FROM ${this.syntax.jsonEach}
             WHERE ${this.syntax.previousChanged}
             ON CONFLICT(wplace_user_id, template_id, day_s, reported_by_user_id) DO UPDATE SET
               reported_with_token = excluded.reported_with_token,
               placed = contributions.placed + excluded.placed,
               correct = contributions.correct + excluded.correct,
               repairs = contributions.repairs + excluded.repairs`,
          )
          .bind(JSON.stringify(accounting.contributions)),
      )
    }
    const painterBuckets = accounting.painterBuckets ?? []
    if (painterBuckets.length > 0) {
      // Ahead of the batch, so a poison row is a synchronous error naming the column rather than a
      // CHECK failure that fails the whole paint.
      assertValidPainterBuckets(painterBuckets)
      statements.push(
        this.client
          .prepare(
            `INSERT INTO painter_telemetry_buckets (
               template_id, wplace_user_id, resolution, bucket_start_s, placed, correct, repairs
             )
             SELECT
               ${this.syntax.jsonField('templateId', 'text')},
               ${this.syntax.jsonField('wplaceUserId')},
               ${this.syntax.jsonField('resolution')},
               ${this.syntax.jsonField('bucketStart')},
               ${this.syntax.jsonField('placed')},
               ${this.syntax.jsonField('correct')},
               ${this.syntax.jsonField('repairs')}
             FROM ${this.syntax.jsonEach}
             WHERE ${this.syntax.previousChanged}
             ON CONFLICT(template_id, wplace_user_id, resolution, bucket_start_s) DO UPDATE SET
               placed = painter_telemetry_buckets.placed + excluded.placed,
               correct = painter_telemetry_buckets.correct + excluded.correct,
               repairs = painter_telemetry_buckets.repairs + excluded.repairs`,
          )
          .bind(JSON.stringify(painterBuckets)),
      )
    }
    statements.push(
      this.client
        .prepare(upsertPainter(this.syntax.previousChanged))
        .bind(wplaceUserId, displayName, seenAt),
    )
    const results = await this.client.batch(statements)
    if (Number(results[0]?.meta.changes) > 0) return { applied: true, accounting }

    const [stored] = await this.database
      .select({ accountingJson: appliedEvents.accountingJson })
      .from(appliedEvents)
      .where(eq(appliedEvents.eventId, eventId))
      .limit(1)
    return {
      applied: false,
      accounting:
        stored?.accountingJson === null || stored?.accountingJson === undefined
          ? null
          : (JSON.parse(stored.accountingJson) as PaintEventAccounting),
    }
  }

  async rememberPainter(wplaceUserId: number, displayName: string, seenAt: Millis): Promise<void> {
    await this.client.prepare(upsertPainter('1 = 1')).bind(wplaceUserId, displayName, seenAt).run()
  }

  async appendAndFold(buckets: readonly TelemetryBucket[], now: Seconds): Promise<void> {
    if (buckets.length === 0) return
    // Ahead of the batch, so a poison row is a synchronous error naming the column rather than a
    // CHECK failure the shard's alarm retries forever.
    assertValidBuckets(buckets)

    const statements = buckets.map((bucket) =>
      this.database
        .insert(telemetryBuckets)
        .values({
          templateId: bucket.templateId,
          resolution: bucket.resolution,
          bucketStartS: bucket.bucketStart,
          placed: bucket.placed,
          correct: bucket.correct,
          repairs: bucket.repairs,
        })
        .onConflictDoUpdate({
          target: [
            telemetryBuckets.templateId,
            telemetryBuckets.resolution,
            telemetryBuckets.bucketStartS,
          ].map((column) => sql`${sql.identifier(column.name)}`),
          set: {
            placed: sql`excluded.placed`,
            correct: sql`excluded.correct`,
            repairs: sql`excluded.repairs`,
          },
        }),
    )

    await this.database.batch(
      statements as [(typeof statements)[number], ...Array<(typeof statements)[number]>],
    )
    const templateIds = [...new Set(buckets.map((bucket) => bucket.templateId))]
    await this.#fold(TEMPLATE_BUCKETS, templateIds, now)
    await this.#fold(PAINTER_BUCKETS, templateIds, now)
  }

  /** Fold and prune one bucket table's eligible deltas for the touched templates, tier by tier. */
  async #fold(fold: BucketFold, templateIds: readonly string[], now: Seconds): Promise<void> {
    // FLUSH_BATCH_LIMIT keeps a flush's templates inside one statement; see `d1-limits.ts`.
    if (templateIds.length > IDS_PER_STATEMENT) {
      throw new RangeError(`a fold binds at most ${IDS_PER_STATEMENT} template ids`)
    }
    const idBindings = templateIds.map(() => '?').join(', ')
    const key = fold.keys.map((column) => `, ${column}`).join('')
    const sourceKey = fold.keys.map((column) => `, source.${column}`).join('')
    const merge = (column: string) =>
      fold.additive
        ? `${column} = ${fold.table}.${column} + excluded.${column}`
        : `${column} = excluded.${column}`
    for (const edge of TELEMETRY_DECAY_EDGES) {
      const targetStart = `CAST(source.bucket_start_s / ${edge.target} AS BIGINT) * ${edge.target}`
      // One group per template and target window, across every key beneath the template, so the
      // group limit bounds windows and a window never half-folds.
      const chosen = `
        SELECT source.template_id, ${targetStart} AS target_start
        FROM ${fold.table} AS source
        WHERE source.resolution = ${edge.source}
          AND source.template_id IN (${idBindings})
          AND ${targetStart} + ${edge.target} <= ?
          AND NOT EXISTS (
            SELECT 1 FROM ${fold.table} AS finer
            WHERE finer.template_id = source.template_id
              AND finer.resolution < ${edge.source}
              AND finer.bucket_start_s >= ${targetStart}
              AND finer.bucket_start_s < ${targetStart} + ${edge.target}
          )
        GROUP BY source.template_id, target_start
        ORDER BY MIN(source.bucket_start_s), source.template_id
        LIMIT ?`
      // Insert and delete share one batch, so an additive sum is never applied twice.
      const insert = `
        WITH chosen AS (${chosen})
        INSERT INTO ${fold.table} (
          template_id${key}, resolution, bucket_start_s, placed, correct, repairs
        )
        SELECT source.template_id${sourceKey}, ${edge.target}, chosen.target_start,
          SUM(source.placed), SUM(source.correct), SUM(source.repairs)
        FROM ${fold.table} AS source
        INNER JOIN chosen
          ON chosen.template_id = source.template_id
          AND chosen.target_start = CAST(source.bucket_start_s / ${edge.target} AS BIGINT) * ${edge.target}
        WHERE source.resolution = ${edge.source}
        GROUP BY source.template_id${sourceKey}, chosen.target_start
        ON CONFLICT(template_id${key}, resolution, bucket_start_s) DO UPDATE SET
          ${merge('placed')},
          ${merge('correct')},
          ${merge('repairs')}`
      const remove = `
        WITH chosen AS (${chosen})
        DELETE FROM ${fold.table} AS source
        WHERE source.resolution = ${edge.source}
          AND EXISTS (
            SELECT 1 FROM chosen
            WHERE chosen.template_id = source.template_id
              AND chosen.target_start = CAST(source.bucket_start_s / ${edge.target} AS BIGINT) * ${edge.target}
          )`
      const cutoff = foldCutoff(edge, now)
      const bindings = [...templateIds, cutoff, DECAY_FOLD_GROUP_LIMIT]
      await this.client.batch([
        this.client.prepare(insert).bind(...bindings),
        this.client.prepare(remove).bind(...bindings),
      ])
    }
  }

  async readPainterBuckets(query: PainterBucketQuery): Promise<readonly PainterTelemetryBucket[]> {
    const wplaceUserIds = [...new Set(query.wplaceUserIds)]
    if (wplaceUserIds.length > MAX_PAINTER_HISTORY_IDS) {
      throw new Error(
        `readPainterBuckets accepts at most ${MAX_PAINTER_HISTORY_IDS} painters per call; received ${wplaceUserIds.length}`,
      )
    }
    if (query.templateIds.length === 0 || wplaceUserIds.length === 0) return []
    const resolutions = [...new Set(query.resolutions)]
    if (resolutions.length === 0) return []
    const templateIds = distinctIds(query.templateIds, 'readPainterBuckets')
    const rows = await readIdChunks(templateIds, (chunk) =>
      this.database
        .select()
        .from(painterTelemetryBuckets)
        .where(
          and(
            inArray(painterTelemetryBuckets.resolution, resolutions),
            gte(painterTelemetryBuckets.bucketStartS, query.fromSeconds),
            lt(painterTelemetryBuckets.bucketStartS, query.toSeconds),
            inArray(painterTelemetryBuckets.templateId, chunk),
            inArray(painterTelemetryBuckets.wplaceUserId, wplaceUserIds),
          ),
        ),
    )
    return rows
      .map(
        (row): PainterTelemetryBucket => ({
          templateId: row.templateId,
          wplaceUserId: row.wplaceUserId,
          resolution: row.resolution,
          bucketStart: row.bucketStartS,
          placed: row.placed,
          correct: row.correct,
          repairs: row.repairs,
        }),
      )
      .sort(comparePainterBuckets)
  }

  async readPainterNames(wplaceUserIds: readonly number[]): Promise<ReadonlyMap<number, string>> {
    const rows = await readIdChunks(distinctIds(wplaceUserIds, 'readPainterNames'), (chunk) =>
      this.database
        .select({ wplaceUserId: painters.wplaceUserId, displayName: painters.displayName })
        .from(painters)
        .where(inArray(painters.wplaceUserId, chunk)),
    )
    return new Map(rows.map((row) => [row.wplaceUserId, row.displayName]))
  }

  async readPainterTotals(
    query: PainterTotalsQuery,
    limit: number,
  ): Promise<readonly PainterTotalRow[]> {
    if (query.templateIds.length === 0) return []
    const resolutions = [...new Set(query.resolutions)]
    if (resolutions.length === 0) return []
    const templateIds = distinctIds(query.templateIds, 'readPainterTotals')
    const windows = templateIds.map((id) => {
      const window = query.windows.get(id)
      return {
        id,
        start: Math.max(query.fromSeconds, window?.start ?? 0),
        end: Math.min(query.toSeconds, window?.end ?? query.toSeconds),
        cap: window?.end ?? null,
      }
    })
    const field = this.syntax.jsonField
    const { results } = await this.client
      .prepare(`
      WITH template_windows AS (
        SELECT ${field('id', 'text')} AS template_id, ${field('start')} AS start_s,
          ${field('end')} AS end_s, ${field('cap')} AS cap_s
        FROM ${this.syntax.jsonEach}
      )
      SELECT bucket.wplace_user_id AS "wplaceUserId", sum(bucket.placed) AS placed,
        sum(bucket.correct) AS correct, sum(bucket.repairs) AS repairs
      FROM template_windows AS window_bounds
      JOIN painter_telemetry_buckets AS bucket ON bucket.template_id = window_bounds.template_id
        AND bucket.bucket_start_s >= window_bounds.start_s
        AND bucket.bucket_start_s < window_bounds.end_s
        AND (window_bounds.cap_s IS NULL OR bucket.bucket_start_s + bucket.resolution <= window_bounds.cap_s)
      WHERE bucket.resolution IN (${resolutions.map(() => '?').join(', ')})
      GROUP BY bucket.wplace_user_id
      ORDER BY correct DESC, placed DESC, bucket.wplace_user_id
      LIMIT ?
    `)
      .bind(JSON.stringify(windows), ...resolutions, limit)
      .all<PainterTotalRow>()
    return results.map(({ wplaceUserId, placed, correct, repairs }) => ({
      wplaceUserId: Number(wplaceUserId),
      placed: Number(placed),
      correct: Number(correct),
      repairs: Number(repairs),
    }))
  }

  async readPainterCollectionStart(): Promise<Seconds | null> {
    const [row] = await this.database
      .select({ sinceS: painterBucketCollection.sinceS })
      .from(painterBucketCollection)
      .where(eq(painterBucketCollection.id, 1))
      .limit(1)
    return row?.sinceS ?? null
  }

  async readBuckets(query: BucketQuery): Promise<readonly TelemetryBucket[]> {
    if (query.templateIds.length === 0) return []
    const resolutions = [...new Set(query.resolutions)]
    if (resolutions.length === 0) return []
    const templateIds = distinctIds(query.templateIds, 'readBuckets')
    const rows = await readIdChunks(templateIds, (chunk) =>
      this.database
        .select()
        .from(telemetryBuckets)
        .where(
          and(
            inArray(telemetryBuckets.resolution, resolutions),
            gte(telemetryBuckets.bucketStartS, query.fromSeconds),
            lt(telemetryBuckets.bucketStartS, query.toSeconds),
            inArray(telemetryBuckets.templateId, chunk),
          ),
        )
        .orderBy(asc(telemetryBuckets.templateId), asc(telemetryBuckets.bucketStartS)),
    )

    // Each chunk is ordered, but the concatenation of ordered chunks is not: template ids are
    // distributed across chunks in input order, not sort order. The contract is a single ordered
    // result, so the merge has to re-sort.
    return rows.map(fromRow).sort(compareBuckets)
  }

  /** The contribution rows `query` may see, narrowed to `chunk` when it names template ids. */
  #contributionFilter(query: ContributionQuery, chunk: readonly string[] | SQL | null) {
    // The season and publish filters are one IN-subquery rather than a join, so one builder shape
    // serves the season-only, ids-only and intersected forms — and the group key stays the three
    // columns the reduction is defined over, with nothing joined in to widen it. The publish gate
    // applies to explicit-id queries too: a read-scoped caller holding a stale id must get the
    // same nothing the manifest gives it.
    const templateGate =
      query.season === undefined && query.includeUnpublished
        ? undefined
        : inArray(
            contributions.templateId,
            this.database
              .select({ id: templates.id })
              .from(templates)
              .where(
                and(
                  query.season === undefined ? undefined : eq(templates.season, query.season),
                  query.includeUnpublished ? undefined : isNotNull(templates.publishedAt),
                ),
              ),
          )
    return and(
      chunk === null ? undefined : inArray(contributions.templateId, chunk),
      templateGate,
      query.fromSeconds === undefined ? undefined : gte(contributions.dayS, query.fromSeconds),
      query.toSeconds === undefined ? undefined : lt(contributions.dayS, query.toSeconds),
    )
  }

  async readContributions(query: ContributionQuery): Promise<readonly ContributionDay[]> {
    assertValidContributionQuery(query)
    const readChunk = (chunk: readonly string[] | null) =>
      this.database
        .select({
          templateId: contributions.templateId,
          day: contributions.dayS,
          wplaceUserId: contributions.wplaceUserId,
          // MAX-then-SUM, and this is the MAX: one row per reporter describes the same painter-day,
          // so the largest view per counter is the day's truth and summing reporter rows multiplies
          // credit by reporter count. See the rollup note on the `contributions` schema.
          displayName: sql<string | null>`max(${painters.displayName})`,
          placed: sql<number>`max(${contributions.placed})`,
          correct: sql<number>`max(${contributions.correct})`,
          repairs: sql<number>`max(${contributions.repairs})`,
        })
        .from(contributions)
        .leftJoin(painters, eq(painters.wplaceUserId, contributions.wplaceUserId))
        .where(this.#contributionFilter(query, chunk))
        .groupBy(contributions.templateId, contributions.dayS, contributions.wplaceUserId)

    // Chunked like `readBuckets`, and safe for the same structural reason: the group key contains
    // the template id, so every group lands wholly inside one chunk and concatenation loses nothing.
    const rows =
      query.templateIds === undefined
        ? await readChunk(null)
        : await readIdChunks([...new Set(query.templateIds)], readChunk)
    return rows
      .map((row) => ({
        templateId: row.templateId,
        day: row.day,
        wplaceUserId: row.wplaceUserId,
        displayName: painterLabel(row.wplaceUserId, row.displayName),
        placed: row.placed,
        correct: row.correct,
        repairs: row.repairs,
      }))
      .sort(compareContributionDays)
  }

  async readLeaderboard(
    query: ContributionQuery,
    limit: number,
  ): Promise<readonly LeaderboardEntry[]> {
    assertValidContributionQuery(query)
    // Every id travels in one JSON parameter, so one statement sees a painter's whole total however
    // many templates are named, within D1's bound-parameter budget.
    const [beforeIds = '', afterIds = ''] = this.syntax.jsonEach.split('?')
    const idsJson = JSON.stringify([...new Set(query.templateIds ?? [])].map((id) => ({ id })))
    const templateIds =
      query.templateIds === undefined
        ? null
        : sql`(SELECT ${sql.raw(this.syntax.jsonField('id', 'text'))} FROM ${sql.raw(beforeIds)}${idsJson}${sql.raw(afterIds)})`
    // The MAX per painter-day that `readContributions` returns, then the SUM per painter, ranked
    // and limited in the database rather than shipped out row by row.
    const days = this.database
      .select({
        wplaceUserId: contributions.wplaceUserId,
        day: contributions.dayS,
        placed: sql<number>`max(${contributions.placed})`.as('placed'),
        correct: sql<number>`max(${contributions.correct})`.as('correct'),
        repairs: sql<number>`max(${contributions.repairs})`.as('repairs'),
      })
      .from(contributions)
      .where(this.#contributionFilter(query, templateIds))
      .groupBy(contributions.templateId, contributions.dayS, contributions.wplaceUserId)
      .as('painter_days')
    const correct = sql<number>`sum(${days.correct})`
    const placed = sql<number>`sum(${days.placed})`
    const rows = await this.database
      .select({
        wplaceUserId: days.wplaceUserId,
        displayName: sql<string | null>`max(${painters.displayName})`,
        placed,
        correct,
        repairs: sql<number>`sum(${days.repairs})`,
        activeDays: sql<number>`count(distinct ${days.day})`,
        lastDay: sql<number>`max(${days.day})`,
      })
      .from(days)
      .leftJoin(painters, eq(painters.wplaceUserId, days.wplaceUserId))
      .groupBy(days.wplaceUserId)
      // The id is only a stable tiebreak. It is not part of the advertised ranking.
      .orderBy(desc(correct), desc(placed), asc(days.wplaceUserId))
      .limit(limit)
    // PostgreSQL returns sums and counts as bigint strings.
    return rows.map((row) => ({
      wplaceUserId: row.wplaceUserId,
      displayName: painterLabel(row.wplaceUserId, row.displayName),
      placed: Number(row.placed),
      correct: Number(row.correct),
      repairs: Number(row.repairs),
      activeDays: Number(row.activeDays),
      lastDay: seconds(Number(row.lastDay)),
    }))
  }
}
