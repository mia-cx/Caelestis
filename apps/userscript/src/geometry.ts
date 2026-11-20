/** An axis-aligned rectangle of pixels: its top-left cell and its size. */
export interface PixelRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Where something sits on the canvas, in canvas pixels: its top-left cell and its size. */
export interface Placement {
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
}

/** The overlap of two rectangles; null when they only touch or lie apart. */
export const intersectRects = (left: PixelRect, right: PixelRect): PixelRect | null => {
  const x = Math.max(left.x, right.x)
  const y = Math.max(left.y, right.y)
  const farX = Math.min(left.x + left.width, right.x + right.width)
  const farY = Math.min(left.y + left.height, right.y + right.height)
  return farX <= x || farY <= y ? null : { x, y, width: farX - x, height: farY - y }
}
