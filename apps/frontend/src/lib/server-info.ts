import {
  logoText,
  parseDiscordInviteUrl,
  parseHomeCopy,
  parseServerAsset,
  type ServerInfo,
} from '@caelestis/shared'

/**
 * Keep only the branding a page may act on.
 *
 * A server is user-selectable, so its `/server` answer is untrusted input: the invite becomes an
 * `href`, the assets become URLs, the copy becomes markup. Each field is re-checked with the same
 * rules the backend applies, and anything that fails is dropped rather than rendered.
 */
export const sanitizeServerInfo = (server: ServerInfo): ServerInfo => {
  const discordInviteUrl = parseDiscordInviteUrl(server.discordInviteUrl)
  const homeCopy =
    typeof server.homeCopy === 'string' && parseHomeCopy(server.homeCopy).ok
      ? server.homeCopy
      : null
  const text = logoText(server.logoText)
  const logoImage = parseServerAsset(server.logoImage)
  const previewImage = parseServerAsset(server.previewImage)
  const {
    discordInviteUrl: _invite,
    homeCopy: _copy,
    logoText: _text,
    logoImage: _logo,
    previewImage: _preview,
    ...rest
  } = server
  return {
    ...rest,
    ...(discordInviteUrl === null ? {} : { discordInviteUrl }),
    ...(homeCopy === null ? {} : { homeCopy }),
    ...(text === null ? {} : { logoText: text }),
    ...(logoImage === null ? {} : { logoImage }),
    ...(previewImage === null ? {} : { previewImage }),
  }
}
