import type { ServerAsset, ServerInfo } from '@caelestis/shared'
import { LIVE_CAPABILITIES } from '../live/session.js'
import type { ServerConfig } from './config.js'
import type { ServerAssetRecord, ServerSettings } from './store.js'

/** The protocols only an event server (`EVENT_SERVER=true`) serves, as `/server` advertises them. */
export const EVENT_CAPABILITIES = { capture: 1 } as const satisfies Partial<ServerInfo>

/** What `/server` and every manifest say about this deployment before operator settings apply. */
export const serverInfo = (
  config: Pick<
    ServerConfig,
    'serverName' | 'serverDescription' | 'openAccess' | 'eventServer' | 'version' | 'build'
  >,
  id: string,
): ServerInfo => ({
  id,
  name: config.serverName,
  ...(config.serverDescription === undefined ? {} : { description: config.serverDescription }),
  auth: config.openAccess ? 'none' : 'access_token',
  ...(config.version === undefined ? {} : { version: config.version }),
  build: config.build,
  ...LIVE_CAPABILITIES,
  ...(config.eventServer ? EVENT_CAPABILITIES : {}),
})

/** Public identity of a content-addressed branding object. */
export const serverAssetInfo = (record: ServerAssetRecord): ServerAsset => ({
  etag: record.blobKey.slice(record.blobKey.lastIndexOf('/') + 1),
  contentType: record.contentType,
})

/** Apply operator settings over the deployment's identity; every deployed field survives. */
export const mergeServerInfo = (base: ServerInfo, settings: ServerSettings): ServerInfo => {
  const description = settings.description ?? base.description
  return {
    ...base,
    name: settings.name ?? base.name,
    ...(description === undefined || description === null ? {} : { description }),
    ...(settings.discordInviteUrl === null ? {} : { discordInviteUrl: settings.discordInviteUrl }),
    ...(settings.homeCopy === null ? {} : { homeCopy: settings.homeCopy }),
    ...(settings.logoText === null ? {} : { logoText: settings.logoText }),
    ...(settings.logo === null ? {} : { logoImage: serverAssetInfo(settings.logo) }),
    ...(settings.preview === null ? {} : { previewImage: serverAssetInfo(settings.preview) }),
  }
}
