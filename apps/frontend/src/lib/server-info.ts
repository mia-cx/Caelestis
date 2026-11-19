import { parseServerPresentation, type ServerInfo } from '@caelestis/shared'

/** A user-selectable server's `/server` answer with only the presentation a page may act on. */
export const sanitizeServerInfo = ({
  discordInviteUrl,
  homeCopy,
  logoText,
  logoImage,
  previewImage,
  ...server
}: ServerInfo): ServerInfo => ({
  ...server,
  ...parseServerPresentation({ discordInviteUrl, homeCopy, logoText, logoImage, previewImage }),
})
