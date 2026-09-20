// Rasterise Pixelarticons into cursor PNGs at 1x and 2x, stroke dark and enclosed regions filled
// light, and print the hotspot of each so app.css can point at it. Run from apps/frontend: `node scripts/build-cursors.mjs`.
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import sharp from 'sharp'

// The icon set is a dependency of the shared UI package, so resolve it from there.
const require = createRequire(new URL('../../../packages/ui/package.json', import.meta.url))
const icon = (name) =>
  require(`@iconify-icons/pixelarticons/${name}`).default ??
  require(`@iconify-icons/pixelarticons/${name}`)

/** Cursor role, icon, and where the hotspot sits: a corner of the ink box or its centre. */
const CURSORS = [
  { role: 'default', name: 'cursor-minimal', hotspot: 'top-left' },
  { role: 'pointer', name: 'pointer', hotspot: 'top-index' },
  { role: 'text', name: 'text-cursor', hotspot: 'centre' },
  { role: 'crosshair', name: 'plus', hotspot: 'centre' },
  { role: 'grab', name: 'hand', hotspot: 'centre' },
  { role: 'grabbing', name: 'hand', hotspot: 'centre' },
  { role: 'ew-resize', name: 'arrows-horizontal', hotspot: 'centre' },
  { role: 'not-allowed', name: 'cancel', hotspot: 'centre' },
]

const GRID = 24
const OUT = new URL('../static/cursors/', import.meta.url)
mkdirSync(OUT, { recursive: true })

const svgOf = (data, fill, size) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${data.width ?? GRID} ${data.height ?? GRID}" shape-rendering="crispEdges">${data.body.replaceAll('currentColor', fill)}</svg>`,
  )

/**
 * Draw the icon on its 24 pixel grid, keep its stroke as the dark outline, and flood-fill every
 * region the stroke encloses with the light colour, so the cursor reads on any background. The 2x
 * file is the same pixels doubled.
 */
const render = async (data, scale) => {
  const { data: raw, info } = await sharp(svgOf(data, '#000', GRID))
    .raw()
    .toBuffer({ resolveWithObject: true })
  const ink = (x, y) =>
    x >= 0 && y >= 0 && x < GRID && y < GRID && raw[(y * info.width + x) * 4 + 3] > 127
  // Outside: everything reachable from the border without crossing ink.
  const outside = new Uint8Array(GRID * GRID)
  const stack = []
  for (let i = 0; i < GRID; i++) stack.push([i, 0], [i, GRID - 1], [0, i], [GRID - 1, i])
  while (stack.length > 0) {
    const [x, y] = stack.pop()
    if (x < 0 || y < 0 || x >= GRID || y >= GRID || outside[y * GRID + x] || ink(x, y)) continue
    outside[y * GRID + x] = 1
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1])
  }
  const dark = [16, 16, 20, 255]
  const light = [245, 244, 240, 255]
  // Outside pixels touching the stroke get a light halo, so open shapes survive dark backgrounds.
  const halo = (x, y) =>
    [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].some(([dx, dy]) => ink(x + dx, y + dy))
  const pixels = Buffer.alloc(GRID * GRID * 4, 0)
  for (let y = 0; y < GRID; y++)
    for (let x = 0; x < GRID; x++) {
      const colour = ink(x, y) ? dark : !outside[y * GRID + x] || halo(x, y) ? light : null
      if (colour !== null) pixels.set(colour, (y * GRID + x) * 4)
    }
  return sharp(pixels, { raw: { width: GRID, height: GRID, channels: 4 } })
    .resize({ width: GRID * scale, kernel: 'nearest' })
    .png()
    .toBuffer()
}

const inkBox = async (png) => {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  let minX = info.width,
    minY = info.height,
    maxX = -1,
    maxY = -1
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++)
      if (data[(y * info.width + x) * 4 + 3] > 0) {
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
  return { minX, minY, maxX, maxY }
}

const hotspots = {}
for (const cursor of CURSORS) {
  const data = icon(cursor.name)
  const one = await render(data, 1)
  const two = await render(data, 2)
  writeFileSync(new URL(`${cursor.role}.png`, OUT), one)
  writeFileSync(new URL(`${cursor.role}@2x.png`, OUT), two)
  const box = await inkBox(one)
  const hotspot =
    cursor.hotspot === 'top-left'
      ? [box.minX, box.minY]
      : cursor.hotspot === 'top-index'
        ? [Math.round((box.minX + box.maxX) / 2) - 2, box.minY]
        : [Math.round((box.minX + box.maxX) / 2), Math.round((box.minY + box.maxY) / 2)]
  hotspots[cursor.role] = hotspot
}
console.log(JSON.stringify(hotspots))
