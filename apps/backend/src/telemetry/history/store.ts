import type {
  ContributionDay,
  LeaderboardEntry,
  Millis,
  ProgressWindow,
  Seconds,
} from '@caelestis/shared'
import { MAX_IDS_PER_READ, tooManyIds } from '../../db/d1-limits.js'
import type { CounterDelta } from '../../ports/counter-store.js'
import type { PainterTelemetryBucket, TelemetryBucket } from './ladder.js'

export interface BucketQuery {
  readonly templateIds: readonly string[]
  /** The ladder tiers to read; several retained tiers make a lossless server-side read. */
  readonly resolutions: readonly number[]
  readonly fromSeconds: Seconds
  readonly toSeconds: Seconds
}

/** `BucketQuery` for named painters only, so a read is bounded by who is being drawn. */
export interface PainterBucketQuery extends BucketQuery {
  readonly wplaceUserIds: readonly number[]
}

export interface PainterTotalsQuery extends BucketQuery {
  readonly windows: ReadonlyMap<string, ProgressWindow>
}

/** Painter ids one `readPainterBuckets` call may name: the wire bound on the history route. */
export const MAX_PAINTER_HISTORY_IDS = 50

/**
 * A painter's label: the display name last seen, else the id as text. A painter seen only through
 * another member's reports has no name yet, and the wire schema requires a non-empty label.
 */
export const painterLabel = (wplaceUserId: number, displayName: string | null | undefined) =>
  displayName ?? String(wplaceUserId)

/** One painter's counters summed over a range, before names are attached. */
export interface PainterTotalRow {
  readonly wplaceUserId: number
  readonly placed: number
  readonly correct: number
  readonly repairs: number
}

/**
 * What `readContributions` may be asked for.
 *
 * At least one of `season` and `templateIds` is required — with neither, the query is a full-table
 * scan over every season's contributions, which no caller means and which grows without bound.
 * `season` widens to every template in that season; `templateIds` narrows to the named ones; both
 * together intersect. The time range is half-open `[from, to)` on `day` and optional at this layer,
 * because the leaderboard legitimately reads a whole season.
 */
export interface ContributionQuery {
  /** Restrict to templates in this season, resolved through the `templates` table. */
  readonly season?: number
  /** Restrict to these templates. Duplicate ids are read once; the read-cap applies. */
  readonly templateIds?: readonly string[]
  readonly fromSeconds?: Seconds
  readonly toSeconds?: Seconds
  /**
   * Whether unpublished templates' rows may appear, mirroring the manifest's admin gate.
   *
   * Required rather than defaulted, and enforced in the store rather than the route: an unpublished
   * template is invisible to a read-scoped caller, and a caller that merely *knows* its id — from a
   * manifest poll made before it was unpublished — must not keep reading its telemetry through this
   * side door. Explicit-id and season queries are filtered alike.
   */
  readonly includeUnpublished: boolean
}

export const assertValidContributionQuery = (query: ContributionQuery): void => {
  if (query.season === undefined && query.templateIds === undefined) {
    throw new Error('readContributions requires a season or template ids')
  }
  const distinct = new Set(query.templateIds ?? []).size
  if (distinct > MAX_IDS_PER_READ) throw tooManyIds(distinct, 'readContributions')
}

/** The order every `readContributions` answer has. Binary comparison, as `compareBuckets` explains. */
export const compareContributionDays = (left: ContributionDay, right: ContributionDay): number => {
  if (left.templateId < right.templateId) return -1
  if (left.templateId > right.templateId) return 1
  return left.day - right.day || left.wplaceUserId - right.wplaceUserId
}

export interface ContributionDelta {
  readonly templateId: string
  readonly wplaceUserId: number
  readonly day: Seconds
  readonly reportedWithToken: string
  readonly reportedByUserId: number
  readonly placed: number
  readonly correct: number
  readonly repairs: number
}

