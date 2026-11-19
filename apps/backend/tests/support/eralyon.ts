import { zstdCompressSync } from 'node:zlib'
import { TILE_SIZE } from '@caelestis/shared'

/** An Eralyon week file: dated zstd images, the first a base and the rest sparse diffs. */
export const archiveWeek = (revisions: readonly (readonly [date: number, image: Uint8Array])[]) => {
  const parts = revisions.flatMap(([date, pixels]) => {
    const image = new Uint8Array(8 + TILE_SIZE * TILE_SIZE)
    const view = new DataView(image.buffer)
    view.setUint32(0, TILE_SIZE, true)
    view.setUint32(4, TILE_SIZE, true)
    image.set(pixels, 8)
    const compressed = new Uint8Array(zstdCompressSync(image))
    const header = new Uint8Array(8)
    new DataView(header.buffer).setUint32(0, date, true)
    new DataView(header.buffer).setUint32(4, compressed.length, true)
    return [header, compressed]
  })
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}
