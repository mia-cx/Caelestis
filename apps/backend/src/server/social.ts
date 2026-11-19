import { type ReadApi, refreshSocialImages, storedMapTiles } from '@caelestis/social'
import type { ObjectStorage } from '@caelestis/storage'

/** Render and store each published template's share GIF, or only `templateId`'s. */
export const publishSocialImages = (read: ReadApi, storage: ObjectStorage, templateId?: string) =>
  refreshSocialImages({
    read,
    readMapTile: storedMapTiles(storage),
    ...(templateId === undefined ? {} : { templateId }),
    save: async (key, gif, template) => {
      await storage.put(key, gif, { contentType: 'image/gif' })
      console.log(`${template.id}: ${gif.length} bytes, published`)
    },
  })
