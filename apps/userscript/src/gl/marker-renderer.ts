import { warn } from '../debug.js'
import type { MarkList } from '../templates/mark-list.js'

/**
 * One point per submitted vertex, read from the list's slots by index.
 *
 * Unsampled, vertex `i` draws slot `i`, in the list's row-major order. Sampled, vertex `i` draws
 * slot `shuffle(i)`, a fixed shuffle of every slot the list could hold, so the first `k` vertices
 * are an even random sample of the list and a larger `k` only adds to it. Slots past the list's
 * end and removed marks draw nothing.
 *
 * The shuffle is a bijection on a power-of-two domain, walked until it lands inside the list's
 * capacity. That restricts it to a bijection on exactly the capacity, so no submitted vertex is
 * spent on the gap up to the next power of two. The domain is under twice the capacity, so a walk
 * takes fewer than two steps on average; the rare one that runs out of steps draws nothing.
 */
const VERTEX = `#version 300 es
precision highp int;
precision highp usampler2D;
uniform usampler2D u_marks;
uniform uint u_width;
uniform uint u_count;
uniform uint u_capacity;
uniform uint u_domainBits;
uniform bool u_sampled;
uniform vec2 u_tileScreen;
uniform vec2 u_tileScale;
uniform vec2 u_buffer;
uniform float u_size;
uniform uint u_sampleSeed;
flat out float v_wanted;

// A bijection on [0, 2^bits): an xor and two odd multiplies with xorshifts, each invertible.
uint permute(uint index) {
  uint mask = (1u << u_domainBits) - 1u;
  uint shift = max(1u, u_domainBits >> 1u);
  uint value = (index ^ u_sampleSeed) & mask;
  value = (value * 0x2c1b3c6du) & mask;
  value ^= value >> shift;
  value = (value * 0x297a2d39u) & mask;
  return value ^ (value >> shift);
}

uint shuffle(uint index) {
  uint slot = permute(index);
  for (int step = 0; step < 32 && slot >= u_capacity; step++) slot = permute(slot);
  return slot;
}

void main() {
  uint slot = u_sampled ? shuffle(uint(gl_VertexID)) : uint(gl_VertexID);
  uint mark = slot < u_count
    ? texelFetch(u_marks, ivec2(int(slot % u_width), int(slot / u_width)), 0).r
    : 0x80000000u;
  v_wanted = float(mark >> 20u);
  if ((mark & 0x80000000u) != 0u) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  vec2 pixel = vec2(float(mark & 1023u), float((mark >> 10u) & 1023u));
  vec2 device = u_tileScreen + (pixel + 0.5) * u_tileScale;
  gl_Position = vec4((2.0 * device.x) / u_buffer.x - 1.0, 1.0 - (2.0 * device.y) / u_buffer.y, 0.0, 1.0);
  gl_PointSize = u_size;
}
`

const FRAGMENT = `#version 300 es
precision highp float;
uniform float u_size;
uniform float u_thickness;
uniform vec3 u_colour;
uniform vec3 u_otherColour;
uniform float u_otherOpacity;
uniform float u_selected;
uniform float u_fade;
flat in float v_wanted;
out vec4 fragColor;

void main() {
  vec2 offset = (gl_PointCoord - 0.5) * u_size;
  float half_ = u_thickness * 0.5;
  if (abs(offset.x) > half_ && abs(offset.y) > half_) discard;
  bool other = u_selected >= 0.0 && round(v_wanted) != round(u_selected);
  vec3 colour = other ? u_otherColour : u_colour;
  float alpha = u_fade * (other ? u_otherOpacity : 1.0);
  fragColor = vec4(colour * alpha, alpha);
}
`

