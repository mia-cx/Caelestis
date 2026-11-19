import { TILE_SIZE, type TileCoord } from '@caelestis/shared'
import { count, log, logRender } from './debug.js'
import { createDraftCaptureStamps, markCanvasDirty, refreshDraftCanvas } from './draft-pixels.js'
import { getMap } from './map-handle.js'
import {
  type InstalledValueHook,
  installValueHook,
  runObservedCall,
  sideEffectFreeUnsignedLong,
} from './page-hooks.js'
import { isPageInstance } from './page-world.js'
import { tileOfBitmap } from './tile-attribution.js'
import {
  discardFrameDraws,
  frameCanvas,
  recordDraw,
  recordTileDraw,
  restartFrame,
  scheduleFrame,
  setFrameCanvas,
} from './tile-frame.js'
import { MAP_CANVAS } from './wplace-dom.js'
import { wplaceRasterRole } from './wplace-raster.js'

/**
 * Read MapLibre's tile draws back out of the map's WebGL context.
 *
 * The hook that makes the matrix legible is `getUniformLocation`: it takes the uniform's *name* as
 * a string, so recording those turns `uniformMatrix4fv` from an anonymous sixteen floats into a
 * named `u_projection_matrix`. A draw call knows only a texture; `tile-attribution.ts` carries the
 * tile coordinate from the fetch to the bitmap that texture was uploaded from.
 *
 * It must be installed before MapLibre calls `getContext`, so it runs at `document-start`.
 */

const MATRIX_LENGTH = 16

type CanvasSource = CanvasImageSource & { width: number; height: number }

const looksLikeMapCanvas = (canvas: HTMLCanvasElement | null): boolean => {
  try {
    return canvas?.matches(MAP_CANVAS) === true
  } catch {
    // A hostile canvas shim must not change a successful native getContext call.
    return false
  }
}

