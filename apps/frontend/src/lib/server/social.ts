import type { Manifest, ServerInfo, Template, TemplateStatus } from '@caelestis/shared'
import { API_VERSION_PATH, progressFromStatus, serverAssetPath } from '@caelestis/shared'
import { DEFAULT_SOCIAL_IMAGE, SOCIAL_IMAGE_HEIGHT, SOCIAL_IMAGE_WIDTH } from '@caelestis/social'
import type { ObjectInfo } from '@caelestis/storage'
import { READ_PROXY } from '#lib/deployment.js'
import { pageTitle } from '#lib/server-info.js'
import { discordComponentEmbed } from './discord-embed.js'

interface SocialContext {
  server: ServerInfo | null
  manifest: Manifest | null
  statuses: readonly TemplateStatus[]
}

const DEFAULT_SOCIAL_DESCRIPTION =
  'Follow Wplace pixel art, track template progress, and watch timelapses on Caelestis.'

interface SocialImage {
  image: string
  imageType: string
  imageWidth: number | null
  imageHeight: number | null
  imageAlt: string
}

/**
 * The preview an operator uploaded, addressed through the frontend's read proxy so a crawler never
 * needs the backend origin. Absent when they have not uploaded one.
 */
const configuredPreview = (url: URL, server: ServerInfo | null): SocialImage | null => {
  if (server?.previewImage === undefined) return null
  return {
    image: new URL(
      `${READ_PROXY}${API_VERSION_PATH}${serverAssetPath('preview', server.previewImage)}`,
      url.origin,
    ).href,
    imageType: server.previewImage.contentType,
    // Dimensions are not known without decoding the upload. Crawlers accept their absence.
    imageWidth: null,
    imageHeight: null,
    imageAlt: server.name,
  }
}

/**
 * Build public, crawler-readable metadata without depending on browser credentials or state,
 * plus the Discord component embed derived from it.
 */
export const socialMetadata = async (
  url: URL,
  context: SocialContext,
  ensureImage?: (template: Template) => Promise<ObjectInfo | null>,
) => {
  const metadata = await pageMetadata(url, context, ensureImage)
  return {
    ...metadata,
    discordEmbed: discordComponentEmbed(metadata, context.server?.discordInviteUrl),
  }
}

const pageMetadata = async (
  url: URL,
  context: SocialContext,
  ensureImage?: (template: Template) => Promise<ObjectInfo | null>,
) => {
  const { server, manifest, statuses } = context
  const siteName = server?.name ?? 'Caelestis'
  const metadata: SocialImage & {
    title: string
    description: string
    siteName: string
    url: string
  } = {
    title: pageTitle(server?.name),
    description: server?.description ?? DEFAULT_SOCIAL_DESCRIPTION,
    siteName,
    url: new URL(url.pathname, url.origin).href,
    ...(configuredPreview(url, server) ?? {
      image: new URL(DEFAULT_SOCIAL_IMAGE, url.origin).href,
      imageType: 'image/png',
      imageWidth: 1200,
      imageHeight: 630,
      imageAlt: 'Caelestis · Wplace templates, progress and timelapses',
    }),
  }
  const [kind, encodedId] = url.pathname.split('/').filter(Boolean)
  let id: string | undefined
  try {
    id = encodedId === undefined ? undefined : decodeURIComponent(encodedId)
  } catch {
    return metadata
  }
  if (kind === 'folder') {
    const folder = manifest?.nodes.find((node) => node.id === id)
    if (folder !== undefined) {
      metadata.title = pageTitle(server?.name, folder.name)
      metadata.description =
        folder.description || `Follow the Wplace templates and painting progress in ${folder.name}.`
    }
  }
  if (kind !== 'artwork') return metadata
  const template = manifest?.templates.find((entry) => entry.id === id && entry.published)
  if (template === undefined) return metadata
  metadata.title = pageTitle(server?.name, template.name)
  const progress = progressFromStatus(
    template.totalPixels,
    statuses.find((entry) => entry.templateId === template.id),
  )
  const painted =
    progress === undefined || progress.total === 0
      ? ''
      : ` ${Math.round((progress.completed / progress.total) * 100)}% painted correctly.`
  metadata.description = `${template.totalPixels.toLocaleString('en-US')} pixels on Wplace.${painted} Watch the timelapse and follow its progress.`
  const image = await ensureImage?.(template)
  if (image != null) {
    const imageUrl = new URL(`/social/template/${encodeURIComponent(template.id)}.gif`, url.origin)
    imageUrl.searchParams.set('v', image.etag)
    return {
      ...metadata,
      image: imageUrl.href,
      imageType: 'image/gif',
      imageWidth: SOCIAL_IMAGE_WIDTH,
      imageHeight: SOCIAL_IMAGE_HEIGHT,
      imageAlt: `Painting timelapse of ${template.name} on Wplace`,
    }
  }
  return metadata
}
