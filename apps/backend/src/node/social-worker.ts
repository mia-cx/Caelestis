import { workerData } from 'node:worker_threads'
import { httpApi } from '@caelestis/social'
import { closeObjectStorage, nodeObjectStorage } from '@caelestis/storage/node'
import { publishSocialImages } from '../server/social.js'

const storage = nodeObjectStorage(process.env)
const { api, readToken }: { api: string; readToken: string } = workerData
try {
  await publishSocialImages(httpApi(new URL(api), readToken), storage)
} finally {
  closeObjectStorage(storage)
}