const compile = (gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null => {
  const shader = gl.createShader(type)
  if (shader === null) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    warn('install', 'marker shader failed to compile', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}

export interface MarkerStyle {
  /** CSS pixels. The renderer converts this to the current device scale. */
  readonly size: number
  readonly thickness: number
  readonly colour: readonly [number, number, number]
  readonly otherColour: readonly [number, number, number] | null
  readonly otherOpacity: number
  readonly selected: number
}

let cachedScale: {
  canvas: unknown
  buffer: number
  dpr: number
  scale: number
} | null = null

/** Device pixels per CSS pixel for the context's current backing store. */
export const deviceScale = (gl: WebGL2RenderingContext): number => {
  const canvas = gl.canvas
  const buffer = gl.drawingBufferWidth
  const dpr = window.devicePixelRatio || 1
  if (
    cachedScale !== null &&
    cachedScale.canvas === canvas &&
    cachedScale.buffer === buffer &&
    cachedScale.dpr === dpr
  )
    return cachedScale.scale
  const measured = canvas instanceof HTMLCanvasElement ? canvas.getBoundingClientRect().width : 0
  const scale = measured > 0 ? buffer / measured : dpr
  cachedScale = { canvas, buffer, dpr, scale }
  return scale
}

export interface MarkerProjection {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly pixelWidth: number
  readonly pixelHeight: number
  readonly seedX: number
  readonly seedY: number
}

/** A list's GPU copy, one slot per texel, and how far through the list's changes it is. */
interface HeldMarks {
  readonly texture: WebGLTexture
  slots: Uint32Array
  revision: number
}

/** Texels per row of a list's texture, capped by the device. */
const MARK_TEXTURE_WIDTH = 4_096

/** Bits of the smallest power of two that holds `capacity` slots. */
const domainBits = (capacity: number): number => (capacity <= 1 ? 0 : 32 - Math.clz32(capacity - 1))

/**
 * Vertices to submit for one list at this sample rate, and whether they are shuffled.
 *
 * The shuffle runs over the list's capacity, its used slots plus room for later marks, so `k`
 * vertices draw about `k × length / capacity` marks. Submitting `rate × capacity` keeps the drawn
 * share at `rate` while the budget, not the list, bounds what reaches the GPU; the room for later
 * marks adds at most an eighth.
 */
export const markerSubmission = (
  length: number,
  capacity: number,
  sampleRate: number,
): { readonly vertices: number; readonly sampled: boolean } => {
  if (sampleRate >= 1) return { vertices: length, sampled: false }
  return {
    vertices: Math.min(capacity, Math.ceil(Math.max(0, sampleRate) * capacity)),
    sampled: true,
  }
}

/** Past this many runs of changed slots, one upload of the whole list beats a call per run. */
const MAX_PATCH_RUNS = 64

/** Changed slots as flat `[first, count]` runs of adjacent slots, or null to upload everything. */
const changedRuns = (changes: readonly number[] | null): number[] | null => {
  if (changes === null) return null
  const slots = Uint32Array.from(changes).sort()
  const runs: number[] = []
  for (const slot of slots) {
    const last = runs.length - 2
    const end = last < 0 ? -1 : (runs[last] as number) + (runs[last + 1] as number)
    if (slot < end) continue
    if (slot === end) runs[last + 1] = (runs[last + 1] as number) + 1
    else runs.push(slot, 1)
  }
  return runs
}

/** Shared point-marker renderer used by both MapLibre and alliance artboards. */
export class MarkerRenderer {
  private program: WebGLProgram | null = null
  private vao: WebGLVertexArrayObject | null = null
  private textureBytes = 0
  private readonly textureWidth: number
  private readonly textures = new Map<MarkList, HeldMarks>()
  private readonly usedTextures = new Set<MarkList>()
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>()

  constructor(readonly gl: WebGL2RenderingContext) {
    const maximum = gl.getParameter(gl.MAX_TEXTURE_SIZE)
    this.textureWidth =
      typeof maximum === 'number' && maximum > 0
        ? Math.min(MARK_TEXTURE_WIDTH, maximum)
        : MARK_TEXTURE_WIDTH
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX)
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)
    if (vertex === null || fragment === null) {
      if (vertex !== null) gl.deleteShader(vertex)
      if (fragment !== null) gl.deleteShader(fragment)
      return
    }
    const program = gl.createProgram()
    if (program === null) {
      gl.deleteShader(vertex)
      gl.deleteShader(fragment)
      return
    }
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      warn('install', 'marker program failed to link', gl.getProgramInfoLog(program))
      gl.deleteProgram(program)
      return
    }
    this.program = program
    // Points read their marks from a texture, so the vertex array has no attributes.
    this.vao = gl.createVertexArray()
  }

  private uniform(name: string): WebGLUniformLocation | null {
    if (!this.uniforms.has(name)) {
      this.uniforms.set(
        name,
        this.program === null ? null : this.gl.getUniformLocation(this.program, name),
      )
    }
    return this.uniforms.get(name) ?? null
  }

  private applyStyle(style: MarkerStyle, fade: number): void {
    const gl = this.gl
    const scale = deviceScale(gl)
    gl.uniform1f(this.uniform('u_size'), style.size * scale)
    gl.uniform1f(this.uniform('u_thickness'), Math.max(1, Math.round(style.thickness * scale)))
    gl.uniform3f(this.uniform('u_colour'), ...style.colour)
    gl.uniform3f(this.uniform('u_otherColour'), ...(style.otherColour ?? style.colour))
    gl.uniform1f(this.uniform('u_otherOpacity'), style.otherOpacity)
    gl.uniform1f(this.uniform('u_selected'), style.selected)
    gl.uniform1f(this.uniform('u_fade'), fade)
  }

  beginFrame(): void {
    this.usedTextures.clear()
  }

  endFrame(): void {
    for (const [list, held] of this.textures) {
      if (this.usedTextures.has(list)) continue
      this.forget(list, held)
    }
  }

  private forget(list: MarkList, held: HeldMarks): void {
    this.gl.deleteTexture(held.texture)
    this.textures.delete(list)
    this.textureBytes -= held.slots.byteLength
  }

  /** Write slots `[first, first + count)` into the bound texture, row by row. */
  private upload(slots: Uint32Array, first: number, count: number): void {
    const gl = this.gl
    const width = this.textureWidth
    const end = first + count
    let at = first
    while (at < end) {
      const x = at % width
      const y = (at - x) / width
      const rows = x === 0 ? Math.floor((end - at) / width) : 0
      const texels = rows > 0 ? rows * width : Math.min(width - x, end - at)
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        x,
        y,
        rows > 0 ? width : texels,
        Math.max(1, rows),
        gl.RED_INTEGER,
        gl.UNSIGNED_INT,
        slots,
        at,
      )
      at += texels
    }
  }

  /** Bind a list's GPU copy, uploading only the slots it changed since this renderer last drew it. */
  private bind(list: MarkList): boolean {
    const gl = this.gl
    const held = this.textures.get(list)
    this.usedTextures.add(list)
    gl.activeTexture(gl.TEXTURE0)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    if (held !== undefined && held.slots === list.slots) {
      gl.bindTexture(gl.TEXTURE_2D, held.texture)
      if (held.revision === list.revision) return true
      const runs = changedRuns(list.changesSince(held.revision))
      if (runs !== null && runs.length <= MAX_PATCH_RUNS * 2) {
        for (let run = 0; run < runs.length; run += 2)
          this.upload(list.slots, runs[run] as number, runs[run + 1] as number)
        held.revision = list.revision
        return true
      }
    }
    // New, compacted, or too far behind: one texture sized for the list's slots, filled whole.
    if (held !== undefined) this.forget(list, held)
    const texture = gl.createTexture()
    if (texture === null) return false
    const rows = Math.max(1, Math.ceil(list.slots.length / this.textureWidth))
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32UI, this.textureWidth, rows)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    this.upload(list.slots, 0, list.slots.length)
    this.textures.set(list, { texture, slots: list.slots, revision: list.revision })
    this.textureBytes += list.slots.byteLength
    return true
  }

  /**
   * Draw several lists for one tile and one style with a single setup. Empty lists cost nothing.
   *
   * Returns the vertices submitted, which the sample rate bounds rather than the lists' length.
   */
  draw(
    projection: MarkerProjection,
    lists: readonly MarkList[],
    style: MarkerStyle,
    fade: number,
    sampleRate = 1,
  ): number {
    if (this.program === null || this.vao === null) return 0
    if (lists.every((list) => list.length === 0)) return 0
    const gl = this.gl
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.uniform1i(this.uniform('u_marks'), 0)
    gl.uniform1ui(this.uniform('u_width'), this.textureWidth)
    gl.uniform2f(this.uniform('u_tileScreen'), projection.x, projection.y)
    gl.uniform2f(
      this.uniform('u_tileScale'),
      projection.width / projection.pixelWidth,
      projection.height / projection.pixelHeight,
    )
    gl.uniform2f(this.uniform('u_buffer'), gl.drawingBufferWidth, gl.drawingBufferHeight)
    const sampleSeed =
      (Math.imul(projection.seedX, 73_856_093) ^ Math.imul(projection.seedY, 19_349_663)) >>> 0
    gl.uniform1ui(this.uniform('u_sampleSeed'), sampleSeed)
    this.applyStyle(style, fade)
    let submitted = 0
    for (const list of lists) {
      if (list.length === 0) continue
      const { vertices, sampled } = markerSubmission(list.length, list.slots.length, sampleRate)
      if (vertices === 0 || !this.bind(list)) continue
      gl.uniform1ui(this.uniform('u_count'), list.length)
      gl.uniform1ui(this.uniform('u_capacity'), list.slots.length)
      gl.uniform1ui(this.uniform('u_domainBits'), domainBits(list.slots.length))
      gl.uniform1i(this.uniform('u_sampled'), sampled ? 1 : 0)
      gl.drawArrays(gl.POINTS, 0, vertices)
      submitted += vertices
    }
    gl.bindVertexArray(null)
    return submitted
  }

  memoryBytes(): number {
    return this.textureBytes
  }

  dispose(): void {
    for (const { texture } of this.textures.values()) this.gl.deleteTexture(texture)
    this.textures.clear()
    this.usedTextures.clear()
    if (this.vao !== null) this.gl.deleteVertexArray(this.vao)
    if (this.program !== null) this.gl.deleteProgram(this.program)
    this.vao = null
    this.program = null
    this.textureBytes = 0
    this.uniforms.clear()
  }
}
