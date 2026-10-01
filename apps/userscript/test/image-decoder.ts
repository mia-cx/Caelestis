import { decodePng } from '@caelestis/shared'
import { vi } from 'vitest'

interface DecodedBitmap {
  readonly width: number
  readonly height: number
  readonly pixels: Uint8Array
  close(): void
}

/**
 * Stand in for the browser's PNG decoder with the shared one. Returns the `createImageBitmap`
 * spy, so a test can tell whether anything decoded, and therefore processed, an image.
 */
export const installBitmapDecoder = () => {
  const decode = vi.fn(async (blob: Blob): Promise<DecodedBitmap> => {
    const image = await decodePng(new Uint8Array(await blob.arrayBuffer()))
    return { ...image, close: () => {} }
  })
  vi.stubGlobal('createImageBitmap', decode)

  class TestOffscreenCanvas {
    #bitmap: DecodedBitmap | null = null

    constructor(
      readonly width: number,
      readonly height: number,
    ) {}

    getContext(): {
      drawImage: (image: DecodedBitmap) => void
      getImageData: () => ImageData
    } {
      return {
        drawImage: (image) => {
          this.#bitmap = image
        },
        getImageData: () => {
          if (this.#bitmap === null) throw new Error('image decoder did not draw a bitmap')
          return { data: new Uint8ClampedArray(this.#bitmap.pixels) } as ImageData
        },
      }
    }
  }

  vi.stubGlobal('OffscreenCanvas', TestOffscreenCanvas)
  return decode
}
