import { deviceScale, MarkerRenderer } from '../src/gl/marker-renderer.js'
import { MarkList } from '../src/templates/mark-list.js'
import { packMismatchMark } from '../src/templates/mismatch-marks.js'

/** Cells across the drawn tile, and device pixels per cell. */
const CELLS = 8
const SCALE = 8

/**
 * A patched marker list draws exactly its live marks in real WebGL2.
 *
 * Removing a mark leaves its slot in the GPU copy flagged dead, which only the vertex shader can
 * hide, and a patch reaches the GPU as a partial upload. Reading the frame back is the one check
 * that both happened.
 */
export const runMarkerPatchingContracts = (): void => {
  const canvas = document.createElement('canvas')
  canvas.width = CELLS * SCALE
  canvas.height = CELLS * SCALE
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true })
  if (gl === null) throw new Error('marker patching contract needs WebGL2')
  const renderer = new MarkerRenderer(gl)
  const cell = SCALE / deviceScale(gl)
  const style = {
    size: cell,
    thickness: cell,
    colour: [1, 0, 1] as const,
    otherColour: null,
    otherOpacity: 1,
    selected: -1,
  }
  const projection = {
    x: 0,
    y: 0,
    width: canvas.width,
    height: canvas.height,
    pixelWidth: CELLS,
    pixelHeight: CELLS,
    seedX: 0,
    seedY: 0,
  }
  /** Cells the frame painted, as `x,y`. */
  const drawn = (lists: readonly MarkList[], sampleRate = 1): string[] => {
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    renderer.beginFrame()
    renderer.draw(projection, lists, style, 1, sampleRate)
    renderer.endFrame()
    const rgba = new Uint8Array(canvas.width * canvas.height * 4)
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, rgba)
    const cells: string[] = []
    for (let y = 0; y < CELLS; y++) {
      for (let x = 0; x < CELLS; x++) {
        const row = canvas.height - 1 - (y * SCALE + SCALE / 2)
        const at = (row * canvas.width + x * SCALE + SCALE / 2) * 4
        if ((rgba[at + 3] as number) > 0) cells.push(`${x},${y}`)
      }
    }
    return cells
  }
  const expectDrawn = (step: string, lists: readonly MarkList[], expected: string[]) => {
    const actual = drawn(lists)
    if (actual.join(' ') !== expected.join(' '))
      throw new Error(
        `marker patching ${step}: drew ${actual.join(' ')}, wanted ${expected.join(' ')}`,
      )
  }

  const list = MarkList.of(
    Uint32Array.of(packMismatchMark(1, 1, 3), packMismatchMark(3, 1, 3), packMismatchMark(5, 5, 4)),
  )
  const other = MarkList.of(Uint32Array.of(packMismatchMark(2, 6, 2)))
  try {
    expectDrawn('as scanned', [list, other], ['1,1', '3,1', '5,5', '2,6'])
    list.remove(3 | (1 << 10))
    expectDrawn('after a fix', [list, other], ['1,1', '5,5', '2,6'])
    list.add(packMismatchMark(3, 1, 3))
    list.add(packMismatchMark(6, 2, 5))
    expectDrawn('after an undo and a new mark', [list, other], ['1,1', '3,1', '6,2', '5,5', '2,6'])
    for (const [x, y] of [
      [1, 1],
      [3, 1],
      [5, 5],
    ] as const)
      list.remove(x | (y << 10))
    expectDrawn('after fixing every scanned mark', [list, other], ['6,2', '2,6'])

    // Sampling submits a prefix of a fixed shuffle: the whole shuffle reaches every slot once, and
    // a higher rate only adds marks to a lower one's.
    const full = MarkList.of(
      Uint32Array.from({ length: CELLS * CELLS }, (_, at) =>
        packMismatchMark(at % CELLS, Math.floor(at / CELLS), 1),
      ),
    )
    const every = drawn([full])
    if (every.length !== CELLS * CELLS)
      throw new Error('marker sampling: unsampled list incomplete')
    const shuffled = drawn([full], 0.999)
    if (shuffled.join(' ') !== every.join(' '))
      throw new Error(
        `marker sampling: the whole shuffle drew ${shuffled.length} of ${every.length}`,
      )
    const quarter = drawn([full], 0.25)
    const half = drawn([full], 0.5)
    if (quarter.some((cell) => !half.includes(cell)))
      throw new Error('marker sampling: a higher rate dropped a mark a lower rate drew')
    if (quarter.length < 4 || quarter.length > 28 || half.length < 16 || half.length > 48)
      throw new Error(`marker sampling: drew ${quarter.length} and ${half.length} of 64`)
  } finally {
    renderer.dispose()
  }
}
