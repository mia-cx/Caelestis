/**
 * The Caelestis mark: the 16x16 pixel-art moon from `brand/logo/caelestis-16.png`, inlined so the
 * elements bundle carries it without an asset pipeline. Draw it at a whole multiple of 16 CSS px
 * with `image-rendering: pixelated` so every art pixel stays square.
 */
export const CAELESTIS_LOGO =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA1UlEQVQ4y2NgoBAw4pLg4OT5D2P/+P6FkTjjoBo5OHn+37rz/D+yIURr3rrzPEmaWZA1X7p8m+QwYMImqKerSrS/mWC2r91wmGTbUbygqizBcPvuC5LC68f3L4xYvXDp8m0GfIGILIdigKqyBIOqsgQDAwMDw9oNhzEMgUVxR+8quBgjsiQsFmBeuX33OUNFcRhcMUxjRXEYPJBZkG1ADwNVZUmGjt5VDKrKkkhqnqOoQYkqWGzAFCFrRHYRchRjxDXM3zCbYYbBvIKePojKTNg0Ug0AAA0OZMFXS2AEAAAAAElFTkSuQmCC'

/** The art's own size; scale the mark by whole multiples of it. */
export const CAELESTIS_LOGO_PX = 16
