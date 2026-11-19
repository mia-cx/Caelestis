/**
 * The names Caelestis leaves on the page, where every copy of every build can see them. A userscript
 * and an extension of different versions can share one page, so these never change.
 */

/** The builds that can run Caelestis on a page. */
export type Build = 'userscript' | 'extension'

/** Set on the inline page script by the copy it starts, so the manager's copy knows it ran. */
export const RAN_ATTRIBUTE = 'data-caelestis-ran'

/** The page `window` property naming the build that claimed the page (see `page-claim.ts`). */
export const CLAIM_PROPERTY = '__caelestisBuild'

/** The page `window` property where the two builds meet at document start (see `build-transfer.ts`). */
export const MEETING_PROPERTY = '__caelestisMeeting'

/** The `type` of the one `window` message that hands the storage bridge's port over. */
export const BRIDGE_HANDOFF = 'caelestis:storage-bridge'

/** The page `window` property holding the console diagnostics (see `console-api.ts`). */
export const CONSOLE_PROPERTY = '__caelestis'
