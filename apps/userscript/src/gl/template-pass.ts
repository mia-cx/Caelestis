import type { PixelRect } from '../geometry.js'
import { isPlain } from '../templates/appearance.js'
import type { PlacedTemplate } from '../templates/catalog.js'
import { isDarkMapTheme } from './contrast-outline.js'
import type { SceneTemplate } from './render-scene.js'
import { createQuadVertexArray, linkTemplateProgram, QUAD_FLOATS } from './renderer-core.js'
import { FRAGMENT_SOURCE, OUTLINE_FRAGMENT_SOURCE } from './shaders.js'
import type { TemplateGpuEntry, TemplateGpuStore, TemplateGpuTile } from './template-gpu-store.js'

/**
 * One way of drawing templates: the coloured overlay, or the contrast outline under Wplace's art.
 *
 * Both hosts draw templates the same way — the world map inside MapLibre's canvas, an alliance
 * artboard on canvases of its own — and differ only in where a template's cells land on screen.
 * A host supplies that as a `TemplatePlacement`; everything else lives here once.
 */

export type TemplatePassKind = 'outline' | 'overlay'

/** Where a host puts templates this frame, in device pixels of the buffer being drawn. */
export interface TemplatePlacement {
  /**
   * Whether any of the template, grown by `margin` cells, can show, so it is worth uploading and
   * drawing.
   */
  shows(template: PlacedTemplate, margin: number): boolean
  /** The parts of the template that can show, in template coordinates; they upload first. */
  visibleRects(template: PlacedTemplate): readonly PixelRect[]
  /**
   * Write one quad into `vertices` for each on-screen piece of each uploaded chunk, then call
   * `draw`. `margin` grows a chunk's open edges by up to that many cells: the outline's halo.
   */
  forEachQuad(
    template: PlacedTemplate,
    entry: TemplateGpuEntry,
    margin: number,
    vertices: Float32Array,
    draw: (source: TemplateGpuTile) => void,
  ): void
}

export interface TemplatePassFrame {
  readonly placement: TemplatePlacement
  readonly store: TemplateGpuStore
  /** Pixels this pass may upload this frame; null draws only what is already uploaded. */
  readonly uploadAllowance: number | null
  readonly generation: number
  readonly peekOpacity: number
  /** The overlay's minification tap budget; see `minify-quality.ts`. */
  readonly minifyTapCap: number
}

export interface TemplatePassResult {
  readonly drawIntersections: number
  readonly uploadedPixels: number
  /** Some template lacking its upload was advanced this frame, so it changed what draws next. */
  readonly uploaded: boolean
  /** Some template still has chunks left to upload. */
  readonly pending: boolean
}

/** The settled renderer samples a 4x4 grid per output fragment at far zoom. */
export const SETTLED_TAP_CAP = 4

/** The outline's halo, in cells: it may reach one cell past a chunk's open edges. */
const OUTLINE_MARGIN = 1

export class TemplatePass {
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>()
  private readonly vertices = new Float32Array(QUAD_FLOATS)

  /** How far past a chunk's open edges this pass draws: the outline's halo. */
  private readonly margin: number

  private constructor(
    readonly kind: TemplatePassKind,
    private readonly gl: WebGL2RenderingContext,
    private readonly program: WebGLProgram,
    private readonly buffer: WebGLBuffer,
    private readonly vao: WebGLVertexArrayObject,
  ) {
    this.margin = kind === 'outline' ? OUTLINE_MARGIN : 0
  }

  static create(gl: WebGL2RenderingContext, kind: TemplatePassKind): TemplatePass | null {
    const program = linkTemplateProgram(
      gl,
      kind === 'outline' ? OUTLINE_FRAGMENT_SOURCE : FRAGMENT_SOURCE,
    )
    if (program === null) return null
    const quad = createQuadVertexArray(gl, program)
    if (quad === null) {
      gl.deleteProgram(program)
      return null
    }
    return new TemplatePass(kind, gl, program, quad.buffer, quad.vao)
  }

  /** The vertex buffer's size; the textures are the store's. */
  memoryBytes(): number {
    return this.vertices.byteLength
  }

  private uniform(name: string): WebGLUniformLocation | null {
    if (!this.uniforms.has(name)) {
      this.uniforms.set(name, this.gl.getUniformLocation(this.program, name))
    }
    return this.uniforms.get(name) ?? null
  }

