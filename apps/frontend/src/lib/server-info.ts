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

const PRODUCT = 'Caelestis'

/** A document title: the page, then the server, then the product unless the server is it. */
export const pageTitle = (serverName: string | undefined, page?: string): string => {
  const site = serverName ?? PRODUCT
  if (page !== undefined) return `${page} · ${site}`
  return site === PRODUCT ? site : `${site} · ${PRODUCT}`
}
