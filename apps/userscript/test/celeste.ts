import { readFile } from 'node:fs/promises'
import { encodeIndexedPng, sha256Hex } from '@caelestis/shared'
import { vi } from 'vitest'
import { type ImportedTemplate, importFile } from '../src/templates/import.js'
import { installBitmapDecoder } from './image-decoder.js'

const PROLOGUE =
  '../../fixtures/berrycamp/wplace-templates/quantized/rooms/prologue/a/__prologue-a.json'

export interface CelesteRoom {
  /** The Berrycamp prologue room as Caelestis imports it. */
  readonly room: ImportedTemplate
  /** That artwork as a source PNG, as an author would bring it to the editor. */
  readonly png: Uint8Array<ArrayBuffer>
  readonly sha256: string
}

let imported: Promise<CelesteRoom> | null = null

/**
 * The Berrycamp prologue room, with the shared PNG decoder standing in for the browser's. The room
 * is decoded once per file; the decoder is installed for every test.
 */
export const celesteRoom = (): Promise<CelesteRoom> => {
  installBitmapDecoder()
  imported ??= importRoom()
  return imported
}

const importRoom = async (): Promise<CelesteRoom> => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input)
    if (!url.startsWith('data:image/png;base64,')) throw new Error(`unexpected request: ${url}`)
    return new Response(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
  })
  const file = new File([await readFile(PROLOGUE)], 'prologue.json', { type: 'application/json' })
  const [room] = await importFile(file, { x: 0, y: 0 })
  if (room === undefined) throw new Error('the Celeste fixture did not import')
  const png = Uint8Array.from(await encodeIndexedPng(room.width, room.height, room.indices))
  return { room, png, sha256: await sha256Hex(png) }
}
