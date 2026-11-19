import { TILE_SIZE } from '@caelestis/shared'
import { announceCanvasWrite, type CanvasDraw } from './canvas-write.js'
import { count } from './debug.js'
import {
  flipRow,
  markCanvasDirty,
  PATCH_LIMIT,
  readWrite,
  writeDraftPixels,
} from './draft-pixels.js'
import { UNPAINTED } from './native-pixels.js'
import { type InstalledValueHook, installValueHook, runObservedCall } from './page-hooks.js'
import { isCapturing } from './tile-pixels.js'

/**
 * Every pixel write to a page canvas, announced through `canvas-write.ts`, and the small ones to a
 * tile-sized draft canvas patched straight into its draft.
 */

/** The image and destination rectangle of a scaled `drawImage` call, in either long form. */
const drawnImage = (args: readonly unknown[]): CanvasDraw | null => {
  const destination = args.length === 5 ? args.slice(1) : args.length === 9 ? args.slice(5) : null
  const [x, y, width, height] = destination ?? []
  return typeof x === 'number' &&
    typeof y === 'number' &&
    typeof width === 'number' &&
    typeof height === 'number'
    ? { source: args[0], x, y, width, height }
    : null
}

const isTileSized = (canvas: { width?: number; height?: number }): boolean =>
  canvas.width === TILE_SIZE && canvas.height === TILE_SIZE