  /** The templates this pass draws this frame: fading in or shown, and on screen. */
  visible(templates: readonly SceneTemplate[], placement: TemplatePlacement): SceneTemplate[] {
    return templates.filter(
      ({ template, fade, outlineFade, palette }) =>
        fade > 0 &&
        palette !== null &&
        (this.kind === 'overlay' || outlineFade > 0) &&
        placement.shows(template, this.margin),
    )
  }

  /**
   * Draw `visible` (see `visible`), uploading what each still lacks within the frame's allowance,
   * shared evenly among the templates that need one.
   *
   * MapLibre applies custom-layer defaults before its callback and marks its state cache dirty
   * afterwards, so this sets the state it needs and reads none back: `getParameter` would serialise
   * the CPU behind Wplace's raster GPU work.
   */
  draw(visible: readonly SceneTemplate[], frame: TemplatePassFrame): TemplatePassResult {
    const { gl, kind } = this
    const { store, placement } = frame
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.enable(gl.BLEND)
    // Premultiplied source, which is what the fragment shaders write.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.disable(gl.DEPTH_TEST)
    if (kind === 'outline') gl.uniform1i(this.uniform('u_darkTheme'), isDarkMapTheme() ? 1 : 0)
    else gl.uniform1i(this.uniform('u_maxMinifyTaps'), frame.minifyTapCap)

    const { margin } = this
    let uploadsLeft =
      frame.uploadAllowance === null
        ? 0
        : visible.filter(({ template }) => !store.hasCurrent(template)).length
    let uploadPixelsLeft = frame.uploadAllowance ?? 0
    let uploadedPixels = 0
    let drawIntersections = 0
    let uploaded = false
    let pending = false
    for (const { template, appearance, fade, outlineFade, palette } of visible) {
      let entry: TemplateGpuEntry | null
      if (frame.uploadAllowance === null) entry = store.entry(template.id)
      else {
        const current = store.hasCurrent(template)
        const allowance = current ? 0 : Math.floor(uploadPixelsLeft / uploadsLeft--)
        const advanced = store.advance(
          template,
          allowance,
          frame.generation,
          current ? [] : placement.visibleRects(template),
        )
        uploadPixelsLeft -= advanced.uploadedPixels
        uploadedPixels += advanced.uploadedPixels
        if (advanced.status === 'failed') continue
        if (!current) uploaded = true
        if (advanced.status === 'pending') pending = true
        entry = advanced.entry
      }
      if (entry === null || palette === null) continue
      store.uploadPalette(entry, palette)

      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, entry.palette)
      gl.uniform1i(this.uniform('u_palette'), 1)
      gl.uniform1f(this.uniform('u_stampSize'), appearance.size)
      gl.uniform1f(this.uniform('u_stampRadius'), appearance.radius)
      gl.uniform2f(this.uniform('u_stampOffset'), appearance.translateX, appearance.translateY)
      gl.uniform1f(this.uniform('u_stampRotation'), (appearance.rotation * Math.PI) / 180)
      if (kind === 'outline') {
        gl.uniform1f(
          this.uniform('u_fade'),
          fade * appearance.opacity * outlineFade * frame.peekOpacity,
        )
        // Keep the persisted control scale, but render it as 3.125%..25% of a canvas pixel, so it
        // grows and shrinks with Wplace's pixels as the map zooms.
        gl.uniform1f(this.uniform('u_outlineWidth'), appearance.contrastOutlineSize / 8)
      } else {
        gl.uniform1f(this.uniform('u_fade'), fade * frame.peekOpacity)
        gl.uniform1f(this.uniform('u_opacity'), appearance.opacity)
        gl.uniform1i(this.uniform('u_plain'), isPlain(appearance) ? 1 : 0)
      }

      placement.forEachQuad(template, entry, margin, this.vertices, (source) => {
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, source.texture)
        gl.uniform1i(this.uniform('u_indices'), 0)
        gl.uniform2f(this.uniform('u_size'), source.textureWidth, source.textureHeight)
        if (kind === 'outline')
          gl.uniform4iv(this.uniform('u_diagonals'), source.diagonals.map(Number))
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.vertices)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
        drawIntersections++
      })
    }
    gl.bindVertexArray(null)
    return { drawIntersections, uploadedPixels, uploaded, pending }
  }

  dispose(): void {
    this.gl.deleteBuffer(this.buffer)
    this.gl.deleteVertexArray(this.vao)
    this.gl.deleteProgram(this.program)
  }
}
