/**
 * What the archive routes and the archive CLI agree on. The CLI runs outside the server, so this
 * module imports nothing.
 */

/** Where the archive routes are mounted, under the API root. */
export const ARCHIVE_ROUTE = '/admin/archive'

/** Response header carrying the cursor of the next export page; absent on the last page. */
export const ARCHIVE_NEXT_HEADER = 'caelestis-archive-next'

/** One append stays inside a Worker request and a D1 batch. */
export const MAX_RESTORE_LINES = 500

/** The most record bytes one append may send. */
export const MAX_RESTORE_MIB = 64

/** The `code` of a 409 answered because another archive request holds the lease. */
export const ARCHIVE_LEASE_BUSY = 'archive-lease-busy'
