import { BACKEND_ORIGIN } from '../wplace-raster.js'

/**
 * Which Wplace feature a mirrored template comes from: a native alliance record, or an official
 * event overlay such as the Seven Seals fragments. Wplace serves these itself; Caelestis only
 * mirrors them, read-only.
 */
export type WplaceOwner = 'alliance' | 'event'

/**
 * The URL each owner's template ids, folders and switches are keyed under, where a server's would
 * be. Stored switches and tree keys hold these, so they never change.
 */
export const WPLACE_OWNER_URL: Readonly<Record<WplaceOwner, string>> = {
  alliance: BACKEND_ORIGIN,
  event: 'https://wplace.live',
}
