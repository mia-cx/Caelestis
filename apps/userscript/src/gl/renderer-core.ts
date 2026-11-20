import { warn } from '../debug.js'
import { VERTEX_SOURCE } from './shaders.js'

const compile = (gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null => {
  const shader = gl.createShader(type)
  if (shader === null) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    warn('overlay shader failed to compile', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}

/** Link the shader program shared by the MapLibre and alliance-artboard hosts. */
export const linkTemplateProgram = (
  gl: WebGL2RenderingContext,
  fragmentSource: string,
): WebGLProgram | null => {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
  if (vertex === null || fragment === null) {
    if (vertex !== null) gl.deleteShader(vertex)
    if (fragment !== null) gl.deleteShader(fragment)
    return null
  }
  const program = gl.createProgram()
  if (program === null) {
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    return null
  }
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    warn('overlay program failed to link', gl.getProgramInfoLog(program))
    gl.deleteProgram(program)
    return null
  }
  return program
}

/** Four vertices of clip xyzw + uv: one quad, as the shared vertex shader reads it. */
export const QUAD_FLOATS = 4 * 6

/**
 * A buffer for one quad, rewritten per draw so its corners keep double precision until the last
 * moment, bound to `program`'s `a_clip` and `a_uv` in a vertex array. Null if the context refuses.
 */
export const createQuadVertexArray = (
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
): { readonly buffer: WebGLBuffer; readonly vao: WebGLVertexArrayObject } | null => {
  const buffer = gl.createBuffer()
  const vao = gl.createVertexArray()
  if (buffer === null || vao === null) {
    if (buffer !== null) gl.deleteBuffer(buffer)
    if (vao !== null) gl.deleteVertexArray(vao)
    return null
  }
  const stride = 6 * Float32Array.BYTES_PER_ELEMENT
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, QUAD_FLOATS * Float32Array.BYTES_PER_ELEMENT, gl.DYNAMIC_DRAW)
  const clip = gl.getAttribLocation(program, 'a_clip')
  const uv = gl.getAttribLocation(program, 'a_uv')
  gl.enableVertexAttribArray(clip)
  gl.vertexAttribPointer(clip, 4, gl.FLOAT, false, stride, 0)
  gl.enableVertexAttribArray(uv)
  gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, stride, 4 * Float32Array.BYTES_PER_ELEMENT)
  gl.bindVertexArray(null)
  return { buffer, vao }
}

/** Write a device-pixel box with its texture coordinates into `into` as one quad. */
export const writeQuad = (
  box: {
    readonly left: number
    readonly top: number
    readonly right: number
    readonly bottom: number
  },
  uv: { readonly u0: number; readonly v0: number; readonly u1: number; readonly v1: number },
  bufferWidth: number,
  bufferHeight: number,
  into: Float32Array,
): void => {
  writeClipCorner(box.left, box.top, bufferWidth, bufferHeight, uv.u0, uv.v0, into, 0)
  writeClipCorner(box.right, box.top, bufferWidth, bufferHeight, uv.u1, uv.v0, into, 6)
  writeClipCorner(box.left, box.bottom, bufferWidth, bufferHeight, uv.u0, uv.v1, into, 12)
  writeClipCorner(box.right, box.bottom, bufferWidth, bufferHeight, uv.u1, uv.v1, into, 18)
}

/** Convert one device-pixel corner to the clip coordinates consumed by the shared vertex shader. */
export const writeClipCorner = (
  deviceX: number,
  deviceY: number,
  bufferWidth: number,
  bufferHeight: number,
  u: number,
  v: number,
  into: Float32Array,
  offset: number,
): void => {
  into[offset] = (2 * deviceX) / bufferWidth - 1
  into[offset + 1] = 1 - (2 * deviceY) / bufferHeight
  into[offset + 2] = 0
  into[offset + 3] = 1
  into[offset + 4] = u
  into[offset + 5] = v
}
