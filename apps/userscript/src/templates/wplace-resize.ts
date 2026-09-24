const PIXELS_PER_YIELD = 250_000

/** Match Wplace's top-left, floor-based nearest-neighbor sampling on preflighted dimensions. */
export const resizeWplaceImage = async (
  source: ImageData,
  width: number,
  height: number,
): Promise<ImageData> => {
  if (source.width === width && source.height === height) return source
  const output = new ImageData(width, height)
  const inputPixels = new Uint32Array(
    source.data.buffer,
    source.data.byteOffset,
    source.data.byteLength / 4,
  )
  const outputPixels = new Uint32Array(output.data.buffer)
  const columns = Uint32Array.from({ length: width }, (_, x) =>
    Math.floor((x * source.width) / width),
  )
  let work = 0
  for (let y = 0; y < height; y++) {
    const sourceRow = Math.floor((y * source.height) / height) * source.width
    for (let x = 0; x < width; x++) {
      outputPixels[y * width + x] = inputPixels[sourceRow + (columns[x] ?? 0)] ?? 0
    }
    work += width
    if (work >= PIXELS_PER_YIELD && y + 1 < height) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      work = 0
    }
  }
  return output
}
