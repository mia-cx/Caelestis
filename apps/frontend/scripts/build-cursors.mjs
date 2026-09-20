// Rasterise Pixelarticons into cursor PNGs at 1x and 2x with a one pixel dark outline, and print the
// hotspot of each so app.css can point at it. Run from apps/frontend: `node scripts/build-cursors.mjs`.
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
  { role: 'crosshair', name: 'target', hotspot: 'centre' },
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

const render = async (data, scale) => {
  const size = GRID * scale
  // Outline: the glyph in the dark colour shifted one grid pixel in four directions, then the light glyph on top.
  const dark = await sharp(svgOf(data, '#101014', size))
    .png()
    .toBuffer()
  const light = await sharp(svgOf(data, '#f5f4f0', size))
    .png()
    .toBuffer()
  const canvas = size + 2 * scale
  const layers = [
    [0, scale],
    [2 * scale, scale],
    [scale, 0],
    [scale, 2 * scale],
  ].map(([left, top]) => ({ input: dark, left, top }))
  layers.push({ input: light, left: scale, top: scale })
  return sharp({
    create: {
      width: canvas,
      height: canvas,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(layers)
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
