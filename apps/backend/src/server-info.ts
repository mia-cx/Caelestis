import type { ServerAsset, ServerInfo } from '@caelestis/shared'
import type { ServerAssetRecord, ServerSettings } from './ports/sql-store.js'

/** Public identity of a content-addressed branding object. */
export const serverAssetInfo = (record: ServerAssetRecord): ServerAsset => ({
  etag: record.blobKey.slice(record.blobKey.lastIndexOf('/') + 1),
  contentType: record.contentType,
})

/** Apply operator settings without dropping transport capabilities configured at deploy time. */
export const mergeServerInfo = (base: ServerInfo, settings: ServerSettings): ServerInfo => {
  const description = settings.description ?? base.description
  const resolved = {
    id: base.id,
    name: settings.name ?? base.name,
    auth: base.auth,
    ...(settings.discordInviteUrl === null ? {} : { discordInviteUrl: settings.discordInviteUrl }),
    ...(settings.homeCopy === null ? {} : { homeCopy: settings.homeCopy }),
    ...(settings.logoText === null ? {} : { logoText: settings.logoText }),
    ...(settings.logo === null ? {} : { logoImage: serverAssetInfo(settings.logo) }),
    ...(settings.preview === null ? {} : { previewImage: serverAssetInfo(settings.preview) }),
    ...(base.liveSync === undefined ? {} : { liveSync: base.liveSync }),
    ...(base.liveSyncMax === undefined ? {} : { liveSyncMax: base.liveSyncMax }),
    ...(base.liveTileOffers === undefined ? {} : { liveTileOffers: base.liveTileOffers }),
    ...(base.presence === undefined ? {} : { presence: base.presence }),
    ...(base.livePaintParts === undefined ? {} : { livePaintParts: base.livePaintParts }),
  }
  return description === undefined || description === null ? resolved : { ...resolved, description }
}
