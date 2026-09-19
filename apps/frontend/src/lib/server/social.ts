import type { Manifest, ServerInfo, Template, TemplateStatus } from '@caelestis/shared'
import { serverAssetPath } from '@caelestis/shared'
import type { ObjectInfo, ObjectStorage } from '@caelestis/storage'
import {
  DEFAULT_SOCIAL_IMAGE,
  SOCIAL_IMAGE_HEIGHT,
  SOCIAL_IMAGE_WIDTH,
  socialImageKey,
} from '$lib/social-image.js'

interface SocialContext {
  server: ServerInfo | null
  manifest: Manifest | null
  statuses: readonly TemplateStatus[]
}

export const DEFAULT_SOCIAL_DESCRIPTION =
  'Follow Wplace pixel art, track template progress, and watch timelapses on Caelestis.'

export interface SocialImage {
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
    image: new URL(`/api/v1${serverAssetPath('preview', server.previewImage)}`, url.origin).href,
    imageType: server.previewImage.contentType,
    // Dimensions are not known without decoding the upload. Crawlers accept their absence.
    imageWidth: null,
    imageHeight: null,
    imageAlt: server.name,
  }
}

/** Build public, crawler-readable metadata without depending on browser credentials or state. */
export const socialMetadata = async (
  url: URL,
  context: SocialContext,
  images?: Pick<ObjectStorage, 'head'>,
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
    title: siteName === 'Caelestis' ? siteName : `${siteName} · Caelestis`,
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
      metadata.title = `${folder.name} · ${siteName}`
      metadata.description =
        folder.description || `Follow the Wplace templates and painting progress in ${folder.name}.`
    }
  }
  if (kind !== 'template') return metadata
  const template = manifest?.templates.find((entry) => entry.id === id && entry.published)
  if (template === undefined || manifest === null) return metadata
  metadata.title = `${template.name} · ${siteName}`
  const status = statuses.find((entry) => entry.templateId === template.id)
  const progress =
    status === undefined || status.total === 0
      ? ''
      : ` ${Math.round((status.correct / status.total) * 100)}% painted correctly.`
  metadata.description = `${template.totalPixels.toLocaleString('en-US')} pixels on Wplace.${progress} Watch the timelapse and follow its progress.`
  const image = ensureImage
    ? await ensureImage(template)
    : await images?.head(socialImageKey(manifest.season, template))
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
