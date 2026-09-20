import { applyPalette, GIFEncoder, quantize } from 'gifenc/dist/gifenc.esm.js'

export const HISTORY_PLAYBACK_SECONDS = 10
const GIF_TICK_MS = 10
const MIN_FRAME_DELAY_MS = 20
const LIVE_PAUSE_MS = 5000
const MAX_GIF_BYTES = 4_500_000

function encodeFrames(
  frames: readonly Uint8Array[],
  width: number,
  height: number,
  times: readonly number[],
) {
  const gif = GIFEncoder()
  const historyFrames = frames.length - 1
  const historyTicks = (HISTORY_PLAYBACK_SECONDS * 1000) / GIF_TICK_MS
  const start = times[0]
  const span = times[historyFrames] - start
  const tickAt = (index: number) => Math.ceil(((times[index] - start) * historyTicks) / span)
  let previous: Uint8Array | undefined
  let initialDelay = 0
  let pending:
    | {
        indices: Uint8Array
        width: number
        height: number
        palette?: number[][]
        delay: number
        transparent: boolean
        transparentIndex: number
      }
    | undefined
  const flush = () => {
    if (!pending) return
    gif.writeFrame(pending.indices, pending.width, pending.height, {
      ...pending,
      repeat: 0,
      // Transparent pixels retain the previous canvas, including its map and attribution.
      dispose: 1,
    })
  }
  for (const [index, frame] of frames.entries()) {
    const final = index === historyFrames
    const delay =
      (final ? LIVE_PAUSE_MS : (tickAt(index + 1) - tickAt(index)) * GIF_TICK_MS) + initialDelay
    initialDelay = 0
    // Players stretch 0–10 ms frames to a default pause. Hold the previous image through
    // these short observations while retaining their time in the ten-second total.
    if (!final && delay < MIN_FRAME_DELAY_MS) {
      if (pending) pending.delay += delay
      else initialDelay = delay
      continue
    }
    const changed = new Uint8Array(width * height)
    let hasChanges = !previous
    if (previous) {
      for (let pixel = 0; pixel < changed.length; pixel++) {
        const offset = pixel * 4
        if (
          frame[offset] === previous[offset] &&
          frame[offset + 1] === previous[offset + 1] &&
          frame[offset + 2] === previous[offset + 2]
        )
          continue
        changed[pixel] = 1
        hasChanges = true
      }
    }
    if (!hasChanges && pending && !final) {
      pending.delay += delay
      continue
    }
    flush()
    if (!hasChanges) {
      // Keep the final hold explicit without encoding another full, identical canvas.
      pending = {
        indices: new Uint8Array(1),
        width: 1,
        height: 1,
        delay,
        transparent: true,
        transparentIndex: 0,
      }
    } else {
      // gifenc reads the whole backing buffer, ignoring a view's offset and length.
      const rgba =
        frame.byteOffset === 0 && frame.byteLength === frame.buffer.byteLength
          ? frame
          : new Uint8Array(frame)
      const palette = quantize(rgba, 128)
      const indices = applyPalette(rgba, palette)
      const transparentIndex = palette.length
      if (previous) {
        for (let pixel = 0; pixel < indices.length; pixel++) {
          if (!changed[pixel]) indices[pixel] = transparentIndex
        }
        // Reserve transparency after quantization so all 128 artwork colors remain available.
        palette.push([0, 0, 0])
      }
      pending = {
        indices,
        width,
        height,
        palette,
        delay,
        transparent: !!previous,
        transparentIndex,
      }
    }
    previous = frame
  }
  flush()
  gif.finish()
  return gif.bytes()
}

/** Encode ten seconds of recorded history and a five-second live hold. Times include the live boundary. */
export function encodeTimelapseGif(
  frames: readonly Uint8Array[],
  width: number,
  height: number,
  times: readonly number[] = frames.map((_, index) => index),
): Uint8Array {
  let selected = frames
  let selectedTimes = times
  while (true) {
    const bytes = encodeFrames(selected, width, height, selectedTimes)
    if (bytes.length <= MAX_GIF_BYTES) return bytes
    if (selected.length <= 3) throw new Error('Timelapse exceeds the share image size limit')
    selected = [...selected.slice(0, -2).filter((_, i) => i % 2 === 0), ...selected.slice(-2)]
    selectedTimes = [
      ...selectedTimes.slice(0, -2).filter((_, i) => i % 2 === 0),
      ...selectedTimes.slice(-2),
    ]
  }
}
