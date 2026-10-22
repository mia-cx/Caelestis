import { workerData } from 'node:worker_threads'
import { httpApi, refreshSocialImages, storedMapTiles } from '@caelestis/social'
import { nodeObjectStorage } from '@caelestis/storage/node'
import { S3ObjectStorage } from '@caelestis/storage/s3'

const storage = nodeObjectStorage(process.env)
const { api, readToken }: { api: string; readToken: string } = workerData
try {
  await refreshSocialImages({
    read: httpApi(new URL(api), readToken),
    readMapTile: storedMapTiles(storage),
    save: async (key, gif, template) => {
      await storage.put(key, gif, { contentType: 'image/gif' })
      console.log(`${template.id}: ${gif.length} bytes, published`)
    },
  })
} finally {
  if (storage instanceof S3ObjectStorage) storage.close()
}
