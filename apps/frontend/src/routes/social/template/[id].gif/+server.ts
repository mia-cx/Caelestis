import type { Manifest } from '@caelestis/shared'
import { DEFAULT_SOCIAL_IMAGE, socialImageKey } from '@caelestis/social'
import type { ObjectInfo } from '@caelestis/storage'
import { readBackendJson } from '#lib/server/backend.js'
import { ensureSocialImage } from '#lib/server/social-images.js'
import type { RequestHandler } from './$types'

const headersFor = (image: ObjectInfo) => ({
  'content-type': 'image/gif',
  'content-length': String(image.size),
  etag: `"${image.etag}"`,
  // Crawlers cache their own copies. Revalidate ours so publication changes take effect.
  'cache-control': 'public, no-cache',
  'x-content-type-options': 'nosniff',
})

const serve: RequestHandler = async (event) => {
  try {
    // Check publication on every request, including old links after deletion or unpublication.
    const manifest = await readBackendJson<Manifest>(event, '/v1/manifest')
    const template = manifest.templates.find(
      (entry) => entry.id === event.params.id && entry.published,
    )
    if (template === undefined) return new Response(null, { status: 404 })
    const fallback = () =>
      new Response(null, {
        status: 302,
        headers: { location: DEFAULT_SOCIAL_IMAGE, 'cache-control': 'no-store' },
      })
    const images = event.locals.objectStorage
    const image = await ensureSocialImage(event, manifest.season, template)
    if (images === undefined || image === null) return fallback()
    // Revalidation and HEAD need only the stored metadata; read the bytes only to send them.
    const headers = headersFor(image)
    const candidates = (event.request.headers.get('if-none-match') ?? '')
      .split(',')
      .map((candidate) => candidate.trim().replace(/^W\//, ''))
    if (candidates.includes(headers.etag) || candidates.includes('*')) {
      return new Response(null, { status: 304, headers })
    }
    if (event.request.method === 'HEAD') return new Response(null, { headers })
    const object = await images.get(socialImageKey(manifest.season, template))
    if (object === null) return fallback()
    // The scheduled render may have replaced the image since its metadata was read. Every storage
    // adapter returns ArrayBuffer-backed bytes, and a Response sends exactly the view: no copy.
    return new Response(object.bytes as Uint8Array<ArrayBuffer>, { headers: headersFor(object) })
  } catch (error) {
    console.error('social image read failed', error)
    return new Response(null, { status: 503, headers: { 'retry-after': '60' } })
  }
}

export const GET = serve
export const HEAD = serve
