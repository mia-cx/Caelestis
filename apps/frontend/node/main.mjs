import { nodeObjectStorage } from '@caelestis/storage/node'
import { createFrontendServer, ORIGIN_PROTOCOL_HEADER } from './server.mjs'

const origin = process.env.ORIGIN ? new URL(process.env.ORIGIN) : undefined
// The handler reads PROTOCOL_HEADER when it loads, so set it before importing.
if (origin !== undefined) process.env.PROTOCOL_HEADER = ORIGIN_PROTOCOL_HEADER
const { handler } = await import('../build/handler.js')

const objects = nodeObjectStorage(process.env)
const { server, close } = createFrontendServer(handler, {
  backend: process.env.CAELESTIS_SERVER ?? 'http://backend:3000/backend',
  readToken: process.env.CAELESTIS_READ_TOKEN,
  objects,
  origin,
})
const port = Number(process.env.PORT ?? 3000)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT')
server.listen(port, process.env.HOST ?? '0.0.0.0')
let stopping = false
const shutdown = async () => {
  if (stopping) return
  stopping = true
  try {
    await close()
  } finally {
    objects.close?.()
  }
}
process.once('SIGTERM', () => {
  void shutdown()
})
process.once('SIGINT', () => {
  void shutdown()
})