/** The immutable classification both stores replay for one paint event. */
export interface PaintEventAccounting {
  readonly counters: readonly CounterDelta[]
  readonly contributions: readonly ContributionDelta[]
  /**
   * The painter's share of each template's counters at the ladder tier the paint's window had
   * reached when it was applied. Absent on classifications stored before painter buckets existed.
   */
  readonly painterBuckets?: readonly PainterTelemetryBucket[]
}

export interface PaintEventApplication {
  readonly applied: boolean
  /** Null identifies a pre-cutover claim whose original classification was never stored. */
  readonly accounting: PaintEventAccounting | null
}

/**
 * Telemetry history: template and painter buckets on the decay ladder, per-painter contributions,
 * and the leaderboard over them. The system of record; the counter store in front of it is a
 * write-absorption buffer.
 */
export interface HistoryStore {
  /**
   * Write one counter flush's folded bucket totals with replace semantics, then fold the touched
   * templates' template and painter buckets up the ladder.
   *
   * Idempotent on `(templateId, resolution, bucketStart)`: a retried flush rewrites each bucket's
   * cumulative total and never double-counts. Painter buckets are written per paint rather than
   * flushed, but they age on the same ladder, so the flush that folds a template folds its painters.
   */
  appendAndFold(buckets: readonly TelemetryBucket[], now: Seconds): Promise<void>

  /**
   * Folded buckets for a set of templates at the queried tiers over a half-open range, ordered by
   * `compareBuckets`. Duplicate ids are read once; more than `MAX_IDS_PER_READ` are refused.
   */
  readBuckets(query: BucketQuery): Promise<readonly TelemetryBucket[]>

  /**
   * The named painters' folded buckets, ordered by `comparePainterBuckets`. Same id cap as
   * `readBuckets`; at most `MAX_PAINTER_HISTORY_IDS` painters, so the result is bounded by who is
   * drawn rather than by how long the scope has lived.
   */
  readPainterBuckets(query: PainterBucketQuery): Promise<readonly PainterTelemetryBucket[]>

  /**
   * Every painter's counters summed over the range, leading first (correct, then placed, then id)
   * and cut at `limit`. Summed in the database, so a scope's whole lifetime costs a bounded list.
   */
  readPainterTotals(query: PainterTotalsQuery, limit: number): Promise<readonly PainterTotalRow[]>

  /**
   * When this deployment started keeping painter buckets, or null before the table's migration
   * ran. History reads clamp their coverage to it so the time before is unavailable, not silent.
   */
  readPainterCollectionStart(): Promise<Seconds | null>

  /**
   * The display name last seen for each of these painters; absent ids are left out for
   * `painterLabel` to fill. Same id cap as `readBuckets`.
   */
  readPainterNames(wplaceUserIds: readonly number[]): Promise<ReadonlyMap<number, string>>

  /**
   * Per-painter-per-day contributions, reduced across reporters before anything sums them.
   *
   * `(wplace_user_id, template_id, day_s)` is deliberately not unique — every member of an alliance
   * reports, so several rows describe one painter's day. This read collapses them with the maximum
   * of each counter, because a reporter that saw less of a day cannot disprove one that saw more,
   * and returns rows a caller may then sum freely. Summing raw reporter rows would multiply a
   * painter's credit by their reporter count.
   *
   * `displayName` falls back to the user id, so a painter seen only through another member's
   * reports still has a label. Ordered by `compareContributionDays`.
   */
  readContributions(query: ContributionQuery): Promise<readonly ContributionDay[]>

  /**
   * The `limit` leading painters over the same reduced rows `readContributions` returns: correct,
   * then placed, both descending, with the painter id as a stable tiebreak. `activeDays` counts
   * distinct days across templates.
   */
  readLeaderboard(query: ContributionQuery, limit: number): Promise<readonly LeaderboardEntry[]>

  /** Atomically store one classification and apply its contributions, then replay it on retries. */
  applyPaintEvent(
    eventId: string,
    wplaceUserId: number,
    displayName: string,
    seenAt: Millis,
    accounting: PaintEventAccounting,
  ): Promise<PaintEventApplication>

  rememberPainter(wplaceUserId: number, displayName: string, seenAt: Millis): Promise<void>
}