/** Hook the 2D canvas writes Wplace draws drafts with. Null, with nothing left installed, on failure. */
export const installCanvasWriteTaps = (
  realm: Window & typeof globalThis,
): InstalledValueHook | null => {
  const offscreenPrototype = (
    realm as typeof realm & {
      OffscreenCanvasRenderingContext2D?: { prototype: CanvasRenderingContext2D }
    }
  ).OffscreenCanvasRenderingContext2D?.prototype
  const prototypes = [realm.CanvasRenderingContext2D?.prototype, offscreenPrototype].filter(
    (prototype): prototype is CanvasRenderingContext2D => prototype !== undefined,
  )
  const hooks: InstalledValueHook[] = []
  const clipped = new WeakSet<object>()
  try {
    for (const prototype of prototypes) {
      const nativePutImageData = prototype.putImageData
      const wrappedPutImageData = function (
        this: CanvasRenderingContext2D,
        ...args: Parameters<CanvasRenderingContext2D['putImageData']>
      ): void {
        runObservedCall(
          () => Reflect.apply(nativePutImageData, this, args),
          () => {
            const [image, dx, dy, dirtyX = 0, dirtyY = 0, dirtyWidth, dirtyHeight] = args
            const values = [
              dx,
              dy,
              dirtyX,
              dirtyY,
              dirtyWidth ?? image.width,
              dirtyHeight ?? image.height,
            ]
            if (
              !values.every((value) => Number.isInteger(value) && Math.abs(value) <= 0x7fffffff)
            ) {
              markCanvasDirty(this.canvas)
              announceCanvasWrite(this.canvas)
              return
            }
            const width = dirtyWidth ?? image.width
            const height = dirtyHeight ?? image.height
            const left = Math.max(0, -dx, Math.min(dirtyX, dirtyX + width))
            const top = Math.max(0, -dy, Math.min(dirtyY, dirtyY + height))
            const right = Math.min(
              image.width,
              this.canvas.width - dx,
              Math.max(dirtyX, dirtyX + width),
            )
            const bottom = Math.min(
              image.height,
              this.canvas.height - dy,
              Math.max(dirtyY, dirtyY + height),
            )
            if (right <= left || bottom <= top) return
            const rect = { x: dx + left, y: dy + top, width: right - left, height: bottom - top }
            announceCanvasWrite(this.canvas, rect)
            if (!isCapturing() || !isTileSized(this.canvas)) return
            if (rect.width > PATCH_LIMIT || rect.height > PATCH_LIMIT) {
              markCanvasDirty(this.canvas, rect)
              return
            }
            writeDraftPixels(this.canvas, readWrite(image, dx, dy, rect))
          },
        )
      }
      const hook = installValueHook(prototype, 'putImageData', wrappedPutImageData)
      if (hook === null) throw new Error('putImageData is not hookable')
      hooks.push(hook)

      const nativeClearRect = prototype.clearRect
      const wrappedClearRect = function (
        this: CanvasRenderingContext2D,
        ...args: Parameters<CanvasRenderingContext2D['clearRect']>
      ): void {
        runObservedCall(
          () => Reflect.apply(nativeClearRect, this, args),
          () => {
            const [x, y, width, height] = args
            const transform = this.getTransform?.()
            if (
              clipped.has(this) ||
              transform === undefined ||
              transform.a !== 1 ||
              transform.b !== 0 ||
              transform.c !== 0 ||
              transform.d !== 1 ||
              transform.e !== 0 ||
              transform.f !== 0
            ) {
              markCanvasDirty(this.canvas)
              announceCanvasWrite(this.canvas)
              return
            }
            announceCanvasWrite(this.canvas, { x, y, width, height })
            if (!isCapturing() || !isTileSized(this.canvas)) return
            if (
              !Number.isInteger(x) ||
              !Number.isInteger(y) ||
              !Number.isInteger(width) ||
              !Number.isInteger(height) ||
              width <= 0 ||
              height <= 0 ||
              width > PATCH_LIMIT ||
              height > PATCH_LIMIT
            ) {
              markCanvasDirty(this.canvas)
              return
            }
            const triples: number[] = []
            for (let rowOffset = 0; rowOffset < height; rowOffset++) {
              const row = flipRow(y + rowOffset)
              if (row < 0 || row >= TILE_SIZE) continue
              for (let columnOffset = 0; columnOffset < width; columnOffset++) {
                const column = x + columnOffset
                if (column < 0 || column >= TILE_SIZE) continue
                triples.push(column, row, UNPAINTED)
              }
            }
            if (triples.length === 0) return
            writeDraftPixels(this.canvas, triples)
            count('pixels:draft erased')
          },
        )
      }
      const clearHook = installValueHook(prototype, 'clearRect', wrappedClearRect)
      if (clearHook === null) throw new Error('clearRect is not hookable')
      hooks.push(clearHook)

      // These operations can copy, transform, clip, or reset pixels. Recover from the resulting
      // canvas once, not from every upload of that unchanged canvas.
      for (const name of [
        'drawImage',
        'fillRect',
        'strokeRect',
        'fill',
        'stroke',
        'fillText',
        'strokeText',
        'reset',
        'clip',
      ] as const) {
        const native = prototype[name]
        if (typeof native !== 'function') continue
        const wrapped = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
          return runObservedCall(
            () => Reflect.apply(native, this, args),
            () => {
              if (name === 'clip') {
                clipped.add(this)
                return
              }
              if (name === 'reset') clipped.delete(this)
              markCanvasDirty(this.canvas)
              announceCanvasWrite(this.canvas, null, name === 'drawImage' ? drawnImage(args) : null)
            },
          )
        }
        const hook = installValueHook(prototype, name, wrapped)
        if (hook === null) throw new Error(`${name} is not hookable`)
        hooks.push(hook)
      }
    }
    for (const prototype of new Set([
      realm.HTMLCanvasElement?.prototype,
      realm.OffscreenCanvas?.prototype,
    ])) {
      if (prototype === undefined) continue
      for (const name of ['width', 'height'] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
        const nativeSet = descriptor?.set
        if (descriptor === undefined || nativeSet === undefined) continue
        Object.defineProperty(prototype, name, {
          ...descriptor,
          set(this: HTMLCanvasElement | OffscreenCanvas, value: number) {
            runObservedCall(
              () => nativeSet.call(this, value),
              () => {
                markCanvasDirty(this)
                announceCanvasWrite(this)
              },
            )
          },
        })
        hooks.push({
          restore: () => {
            Object.defineProperty(prototype, name, descriptor)
          },
        })
      }
    }
    const offscreen = realm.OffscreenCanvas?.prototype
    if (offscreen?.transferToImageBitmap !== undefined) {
      const native = offscreen.transferToImageBitmap
      const hook = installValueHook(
        offscreen,
        'transferToImageBitmap',
        function (this: OffscreenCanvas) {
          return runObservedCall(
            () => native.call(this),
            () => {
              markCanvasDirty(this)
              announceCanvasWrite(this)
            },
          )
        },
      )
      if (hook === null) throw new Error('transferToImageBitmap is not hookable')
      hooks.push(hook)
    }
  } catch {
    for (const hook of hooks.reverse()) hook.restore()
    return null
  }
  return {
    restore: () => {
      for (const hook of hooks.reverse()) hook.restore()
    },
  }
}
