// Rebuild `falsetype-glyphs.png` and `.json` in code point order from the letter cells already in the
// sheet, the bitmaps in `falsetype-extra-glyphs.mjs`, and letters composed from a base plus a mark.
// Run from apps/frontend: `node fonts/build-sheet.mjs`. Writes a dark 8x preview beside them.
import { readFileSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'
import { COMPOSED, EXTRA_GLYPHS, MARKS } from './falsetype-extra-glyphs.mjs'

// Sheet rows: 3 of headroom for marks over capitals, 8 of capitals, 3 of descender. Bitmaps in the
// glyph file are written in the 11 row frame that starts at the cap top.
const HEADROOM = 3
const CAP_ROWS = 8
const DESCENDER_ROWS = 3
const LINE_HEIGHT = HEADROOM + CAP_ROWS + DESCENDER_ROWS
const BASELINE = HEADROOM + CAP_ROWS
const X_HEIGHT_TOP = BASELINE - 5

const here = (file) => new URL(file, import.meta.url)
const meta = JSON.parse(readFileSync(here('./falsetype-glyphs.json'), 'utf8'))
const { data, info } = await sharp(here('./falsetype-glyphs.png').pathname)
  .raw()
  .toBuffer({ resolveWithObject: true })
const existing = new Map(meta.glyphs.map((g) => [g.char, g]))
// An older sheet without headroom shifts down when read.
const readOffset = LINE_HEIGHT - meta.lineHeight

const blank = (width) =>
  Array.from({ length: LINE_HEIGHT }, () => Array.from({ length: width }, () => false))

const fromBitmap = (rows, top) => {
  const width = Math.max(...rows.map((row) => row.length))
  const cell = blank(width)
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '#') cell[top + y][x] = true
  })
  return cell
}

const fromSheet = (glyph) => {
  const cell = blank(glyph.width)
  for (let y = 0; y < meta.lineHeight; y++)
    for (let x = 0; x < glyph.width; x++)
      if (data[(y * info.width + glyph.x + x) * 4 + 3] > 0) cell[y + readOffset][x] = true
  return cell
}

const inkColumns = (cell) => {
  let first = Number.POSITIVE_INFINITY
  let last = -1
  for (const row of cell)
    row.forEach((on, x) => {
      if (!on) return
      first = Math.min(first, x)
      last = Math.max(last, x)
    })
  return last < 0 ? [0, cell[0].length - 1] : [first, last]
}

/** Stamp a mark centred over the base's ink, widening the cell when the mark is wider. */
const compose = (baseCell, markRows, top) => {
  const markWidth = Math.max(...markRows.map((row) => row.length))
  const [first, last] = inkColumns(baseCell)
  const inkWidth = last - first + 1
  let cell = baseCell
  let shift = 0
  if (markWidth > cell[0].length) {
    shift = Math.floor((markWidth - cell[0].length) / 2)
    cell = cell.map((row) => [
      ...Array(shift).fill(false),
      ...row,
      ...Array(markWidth - cell[0].length - shift).fill(false),
    ])
  }
  const left = Math.max(0, shift + first + Math.floor((inkWidth - markWidth) / 2))
  markRows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++)
      if (row[x] === '#' && left + x < cell[0].length) cell[top + y][left + x] = true
  })
  return cell
}

const cellOf = (char) => {
  if (EXTRA_GLYPHS[char] !== undefined) return fromBitmap(EXTRA_GLYPHS[char], HEADROOM)
  const composed = COMPOSED[char]
  if (composed !== undefined) {
    const [baseChar, markName] = composed
    const base = cellOf(baseChar)
    const mark = MARKS[markName]
    if (markName === 'cedilla') return compose(base, mark, BASELINE)
    const bodyTop =
      char === char.toUpperCase() && char !== char.toLowerCase() ? HEADROOM : X_HEIGHT_TOP
    // Two rows of mark, one empty row, then the body. A three row mark takes the gap row too.
    return compose(base, mark, bodyTop - 1 - mark.length + (mark.length === 3 ? 1 : 0))
  }
  const known = existing.get(char)
  if (known !== undefined) return fromSheet(known)
  throw new Error(`no glyph for ${JSON.stringify(char)}`)
}

const chars = [
  ...new Set([
    ...Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i)),
    ...Object.keys(EXTRA_GLYPHS),
    ...Object.keys(COMPOSED),
  ]),
].sort((a, b) => a.codePointAt(0) - b.codePointAt(0))
const cells = chars.map((char) => ({ char, rows: cellOf(char) }))

const sheetWidth = cells.reduce((sum, c) => sum + c.rows[0].length + 1, 0) + 1
const sheet = Buffer.alloc(sheetWidth * LINE_HEIGHT * 4, 0)
const glyphs = []
let x = 0
for (const cell of cells) {
  const width = cell.rows[0].length
  cell.rows.forEach((row, y) =>
    row.forEach((on, k) => {
      if (!on) return
      const i = (y * sheetWidth + x + k) * 4
      sheet[i] = sheet[i + 1] = sheet[i + 2] = sheet[i + 3] = 255
    }),
  )
  glyphs.push({ char: cell.char, x, width })
  x += width + 1
}
const raw = { raw: { width: sheetWidth, height: LINE_HEIGHT, channels: 4 } }
await sharp(sheet, raw).png().toFile(here('./falsetype-glyphs.png').pathname)
writeFileSync(
  here('./falsetype-glyphs.json'),
  `${JSON.stringify({ lineHeight: LINE_HEIGHT, baseline: BASELINE, spacing: 1, glyphs }, null, 2)}\n`,
)

// Preview at 8x, 16 glyphs per row.
const columns = 16
const cellW = 13
const cellH = LINE_HEIGHT + 2
const rows = Math.ceil(cells.length / columns)
const w = columns * cellW
const h = rows * cellH
const buf = Buffer.alloc(w * h * 4, 0)
cells.forEach((cell, index) => {
  const ox = (index % columns) * cellW + 1
  const oy = Math.floor(index / columns) * cellH + 1
  cell.rows.forEach((row, y) =>
    row.forEach((on, k) => {
      if (!on) return
      const i = ((oy + y) * w + ox + k) * 4
      buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 255
    }),
  )
})
await sharp(buf, { raw: { width: w, height: h, channels: 4 } })
  .flatten({ background: '#1a1a1a' })
  .resize({ width: w * 8, kernel: 'nearest' })
  .png()
  .toFile(here('./falsetype-charset-preview@8x.png').pathname)
console.log(`${glyphs.length} glyphs, sheet ${sheetWidth}x${LINE_HEIGHT}`)
