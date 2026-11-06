import { warn } from '../debug.js'
import type { MarkList } from '../templates/mark-list.js'

const VERTEX = `#version 300 es
precision highp int;
in uint a_mark;
uniform vec2 u_tileScreen;
uniform vec2 u_tileScale;
uniform vec2 u_buffer;
uniform float u_size;
uniform float u_sampleRate;
uniform uint u_sampleSeed;
flat out float v_wanted;

uint markerHash(uint value) {
  value = (value ^ (value >> 16u)) * 0x7feb352du;
  value = (value ^ (value >> 15u)) * 0x846ca68bu;
  return value ^ (value >> 16u);
}

void main() {
  v_wanted = float(a_mark >> 20u);
  bool dead = (a_mark & 0x80000000u) != 0u;
  // Sampled by pixel rather than by vertex, so patching one slot never reshuffles the others.
  bool dropped = u_sampleRate < 1.0 &&
    float(markerHash((a_mark & 0xfffffu) ^ u_sampleSeed) >> 8u) / 16777216.0 >= u_sampleRate;
  if (dead || dropped) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  vec2 pixel = vec2(float(a_mark & 1023u), float((a_mark >> 10u) & 1023u));
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

/** A list's GPU copy, and how far through the list's changes it is. */
interface HeldMarks {
  readonly buffer: WebGLBuffer
  slots: Uint32Array
  revision: number
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
  private markAttribute = -1
  private bufferBytes = 0
  private readonly buffers = new Map<MarkList, HeldMarks>()
  private readonly usedBuffers = new Set<MarkList>()
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>()

  constructor(readonly gl: WebGL2RenderingContext) {
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
    this.vao = gl.createVertexArray()
    if (this.vao === null) return
    gl.bindVertexArray(this.vao)
    this.markAttribute = gl.getAttribLocation(program, 'a_mark')
    gl.enableVertexAttribArray(this.markAttribute)
    gl.bindVertexArray(null)
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
    this.usedBuffers.clear()
  }

  endFrame(): void {
    for (const [list, held] of this.buffers) {
      if (this.usedBuffers.has(list)) continue
      this.gl.deleteBuffer(held.buffer)
      this.buffers.delete(list)
      this.bufferBytes -= held.slots.byteLength
    }
  }

  /** Bind a list's GPU copy, uploading only the slots it changed since this renderer last drew it. */
  private bind(list: MarkList): boolean {
    const gl = this.gl
    const held = this.buffers.get(list)
    this.usedBuffers.add(list)
    if (held === undefined) {
      const buffer = gl.createBuffer()
      if (buffer === null) return false
      this.buffers.set(list, { buffer, slots: list.slots, revision: list.revision })
      this.bufferBytes += list.slots.byteLength
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(gl.ARRAY_BUFFER, list.slots, gl.DYNAMIC_DRAW)
      return true
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, held.buffer)
    if (held.revision === list.revision) return true
    const runs = held.slots === list.slots ? changedRuns(list.changesSince(held.revision)) : null
    if (runs === null || runs.length > MAX_PATCH_RUNS * 2) {
      this.bufferBytes += list.slots.byteLength - held.slots.byteLength
      gl.bufferData(gl.ARRAY_BUFFER, list.slots, gl.DYNAMIC_DRAW)
      held.slots = list.slots
    } else {
      for (let run = 0; run < runs.length; run += 2) {
        const first = runs[run] as number
        const count = runs[run + 1] as number
        gl.bufferSubData(
          gl.ARRAY_BUFFER,
          first * Uint32Array.BYTES_PER_ELEMENT,
          list.slots,
          first,
          count,
        )
      }
    }
    held.revision = list.revision
    return true
  }

  /** Draw several lists for one tile and one style with a single setup. Empty lists cost nothing. */
  draw(
    projection: MarkerProjection,
    lists: readonly MarkList[],
    style: MarkerStyle,
    fade: number,
    sampleRate = 1,
  ): void {
    if (this.program === null || this.vao === null) return
    if (lists.every((list) => list.length === 0)) return
    const gl = this.gl
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.uniform2f(this.uniform('u_tileScreen'), projection.x, projection.y)
    gl.uniform2f(
      this.uniform('u_tileScale'),
      projection.width / projection.pixelWidth,
      projection.height / projection.pixelHeight,
    )
    gl.uniform2f(this.uniform('u_buffer'), gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.uniform1f(this.uniform('u_sampleRate'), sampleRate)
    const sampleSeed =
      (Math.imul(projection.seedX, 73_856_093) ^ Math.imul(projection.seedY, 19_349_663)) >>> 0
    gl.uniform1ui(this.uniform('u_sampleSeed'), sampleSeed)
    this.applyStyle(style, fade)
    for (const list of lists) {
      if (list.length === 0 || !this.bind(list)) continue
      gl.vertexAttribIPointer(
        this.markAttribute,
        1,
        gl.UNSIGNED_INT,
        Uint32Array.BYTES_PER_ELEMENT,
        0,
      )
      gl.drawArrays(gl.POINTS, 0, list.length)
    }
    gl.bindVertexArray(null)
  }

  memoryBytes(): number {
    return this.bufferBytes
  }

  dispose(): void {
    for (const { buffer } of this.buffers.values()) this.gl.deleteBuffer(buffer)
    this.buffers.clear()
    this.usedBuffers.clear()
    if (this.vao !== null) this.gl.deleteVertexArray(this.vao)
    if (this.program !== null) this.gl.deleteProgram(this.program)
    this.vao = null
    this.program = null
    this.bufferBytes = 0
    this.uniforms.clear()
  }
}
