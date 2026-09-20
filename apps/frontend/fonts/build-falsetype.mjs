// Rebuild FalseType from the glyph sheet. From apps/frontend: `npm i --no-save opentype.js@1.3.4 wawoff2@2.0.1`
// once, then `node fonts/build-falsetype.mjs`. Writes the .woff2 the site serves and an .otf for editors.
import { readFileSync, writeFileSync } from 'node:fs'
import opentype from 'opentype.js'
import sharp from 'sharp'
import wawoff2 from 'wawoff2'

// One canvas pixel is 64 units of a 1024 unit em, so 16px renders 1:1, 2rem 2:1 and 3rem 3:1.
const UNIT = 64
const meta = JSON.parse(readFileSync(new URL('./falsetype-glyphs.json', import.meta.url), 'utf8'))
const { data, info } = await sharp(new URL('./falsetype-glyphs.png', import.meta.url).pathname)
  .raw()
  .toBuffer({ resolveWithObject: true })
const on = (x, y) => data[(y * info.width + x) * 4 + 3] > 0
const BASELINE = meta.baseline // rows 0..7 sit above the baseline, rows 8..10 below

/** Trace a bitmap into closed rectilinear contours by cancelling shared pixel edges. */
const trace = (cellX, width) => {
  const edges = new Map()
  const key = (a, b) => `${a[0]},${a[1]}>${b[0]},${b[1]}`
  const add = (a, b) => {
    const back = key(b, a)
    if (edges.has(back)) edges.delete(back)
    else edges.set(key(a, b), [a, b])
  }
  for (let r = 0; r < meta.lineHeight; r++)
    for (let k = 0; k < width; k++) {
      if (!on(cellX + k, r)) continue
      const x0 = k,
        x1 = k + 1
      const y1 = BASELINE - r,
        y0 = y1 - 1 // font y grows upward
      add([x0, y0], [x1, y0])
      add([x1, y0], [x1, y1])
      add([x1, y1], [x0, y1])
      add([x0, y1], [x0, y0])
    }
  const byStart = new Map()
  for (const [a, b] of edges.values()) {
    const k = `${a[0]},${a[1]}`
    if (!byStart.has(k)) byStart.set(k, [])
    byStart.get(k).push(b)
  }
  const contours = []
  const used = new Set()
  for (const [k, [a, b]] of edges) {
    if (used.has(k)) continue
    const loop = [a]
    let cur = b
    used.add(k)
    while (cur[0] !== a[0] || cur[1] !== a[1]) {
      loop.push(cur)
      const nexts = byStart.get(`${cur[0]},${cur[1]}`)
      const next = nexts.find((n) => !used.has(key(cur, n)))
      used.add(key(cur, next))
      cur = next
    }
    contours.push(loop)
  }
  return contours
}

const glyphs = [
  new opentype.Glyph({
    name: '.notdef',
    unicode: 0,
    advanceWidth: 6 * UNIT,
    path: new opentype.Path(),
  }),
]
for (const g of meta.glyphs) {
  const path = new opentype.Path()
  for (const loop of trace(g.x, g.width)) {
    // Pixel squares came out counter-clockwise; TrueType outers are clockwise, so walk them backwards.
    const pts = [...loop].reverse()
    path.moveTo(pts[0][0] * UNIT, pts[0][1] * UNIT)
    for (const p of pts.slice(1)) path.lineTo(p[0] * UNIT, p[1] * UNIT)
    path.close()
  }
  const advance = g.char === ' ' ? 2 * UNIT : (g.width + 1) * UNIT
  glyphs.push(
    new opentype.Glyph({
      name: g.char === ' ' ? 'space' : g.char,
      unicode: g.char.charCodeAt(0),
      advanceWidth: advance,
      path,
    }),
  )
}
const font = new opentype.Font({
  familyName: 'FalseType',
  styleName: 'Regular',
  unitsPerEm: 1024,
  // Ascender plus descender fills the em, so `line-height: 1` adds no half-leading and the baseline
  // sits 11 canvas pixels down: 8 rows of caps end 5 below centre, the 5 row x-height starts 1 above.
  // Both stay on the pixel grid at every whole multiple of 1rem.
  ascender: 11 * UNIT,
  descender: -(16 - 11) * UNIT,
  glyphs,
})
const otf = Buffer.from(font.toArrayBuffer())
writeFileSync(new URL('./FalseType.otf', import.meta.url), otf)
writeFileSync(
  new URL('../static/fonts/FalseType.woff2', import.meta.url),
  Buffer.from(await wawoff2.compress(otf)),
)
console.log('glyphs', glyphs.length, 'otf bytes', otf.length)
