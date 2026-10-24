import { PALETTE_SIZE, TRANSPARENT_INDEX } from '@caelestis/shared'
import { artboardGpuTilePlacement } from '../src/gl/artboard-layer.js'
import { linkTemplateProgram, writeClipCorner } from '../src/gl/renderer-core.js'
import { OUTLINE_FRAGMENT_SOURCE } from '../src/gl/shaders.js'
import { TemplateGpuStore } from '../src/gl/template-gpu-store.js'
import { cutPixels, PIXEL_CHUNK_SIZE, type SparsePixels } from '../src/templates/sparse-pixels.js'

const EDGE = 2 * PIXEL_CHUNK_SIZE
/** Device pixels per template cell, enough to resolve outline ownership within a cell. */
const SCALE = 8
/** The cells drawn around the shared chunk corner. */
const VIEW = 8
const CORNER = PIXEL_CHUNK_SIZE - VIEW / 2

/** Every chunk present, empty ones included: the dense rendering sparse chunks must match. */
const withEveryChunk = (pixels: SparsePixels): SparsePixels => {
  const chunks = new Map(pixels.chunks)
  for (const [key, x, y] of [
    [0, 0, 0],
    [1, PIXEL_CHUNK_SIZE, 0],
    [2, 0, PIXEL_CHUNK_SIZE],
    [3, PIXEL_CHUNK_SIZE, PIXEL_CHUNK_SIZE],
  ] as const) {
    if (chunks.has(key)) continue
    const indices = new Uint8Array(PIXEL_CHUNK_SIZE ** 2).fill(TRANSPARENT_INDEX)
    chunks.set(key, { x, y, width: PIXEL_CHUNK_SIZE, height: PIXEL_CHUNK_SIZE, indices })
  }
  return { ...pixels, chunks: new Map([...chunks].sort(([a], [b]) => a - b)) }
}

/** Render the outline pass around the chunk corner, as the artboard renderer draws it. */
const renderOutline = (pixels: SparsePixels): Uint8Array => {
  const canvas = document.createElement('canvas')
  canvas.width = VIEW * SCALE
  canvas.height = VIEW * SCALE
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true })
  if (gl === null) throw new Error('sparse outline contract needs WebGL2')
  const program = linkTemplateProgram(gl, OUTLINE_FRAGMENT_SOURCE)
  if (program === null) throw new Error('the outline shader did not link')
  const store = new TemplateGpuStore(gl)
  const { entry } = store.advance(
    { id: 'outline', width: EDGE, height: EDGE, artwork: { pixels } },
    Number.MAX_SAFE_INTEGER,
    0,
  )
  if (entry === null) throw new Error('the outline template did not upload')
  const palette = new Uint8Array(PALETTE_SIZE * 4).fill(255)
  palette[TRANSPARENT_INDEX * 4 + 3] = 0
  store.uploadPalette(entry, palette)

  gl.useProgram(program)
  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  const vertices = new Float32Array(24)
  gl.bufferData(gl.ARRAY_BUFFER, vertices.byteLength, gl.DYNAMIC_DRAW)
  const stride = 6 * Float32Array.BYTES_PER_ELEMENT
  const clip = gl.getAttribLocation(program, 'a_clip')
  const uv = gl.getAttribLocation(program, 'a_uv')
  gl.enableVertexAttribArray(clip)
  gl.vertexAttribPointer(clip, 4, gl.FLOAT, false, stride, 0)
  gl.enableVertexAttribArray(uv)
  gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, stride, 4 * Float32Array.BYTES_PER_ELEMENT)
  const uniform = (name: string) => gl.getUniformLocation(program, name)
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, entry.palette)
  gl.uniform1i(uniform('u_palette'), 1)
  gl.uniform1i(uniform('u_darkTheme'), 0)
  gl.uniform1f(uniform('u_outlineWidth'), 0.25)
  gl.uniform1f(uniform('u_stampSize'), 1)
  gl.uniform1f(uniform('u_stampRadius'), 0)
  gl.uniform2f(uniform('u_stampOffset'), 0, 0)
  gl.uniform1f(uniform('u_stampRotation'), 0)
  gl.uniform1f(uniform('u_fade'), 1)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.viewport(0, 0, canvas.width, canvas.height)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)

  const geometry = { originX: 0, originY: 0, width: EDGE, height: EDGE }
  const viewport = {
    bufferWidth: canvas.width,
    bufferHeight: canvas.height,
    frameLeft: -CORNER * SCALE,
    frameTop: -CORNER * SCALE,
    frameWidth: EDGE * SCALE,
    frameHeight: EDGE * SCALE,
  }
  for (const source of entry.indices) {
    const { box, u0, v0, u1, v1 } = artboardGpuTilePlacement(
      geometry,
      source,
      geometry,
      viewport,
      1,
    )
    const { width, height } = canvas
    writeClipCorner(box.left, box.top, width, height, u0, v0, vertices, 0)
    writeClipCorner(box.right, box.top, width, height, u1, v0, vertices, 6)
    writeClipCorner(box.left, box.bottom, width, height, u0, v1, vertices, 12)
    writeClipCorner(box.right, box.bottom, width, height, u1, v1, vertices, 18)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, source.texture)
    gl.uniform1i(uniform('u_indices'), 0)
    gl.uniform2f(uniform('u_size'), source.textureWidth, source.textureHeight)
    gl.uniform4iv(uniform('u_diagonals'), source.diagonals.map(Number))
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }
  const out = new Uint8Array(canvas.width * canvas.height * 4)
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, out)
  store.dispose()
  return out
}

/**
 * Outlines around a chunk corner where some chunks are left out for being empty must draw exactly
 * as if every chunk were there: nothing missing, nothing blended twice.
 */
export const runSparseOutlineContracts = (): void => {
  const P = PIXEL_CHUNK_SIZE
  const cases: Record<string, readonly (readonly [number, number])[]> = {
    // Only the NW and SE chunks: both strips reach the cells between them.
    'diagonal, touching': [
      [P - 1, P - 1],
      [P, P],
    ],
    // A cell one strip leaves to the other still outlines pixels a cell beyond the corner.
    'diagonal, one cell in': [
      [P - 2, P - 1],
      [P - 1, P - 2],
      [P, P + 1],
      [P + 1, P],
    ],
    // Every chunk but SE: NE's bottom strip and SW's side strip meet in its corner.
    'missing corner': [
      [P - 1, P - 1],
      [P, P - 1],
      [P - 1, P],
      [P + 1, P - 2],
      [P - 2, P + 1],
    ],
  }
  for (const [name, painted] of Object.entries(cases)) {
    const dense = new Uint8Array(EDGE * EDGE).fill(TRANSPARENT_INDEX)
    for (const [x, y] of painted) dense[y * EDGE + x] = 1
    const sparse = cutPixels(EDGE, EDGE, dense)
    const actual = renderOutline(sparse)
    const expected = renderOutline(withEveryChunk(sparse))
    let worst = 0
    for (let at = 0; at < actual.length; at++)
      worst = Math.max(worst, Math.abs((actual[at] ?? 0) - (expected[at] ?? 0)))
    if (!expected.some((value) => value > 0))
      throw new Error(`sparse outline contract (${name}) drew no outline to compare`)
    if (worst > 1)
      throw new Error(
        `sparse outline (${name}) differs from dense by ${worst}/255 at a chunk corner`,
      )
  }
}
