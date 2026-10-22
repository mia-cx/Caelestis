/** Native alliance records stay owned by Wplace. Extra Caelestis records never enter its capped API. */
export const NATIVE_ALLIANCE_OWNER = 'https://backend.wplace.live'
/** Wplace's official event overlays, such as the Seven Seals fragments. */
export const OFFICIAL_OVERLAY_OWNER = 'https://wplace.live'

/**
 * Wplace serves these templates itself; Caelestis only mirrors them, read-only.
 *
 * No Caelestis server measures them either, so their progress and markers come from tile pixels,
 * exactly like local art.
 */
export const isWplaceOwned = (serverUrl: string | undefined): boolean =>
  serverUrl === NATIVE_ALLIANCE_OWNER || serverUrl === OFFICIAL_OVERLAY_OWNER

/** Whether Caelestis measures this template from tile pixels rather than a server's reports. */
export const measuresLocally = (template: { readonly serverUrl?: string | undefined }): boolean =>
  template.serverUrl === undefined || isWplaceOwned(template.serverUrl)
