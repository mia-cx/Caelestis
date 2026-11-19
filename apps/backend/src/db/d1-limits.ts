/**
 * D1's statement budgets, which every relational store respects so the same code runs on D1.
 *
 * Tests run on `node:sqlite`, whose bound-parameter limit is 32,766, so no test can observe these
 * ceilings; the code counts statements and parameters against them instead.
 */

/** Bound parameters one D1 statement accepts. */
export const D1_MAX_BOUND_PARAMETERS = 100

/** Ids one `IN (...)` statement binds: the parameter budget less room for its other bindings. */
export const IDS_PER_STATEMENT = 90

/**
 * Id statements one read may issue. D1's free plan allows 50 queries per Worker invocation; 40
 * leaves headroom for the rest of the request.
 */
const ID_STATEMENTS_PER_READ = 40

/** Distinct ids one read may name. Routes bound their requests by it. */
export const MAX_IDS_PER_READ = IDS_PER_STATEMENT * ID_STATEMENTS_PER_READ

export const tooManyIds = (count: number, method: string): Error =>
  new Error(`${method} accepts at most ${MAX_IDS_PER_READ} ids per call; received ${count}`)

/** Bucket rows one counter flush writes, each its own statement in one batch, within the 50. */
export const FLUSH_BATCH_LIMIT = 40

// A flush folds the templates its buckets name in one statement per tier, binding every id, so a
// full flush batch must fit one id statement.
if (FLUSH_BATCH_LIMIT > IDS_PER_STATEMENT) {
  throw new Error('FLUSH_BATCH_LIMIT must not exceed IDS_PER_STATEMENT')
}

/*
 * Rows per multi-row statement, each under D1_MAX_BOUND_PARAMETERS. Multi-row writes keep a large
 * upload or fold inside the per-invocation query budget.
 */
/** `version_tiles`: 4 parameters a row, 96 in all. */
export const VERSION_TILE_ROWS_PER_INSERT = 24
/** `template_tile_measurements`: 7 parameters a row, 70 in all. */
export const TILE_MEASUREMENT_ROWS_PER_INSERT = 10
/** `tile_history`: 8 parameters a row, 80 in all. */
export const TILE_HISTORY_ROWS_PER_INSERT = 10
/** `tile_history` keys: 3 parameters a key plus the tile's 3, 63 in all. */
export const TILE_HISTORY_KEYS_PER_DELETE = 20