/** Hook `getContext` so the map's WebGL context reports each frame's tile draws. */
export const installMapContextObserver = (
  realm: Window & typeof globalThis,
): InstalledValueHook | null => {
  let nativeGetContext: typeof realm.HTMLCanvasElement.prototype.getContext
  try {
    nativeGetContext = realm.HTMLCanvasElement.prototype.getContext
  } catch {
    return null
  }
  let wrapped = false
  let activeContextGeneration = 0
  let restoreActiveContextHooks: (() => void) | null = null

  const wrappedGetContextImplementation = function (
    this: HTMLCanvasElement,
    // biome-ignore lint/suspicious/noExplicitAny: matching the DOM overload set is not worth it
    ...args: any[]
    // biome-ignore lint/suspicious/noExplicitAny: the return type follows the overload set too
  ): any {
    const context = nativeGetContext.apply(this, args as never)
    // MapLibre uses literal context ids. Avoid repeating WebIDL's string conversion for unusual
    // callers: instrumentation must not invoke their conversion hooks after native success.
    if (typeof args[0] !== 'string') return context
    const type = args[0]
    if (!type.startsWith('webgl') || context === null) return context
    // The first WebGL context in the document is not necessarily the map's. Wplace may well make one
    // for something else first — a fingerprinting probe, an effect — and instrumenting that one and
    // then refusing every context after it means the overlay simply never receives a frame. If the
    // map has already been captured, only its own canvas counts; before that, take the first and let
    // a later canvas carrying MapLibre's measured class correct it. A measured map canvas also
    // yields to the next measured one so overlapping or repeated SPA remounts do not strand the
    // overlay waiting for a getContext retry that never comes.
    let mapOwned: HTMLCanvasElement | undefined
    try {
      mapOwned = getMap()?.getCanvas()
    } catch {
      // A map mid-construction may not answer yet; treat that as no opinion.
    }
    const mapCanvas = frameCanvas()
    // Repeated getContext calls on the active canvas return its already-wrapped context. A different
    // canvas confirmed by the live Map handle is a replacement and must be allowed to retarget.
    if (wrapped && mapCanvas === this) return context
    const candidateLooksLikeMap = looksLikeMapCanvas(this)
    const replacingMeasuredMapCanvas =
      wrapped && candidateLooksLikeMap && looksLikeMapCanvas(mapCanvas)
    if (mapOwned !== undefined && mapOwned !== this) {
      if (!replacingMeasuredMapCanvas) {
        log('skipped a WebGL context that is not the map canvas', { type })
        return context
      }
      // The captured Map belongs to a previous SPA mount. Its canvas cannot veto the next measured
      // MapLibre canvas: overlapping mounts create the new context before detaching the old one.
      mapOwned = undefined
    }
    if (wrapped && mapOwned === undefined && !replacingMeasuredMapCanvas) {
      // Keep the first provisional context until there is positive evidence that a later canvas is
      // MapLibre's. Once the measured map class is wrapped, an unrelated context cannot steal it.
      if (looksLikeMapCanvas(mapCanvas) || !candidateLooksLikeMap) return context
    }
    if (wrapped) log('re-targeting onto the map canvas', { type })
    const previousWrapped = wrapped
    const previousContextGeneration = activeContextGeneration
    const previousActiveContextRestore = restoreActiveContextHooks
    wrapped = true
    const contextGeneration = ++activeContextGeneration
    const isCurrentContext = (): boolean => contextGeneration === activeContextGeneration
    setFrameCanvas(this)

    const gl = context as WebGL2RenderingContext
    const glHooks: InstalledValueHook[] = []
    let glHookFailed = false
    let detachContextLossListener = (): void => undefined
    const restoreGlHooks = (): void => {
      for (let index = glHooks.length - 1; index >= 0; index -= 1) glHooks[index]?.restore()
    }
    const abandonGlHooks = (): typeof context => {
      detachContextLossListener()
      restoreGlHooks()
      wrapped = previousWrapped
      activeContextGeneration = previousContextGeneration
      setFrameCanvas(mapCanvas)
      return context
    }
    try {
      // The empty proxy keeps assignment's contextual WebGL types without inheriting the real
      // context's property invariants. Its setter installs own properties through defineProperty,
      // which safely bypasses a co-installed script's inherited non-writable method.
      const hookedGl = new Proxy({} as WebGL2RenderingContext, {
        set(_target, property, value) {
          if (glHookFailed) return true
          const hook = installValueHook(gl, property, value)
          if (hook === null) glHookFailed = true
          else glHooks.push(hook)
          return true
        },
      })
      // Weak: a long session rebuilds programs, and this only ever needs object identity.
      interface UniformIdentity {
        readonly program: WebGLProgram
        readonly name: string
      }
      const uniforms = new WeakMap<WebGLUniformLocation, UniformIdentity>()
      const primarySamplerUnits = new WeakMap<WebGLProgram, number>()
      const projectionByProgram = new WeakMap<WebGLProgram, ArrayLike<number>>()
      let programs = new WeakSet<WebGLProgram>()
      const tileOfTexture = new WeakMap<WebGLTexture, TileCoord>()
      const canvasOfTexture = new WeakMap<WebGLTexture, CanvasSource>()
      const draftStamps = createDraftCaptureStamps()
      let textures = new WeakSet<WebGLTexture>()
      const texture2DByUnit = new Map<number, WebGLTexture | null>()
      let activeProgram: WebGLProgram | null = null
      let activeTextureUnit: number = gl.TEXTURE0
      const nativeGetParameter = gl.getParameter
      let maxTextureUnits = Number.POSITIVE_INFINITY
      try {
        const measured = nativeGetParameter.call(gl, gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS)
        if (typeof measured === 'number' && Number.isInteger(measured) && measured > 0) {
          maxTextureUnits = measured
        }
      } catch {
        // The real context answers this. A partial test double or hostile shim leaves validation at
        // the enum's non-negative/integer baseline instead of breaking installation.
      }
      const nativeGetUniformLocation = gl.getUniformLocation
      hookedGl.getUniformLocation = {
        getUniformLocation(this: WebGL2RenderingContext, program: WebGLProgram, name: string) {
          let location: WebGLUniformLocation | null = null
          return runObservedCall(
            () => {
              location = nativeGetUniformLocation.call(this, program, name)
              return location
            },
            () => {
              if (this !== gl || location === null) return
              // A successful location proves the program belongs to this context. This also covers
              // programs created before instrumentation without adding a synchronous query later.
              programs.add(program)
              uniforms.set(location, { program, name })
              // WebGL sampler uniforms default to texture unit zero. Remember that before the first
              // explicit upload too: wrappers such as MapLibre cache uniforms and may not set one again.
              if (name === 'u_image0' && !primarySamplerUnits.has(program)) {
                primarySamplerUnits.set(program, gl.TEXTURE0)
              }
            },
          )
        },
      }.getUniformLocation

      const nativeCreateProgram = gl.createProgram
      if (typeof nativeCreateProgram === 'function') {
        hookedGl.createProgram = {
          createProgram(this: WebGL2RenderingContext): WebGLProgram {
            let created: WebGLProgram | undefined
            return runObservedCall(
              () => {
                created = nativeCreateProgram.call(this)
                return created
              },
              () => {
                if (this === gl && created !== undefined) programs.add(created)
              },
            )
          },
        }.createProgram
      }

      const nativeUseProgram = gl.useProgram
      hookedGl.useProgram = {
        useProgram(this: WebGL2RenderingContext, program: WebGLProgram | null) {
          return runObservedCall(
            () => nativeUseProgram.call(this, program),
            () => {
              if (this !== gl) return
              if (program === null || program === undefined) {
                activeProgram = null
                return
              }
              if (programs.has(program)) {
                activeProgram = program
                return
              }
              // Only pre-hook, foreign, or deleted objects need a synchronous state query. Programs
              // created or successfully inspected on this context stay on the WeakSet fast path.
              const accepted = nativeGetParameter.call(gl, gl.CURRENT_PROGRAM)
              if (accepted === null || typeof accepted === 'object') {
                activeProgram = accepted as WebGLProgram | null
              }
            },
          )
        },
      }.useProgram

      const nativeDeleteProgram = gl.deleteProgram
      if (typeof nativeDeleteProgram === 'function') {
        hookedGl.deleteProgram = {
          deleteProgram(this: WebGL2RenderingContext, program: WebGLProgram | null) {
            return runObservedCall(
              () => nativeDeleteProgram.call(this, program),
              () => {
                if (this === gl && program !== null) programs.delete(program)
              },
            )
          },
        }.deleteProgram
      }

      const nativeUniform1i = gl.uniform1i
      hookedGl.uniform1i = {
        uniform1i(
          this: WebGL2RenderingContext,
          location: WebGLUniformLocation | null,
          value: GLint,
        ) {
          return runObservedCall(
            () => nativeUniform1i.call(this, location, value),
            () => {
              if (this !== gl || location === null || typeof value !== 'number') return
              const uniform = uniforms.get(location)
              if (uniform?.name !== 'u_image0' || uniform.program !== activeProgram) return
              primarySamplerUnits.set(uniform.program, gl.TEXTURE0 + value)
            },
          )
        },
      }.uniform1i

      const nativeUniformMatrix4fv = gl.uniformMatrix4fv
      hookedGl.uniformMatrix4fv = {
        uniformMatrix4fv(
          this: WebGL2RenderingContext,
          location: WebGLUniformLocation | null,
          transpose: GLboolean,
          value: Float32List,
          ...rest: [srcOffset?: number, srcLength?: number]
        ) {
          return runObservedCall(
            () =>
              Reflect.apply(nativeUniformMatrix4fv, this, [location, transpose, value, ...rest]),
            () => {
              if (this !== gl || location === null || transpose) return
              const uniform = uniforms.get(location)
              if (uniform?.name !== 'u_projection_matrix' || uniform.program !== activeProgram)
                return
              // Plain sequences have already had every element converted by WebIDL. Reading them again
              // can invoke accessors twice and capture different values, so only page-realm typed arrays
              // are safe to snapshot.
              if (
                !isPageInstance(
                  value,
                  'Float32Array',
                  realm as unknown as Record<string, unknown>,
                ) ||
                !realm.ArrayBuffer.isView(value)
              )
                return
              const offset = sideEffectFreeUnsignedLong(rest[0])
              if (offset === undefined) return
              const source = value as Float32Array
              const suppliedLength = sideEffectFreeUnsignedLong(rest[1])
              if (
                suppliedLength === undefined ||
                (suppliedLength !== 0 &&
                  (suppliedLength < MATRIX_LENGTH || offset + suppliedLength > source.length))
              )
                return
              if (source.length - offset < MATRIX_LENGTH) return
              const snapshot = new Float32Array(MATRIX_LENGTH)
              for (let index = 0; index < MATRIX_LENGTH; index += 1) {
                snapshot[index] = source[offset + index] ?? 0
              }
              projectionByProgram.set(uniform.program, snapshot)
            },
          )
        },
      }.uniformMatrix4fv as typeof gl.uniformMatrix4fv

      const nativeActiveTexture = gl.activeTexture
      hookedGl.activeTexture = {
        activeTexture(this: WebGL2RenderingContext, texture: GLenum) {
          return runObservedCall(
            () => nativeActiveTexture.call(this, texture),
            () => {
              if (this !== gl || typeof texture !== 'number') return
              const index = texture - gl.TEXTURE0
              if (!Number.isInteger(index) || index < 0 || index >= maxTextureUnits) return
              activeTextureUnit = texture
            },
          )
        },
      }.activeTexture

      const nativeCreateTexture = gl.createTexture
      hookedGl.createTexture = {
        createTexture(this: WebGL2RenderingContext): WebGLTexture {
          let created: WebGLTexture | undefined
          return runObservedCall(
            () => {
              created = nativeCreateTexture.call(this)
              return created
            },
            () => {
              if (this === gl && created !== undefined) textures.add(created)
            },
          )
        },
      }.createTexture

      const nativeBindTexture = gl.bindTexture
      hookedGl.bindTexture = {
        bindTexture(this: WebGL2RenderingContext, target: GLenum, texture: WebGLTexture | null) {
          return runObservedCall(
            () => nativeBindTexture.call(this, target, texture),
            () => {
              if (this === gl && target === gl.TEXTURE_2D) {
                if (texture === null || texture === undefined) {
                  texture2DByUnit.set(activeTextureUnit, null)
                } else if (textures.has(texture)) {
                  texture2DByUnit.set(activeTextureUnit, texture)
                } else {
                  // Same strategy as framebuffers below: only pre-hook or foreign objects need a
                  // synchronous query. MapLibre-created textures stay on the WeakSet fast path.
                  const accepted = nativeGetParameter.call(gl, gl.TEXTURE_BINDING_2D)
                  if (accepted === null || typeof accepted === 'object') {
                    texture2DByUnit.set(activeTextureUnit, accepted as WebGLTexture | null)
                    if (accepted === texture) textures.add(texture)
                  }
                }
              }
            },
          )
        },
      }.bindTexture

      const nativeDeleteTexture = gl.deleteTexture
      hookedGl.deleteTexture = {
        deleteTexture(this: WebGL2RenderingContext, texture: WebGLTexture | null) {
          return runObservedCall(
            () => nativeDeleteTexture.call(this, texture),
            () => {
              if (this !== gl || texture === null || !textures.delete(texture)) return
              tileOfTexture.delete(texture)
              canvasOfTexture.delete(texture)
              for (const [unit, bound] of texture2DByUnit) {
                if (bound === texture) texture2DByUnit.set(unit, null)
              }
            },
          )
        },
      }.deleteTexture

      const isPageCanvasSource = (source: unknown): source is CanvasSource => {
        if (typeof source !== 'object' || source === null) return false
        const constructors = realm as unknown as Record<string, unknown>
        return (
          isPageInstance(source, 'HTMLCanvasElement', constructors) ||
          isPageInstance(source, 'OffscreenCanvas', constructors)
        )
      }

      const attributeUpload = (target: number, source: unknown): void => {
        if (target !== gl.TEXTURE_2D) return
        const texture = texture2DByUnit.get(activeTextureUnit) ?? null
        if (
          texture !== null &&
          isPageCanvasSource(source) &&
          source.width === TILE_SIZE &&
          source.height === TILE_SIZE
        ) {
          count('pixels:tile-sized canvas uploads')
          if (canvasOfTexture.get(texture) !== source) markCanvasDirty(source)
          canvasOfTexture.set(texture, source)
          tileOfTexture.delete(texture)
          // Animated CanvasSources upload every frame. Only real writes or source replacement
          // invalidate pixels; upload itself is attribution, not evidence of mutation.
          return
        }
        if (
          texture === null ||
          !isPageInstance(source, 'ImageBitmap', realm as unknown as Record<string, unknown>)
        ) {
          if (texture !== null && tileOfTexture.has(texture)) {
            const had = tileOfTexture.get(texture)
            logRender(
              'texture',
              `DROPPED attribution ${had?.x}/${had?.y} — re-uploaded from non-bitmap`,
              {
                sourceKind:
                  source === null
                    ? 'null'
                    : ((source as object)?.constructor?.name ?? typeof source),
              },
            )
            tileOfTexture.delete(texture)
          }
          return
        }
        const bitmap = source as ImageBitmap
        const tile = tileOfBitmap(bitmap)
        if (tile !== undefined) {
          const had = tileOfTexture.get(texture)
          tileOfTexture.set(texture, tile)
          logRender('texture', `attributed ${tile.x}/${tile.y}`, {
            size: `${bitmap.width}x${bitmap.height}`,
            replaced: had ? `${had.x}/${had.y}` : null,
          })
          return
        }
        const had = tileOfTexture.get(texture)
        if (had !== undefined) {
          logRender('texture', `DROPPED attribution ${had.x}/${had.y} — re-uploaded unattributed`, {
            size: `${bitmap.width}x${bitmap.height}`,
          })
          tileOfTexture.delete(texture)
        }
      }

      // Both upload paths have to be watched, and missing one is not a gap in coverage but a source
      // of wrong answers. MapLibre pools textures: a *new* tile goes in with `texImage2D`, but a
      // tile it already has a texture for is refreshed in place with `texSubImage2D`. Wplace serves
      // tiles `no-store` and re-fetches them, so this happens constantly during ordinary use.
      // Watching only `texImage2D` would leave the texture attributed to whatever tile it was first
      // given while the GPU held a different one.
      const nativeTexSubImage2D = gl.texSubImage2D
      hookedGl.texSubImage2D = {
        // biome-ignore lint/suspicious/noExplicitAny: texSubImage2D has as many overloads as texImage2D
        texSubImage2D(this: WebGL2RenderingContext, ...subArgs: any[]) {
          return runObservedCall(
            () => Reflect.apply(nativeTexSubImage2D, this, subArgs),
            () => {
              if (this === gl) attributeUpload(subArgs[0], subArgs[subArgs.length - 1])
            },
          )
        },
      }.texSubImage2D as typeof gl.texSubImage2D

      const nativeTexImage2D = gl.texImage2D
      hookedGl.texImage2D = {
        // biome-ignore lint/suspicious/noExplicitAny: texImage2D has ten overloads
        texImage2D(this: WebGL2RenderingContext, ...texArgs: any[]) {
          return runObservedCall(
            () => Reflect.apply(nativeTexImage2D, this, texArgs),
            () => {
              if (this === gl) attributeUpload(texArgs[0], texArgs[texArgs.length - 1])
            },
          )
        },
      }.texImage2D as typeof gl.texImage2D

      let framebuffers = new WeakSet<WebGLFramebuffer>()
      const nativeCreateFramebuffer = gl.createFramebuffer
      hookedGl.createFramebuffer = {
        createFramebuffer(this: WebGL2RenderingContext): WebGLFramebuffer {
          let created: WebGLFramebuffer | undefined
          return runObservedCall(
            () => {
              created = nativeCreateFramebuffer.call(this)
              return created
            },
            () => {
              if (this === gl && created !== undefined) framebuffers.add(created)
            },
          )
        },
      }.createFramebuffer

      let drawFramebuffer: WebGLFramebuffer | null = null
      const drawFramebufferTarget =
        typeof gl.DRAW_FRAMEBUFFER === 'number' ? gl.DRAW_FRAMEBUFFER : null
      const drawFramebufferBinding =
        typeof gl.DRAW_FRAMEBUFFER_BINDING === 'number'
          ? gl.DRAW_FRAMEBUFFER_BINDING
          : gl.FRAMEBUFFER_BINDING
      let scissorEnabled = false
      let colorWriteMask: [boolean, boolean, boolean, boolean] = [true, true, true, true]
      const validClearMask = gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT
      // A provisional context remains wrapped after the real map context appears. Its later draws
      // must not schedule a flush against the new map canvas or clear/corrupt the live overlay.
      const scheduleFrameFlush = (): boolean => {
        if (!isCurrentContext()) return false
        scheduleFrame(isCurrentContext)
        return true
      }

      const nativeBindFramebuffer = gl.bindFramebuffer
      hookedGl.bindFramebuffer = {
        bindFramebuffer(
          this: WebGL2RenderingContext,
          target: GLenum,
          framebuffer: WebGLFramebuffer | null,
        ) {
          return runObservedCall(
            () => nativeBindFramebuffer.call(this, target, framebuffer),
            () => {
              if (this !== gl) return
              if (
                target === gl.FRAMEBUFFER ||
                (drawFramebufferTarget !== null && target === drawFramebufferTarget)
              ) {
                // WebIDL treats an explicit undefined as null. Known same-context objects are the
                // ordinary MapLibre path and need no synchronous state query.
                if (framebuffer === null || framebuffer === undefined) {
                  drawFramebuffer = null
                } else if (framebuffers.has(framebuffer)) {
                  drawFramebuffer = framebuffer
                } else {
                  // An object created before instrumentation may be valid; a foreign or deleted one
                  // is rejected without throwing. Query only this unusual path so normal frame binds
                  // never pay for a synchronous getParameter call.
                  const accepted = nativeGetParameter.call(gl, drawFramebufferBinding)
                  if (accepted === null || typeof accepted === 'object') {
                    drawFramebuffer = accepted as WebGLFramebuffer | null
                    if (accepted === framebuffer) framebuffers.add(framebuffer)
                  }
                }
              }
            },
          )
        },
      }.bindFramebuffer

      const nativeDeleteFramebuffer = gl.deleteFramebuffer
      hookedGl.deleteFramebuffer = {
        deleteFramebuffer(this: WebGL2RenderingContext, framebuffer: WebGLFramebuffer | null) {
          return runObservedCall(
            () => nativeDeleteFramebuffer.call(this, framebuffer),
            () => {
              if (
                this === gl &&
                framebuffer !== null &&
                framebuffers.delete(framebuffer) &&
                framebuffer === drawFramebuffer
              ) {
                // WebGL automatically restores the default draw framebuffer when the bound object is
                // deleted; keep the mirror on the same transition.
                drawFramebuffer = null
              }
            },
          )
        },
      }.deleteFramebuffer

      const nativeEnable = gl.enable
      hookedGl.enable = {
        enable(this: WebGL2RenderingContext, cap: GLenum) {
          return runObservedCall(
            () => nativeEnable.call(this, cap),
            () => {
              if (this === gl && cap === gl.SCISSOR_TEST) scissorEnabled = true
            },
          )
        },
      }.enable

      const nativeDisable = gl.disable
      hookedGl.disable = {
        disable(this: WebGL2RenderingContext, cap: GLenum) {
          return runObservedCall(
            () => nativeDisable.call(this, cap),
            () => {
              if (this === gl && cap === gl.SCISSOR_TEST) scissorEnabled = false
            },
          )
        },
      }.disable

      const nativeColorMask = gl.colorMask
      hookedGl.colorMask = {
        colorMask(
          this: WebGL2RenderingContext,
          red: GLboolean,
          green: GLboolean,
          blue: GLboolean,
          alpha: GLboolean,
        ) {
          return runObservedCall(
            () => nativeColorMask.call(this, red, green, blue, alpha),
            () => {
              if (this === gl) {
                colorWriteMask = [Boolean(red), Boolean(green), Boolean(blue), Boolean(alpha)]
              }
            },
          )
        },
      }.colorMask

      const nativeClear = gl.clear
      hookedGl.clear = {
        clear(this: WebGL2RenderingContext, mask: GLbitfield) {
          return runObservedCall(
            () => nativeClear.call(this, mask),
            () => {
              if (
                this === gl &&
                drawFramebuffer === null &&
                typeof mask === 'number' &&
                Number.isInteger(mask) &&
                mask >= 0 &&
                mask <= 0xffffffff &&
                (mask & gl.COLOR_BUFFER_BIT) !== 0 &&
                (mask & ~validClearMask) === 0 &&
                !scissorEnabled &&
                colorWriteMask.every(Boolean)
              ) {
                // The GPU discarded every earlier default-framebuffer draw in this task. Do the same
                // to quads accumulated for the pending flush.
                if (scheduleFrameFlush()) discardFrameDraws()
              }
            },
          )
        },
      }.clear

      const refreshDraft = (texture: WebGLTexture): void =>
        refreshDraftCanvas(canvasOfTexture.get(texture), draftStamps)

      const recordDrawCall = (drawCount: number): void => {
        // Scheduled on every draw, not only tile draws, so a frame that renders the map with no
        // Wplace tiles in it still reaches the listener. A default-framebuffer colour clear above
        // covers the rarer frame that contains no draw call at all.
        if (drawFramebuffer !== null) return
        if (!scheduleFrameFlush()) return
        // WebGL accepts a zero count as a no-op. It may still delimit a tile-less map frame, but it
        // cannot reuse the last program/texture/matrix state to manufacture a quad that was not drawn.
        if (!Number.isFinite(drawCount) || !Number.isInteger(drawCount) || drawCount <= 0) return
        recordDraw()
        if (activeProgram === null) {
          count('draw:not-raster-program')
          return
        }
        const primaryUnit = primarySamplerUnits.get(activeProgram)
        if (primaryUnit === undefined) {
          count('draw:not-raster-program')
          return
        }
        // Raster crossfades bind the child/current tile to u_image0, then bind the parent to
        // u_image1. The last bind is therefore the wrong identity for the child's projection matrix.
        const drawnTexture = texture2DByUnit.get(primaryUnit) ?? null
        const drawnProjection = projectionByProgram.get(activeProgram) ?? null
        if (drawnTexture === null || drawnProjection === null) {
          count('draw:no-texture-or-matrix')
          return
        }
        const map = getMap()
        const layerIndex = map?.painter?.currentLayer
        const layerId = layerIndex === undefined ? null : (map?.style?._order?.[layerIndex] ?? null)
        const role = wplaceRasterRole(layerId)
        if (role === 'draft') {
          refreshDraft(drawnTexture)
          count('draw:draft-layer')
          return
        }
        if (layerId !== null && role !== 'tile') {
          count('draw:not-pixel-art-layer')
          return
        }
        const tile = tileOfTexture.get(drawnTexture)
        if (tile === undefined) {
          refreshDraft(drawnTexture)
          count('draw:texture-not-a-known-tile')
          return
        }
        recordTileDraw(drawnProjection, tile, this)
      }

      const nativeDrawArrays = gl.drawArrays
      hookedGl.drawArrays = {
        drawArrays(this: WebGL2RenderingContext, mode: GLenum, first: GLint, count: GLsizei) {
          return runObservedCall(
            () => nativeDrawArrays.call(this, mode, first, count),
            () => {
              if (this === gl) recordDrawCall(count)
            },
          )
        },
      }.drawArrays
      const nativeDrawElements = gl.drawElements
      hookedGl.drawElements = {
        drawElements(
          this: WebGL2RenderingContext,
          mode: GLenum,
          count: GLsizei,
          elementType: GLenum,
          offset: GLintptr,
        ) {
          return runObservedCall(
            () => nativeDrawElements.call(this, mode, count, elementType, offset),
            () => {
              if (this === gl) recordDrawCall(count)
            },
          )
        },
      }.drawElements

      if (glHookFailed) return abandonGlHooks()
      log('wrapped the map WebGL context', {
        type,
        canvas: `${this.width}x${this.height}`,
      })

      try {
        const nativeAddEventListener = this.addEventListener
        const nativeRemoveEventListener = this.removeEventListener
        const onContextLost = (): void => {
          try {
            if (!isCurrentContext()) return
            discardFrameDraws()
            activeProgram = null
            programs = new WeakSet<WebGLProgram>()
            activeTextureUnit = gl.TEXTURE0
            textures = new WeakSet<WebGLTexture>()
            texture2DByUnit.clear()
            framebuffers = new WeakSet<WebGLFramebuffer>()
            drawFramebuffer = null
            scissorEnabled = false
            colorWriteMask = [true, true, true, true]
            scheduleFrameFlush()
          } catch {
            // Context-loss bookkeeping is observational and must never escape into page event code.
          }
        }
        nativeAddEventListener.call(this, 'webglcontextlost', onContextLost)
        detachContextLossListener = () => {
          try {
            nativeRemoveEventListener.call(this, 'webglcontextlost', onContextLost)
          } catch {
            // Retiring observation must not disturb the replacement context that already committed.
          }
        }
      } catch {
        // A hostile or partial canvas shim must not break a successfully created WebGL context.
      }

      previousActiveContextRestore?.()
      restartFrame()
      restoreActiveContextHooks = () => {
        detachContextLossListener()
        restoreGlHooks()
      }
      return gl
    } catch {
      return abandonGlHooks()
    }
  }
  const wrappedGetContext = {
    getContext(
      this: HTMLCanvasElement,
      // biome-ignore lint/suspicious/noExplicitAny: matching the DOM overload set is not worth it
      ...args: any[]
      // biome-ignore lint/suspicious/noExplicitAny: the return type follows the overload set too
    ): any {
      return wrappedGetContextImplementation.apply(this, args)
    },
  }.getContext
  return installValueHook(realm.HTMLCanvasElement.prototype, 'getContext', wrappedGetContext)
}
