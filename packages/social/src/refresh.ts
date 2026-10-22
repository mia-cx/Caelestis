import type { CanvasTilesResponse, Manifest, Template } from '@caelestis/shared'
import type { ReadMapTile } from './basemap.js'
import { socialImageKey } from './image.js'
import { renderTemplateHistory } from './render.js'

/** Read one backend API path relative to `/v1/`, rejecting any non-OK response. */
export type ReadApi = (path: string) => Promise<Response>

/** Read a backend over HTTP. `api` is its `/v1/` URL with the trailing slash. */
export const httpApi =
  (api: URL, readToken?: string): ReadApi =>
  async (path) => {
    const response = await fetch(new URL(path, api), {
      signal: AbortSignal.timeout(60_000),
      ...(readToken ? { headers: { authorization: `Bearer ${readToken}` } } : {}),
    })
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
    return response
  }

/**
 * Render the history GIF of every published template, or only `templateId`, and hand each to
 * `save`. A failed template keeps its previous image while the rest finish; the call then rejects.
 */
export const refreshSocialImages = async ({
  read,
  readMapTile,
  templateId,
  save,
}: {
  read: ReadApi
  readMapTile?: ReadMapTile
  templateId?: string
  save: (key: string, gif: Uint8Array, template: Template) => Promise<void>
}) => {
  const manifest: Manifest = await (await read('manifest')).json()
  const { tiles }: CanvasTilesResponse = await (
    await read(`telemetry/canvas?season=${manifest.season}`)
  ).json()
  const canvas = new Map<string, string>(tiles.map((tile) => [tile.tile, tile.hash]))
  const failures: string[] = []
  for (const template of manifest.templates) {
    if (!template.published || (templateId !== undefined && template.id !== templateId)) continue
    try {
      const gif = await renderTemplateHistory(template, manifest.season, canvas, read, readMapTile)
      if (gif === null) {
        console.log(`${template.id}: no snapshots yet`)
        continue
      }
      await save(socialImageKey(manifest.season, template), gif, template)
    } catch (error) {
      console.error(`${template.id}:`, error)
      failures.push(template.id)
    }
  }
  if (failures.length > 0) throw new Error(`Preview generation failed for ${failures.join(', ')}`)
}
