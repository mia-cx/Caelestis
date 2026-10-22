import type { Template } from '@caelestis/shared'
import { renderTimelapse, socialImageKey, storedMapTiles } from '@caelestis/social'
import type { RequestEvent } from '@sveltejs/kit'
import { fetchBackend } from './backend.js'

type ImageEvent = Pick<RequestEvent, 'fetch' | 'locals' | 'url'>

/** Persist a first artwork GIF; the scheduled job replaces it with rendered history. */
export const ensureSocialImage = async (event: ImageEvent, season: number, template: Template) => {
  const images = event.locals.objectStorage
  if (images === undefined) return null
  const key = socialImageKey(season, template)
  const read = async (path: string) => {
    const response = await fetchBackend(event, `/v1/${path}`, {
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
    return response
  }
  let image = await images.head(key)
  if (image === null) {
    const poster = await renderTimelapse({
      template: { ...template, finished: false },
      histories: new Map(),
      artwork: true,
      readMapTile: storedMapTiles(images),
      canvas: new Map(template.chunks.map((chunk) => [chunk.tile, chunk.hash])),
      readTile: async (hash) => new Uint8Array(await (await read(`chunks/${hash}`)).arrayBuffer()),
    })
    if (poster === null) throw new Error(`Template ${template.id} has no artwork for its first GIF`)
    // A concurrent renderer may have already stored a full timelapse. Never overwrite it with a poster.
    image =
      (await images.put(key, poster, {
        ifAbsent: true,
        contentType: 'image/gif',
        metadata: { version: template.version },
      })) ?? (await images.head(key))
  }
  if (image === null) throw new Error(`Could not persist preview for ${template.id}`)
  return image
}
