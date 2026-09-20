// Rebuild `falsetype-glyphs.png` and `.json` in ASCII order from the letter cells already in the sheet
// plus the bitmaps in `falsetype-extra-glyphs.mjs`. Run from apps/frontend: `node fonts/build-sheet.mjs`.
// Writes a dark 8x preview beside them for checking shapes by eye.
import { readFileSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'
import { EXTRA_GLYPHS } from './falsetype-extra-glyphs.mjs'

const here = (file) => new URL(file, import.meta.url)
const meta = JSON.parse(readFileSync(here('./falsetype-glyphs.json'), 'utf8'))
const { data, info } = await sharp(here('./falsetype-glyphs.png').pathname)
  .raw()
  .toBuffer({ resolveWithObject: true })
const lineHeight = meta.lineHeight
const existing = new Map(meta.glyphs.map((g) => [g.char, g]))

/** A glyph as rows of booleans, lineHeight tall. */
const cellOf = (char) => {
  const known = existing.get(char)
  if (known !== undefined) {
    return Array.from({ length: lineHeight }, (_, y) =>
      Array.from(
        { length: known.width },
        (_, x) => data[(y * info.width + known.x + x) * 4 + 3] > 0,
      ),
    )
  }
  const rows = EXTRA_GLYPHS[char]
  if (rows === undefined) throw new Error(`no glyph for ${JSON.stringify(char)}`)
  const width = Math.max(...rows.map((row) => row.length))
  return Array.from({ length: lineHeight }, (_, y) =>
    Array.from({ length: width }, (_, x) => rows[y]?.[x] === '#'),
  )
}

const chars = Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i))
const cells = chars.map((char) => ({ char, rows: cellOf(char) }))
const sheetWidth = cells.reduce((sum, c) => sum + c.rows[0].length + 1, 0) + 1
const sheet = Buffer.alloc(sheetWidth * lineHeight * 4, 0)
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
const raw = { raw: { width: sheetWidth, height: lineHeight, channels: 4 } }
await sharp(sheet, raw).png().toFile(here('./falsetype-glyphs.png').pathname)
writeFileSync(here('./falsetype-glyphs.json'), `${JSON.stringify({ ...meta, glyphs }, null, 2)}\n`)

// Preview: the sheet at 8x, and a labelled block of the new glyphs at 8x with a row per 16 characters.
const preview = (cellsToDraw, columns) => {
  const cellW = 13,
    cellH = lineHeight + 2
  const rows = Math.ceil(cellsToDraw.length / columns)
  const w = columns * cellW,
    h = rows * cellH
  const buf = Buffer.alloc(w * h * 4, 0)
  cellsToDraw.forEach((cell, index) => {
    const ox = (index % columns) * cellW + 1,
      oy = Math.floor(index / columns) * cellH + 1
    cell.rows.forEach((row, y) =>
      row.forEach((on, k) => {
        if (!on) return
        const i = ((oy + y) * w + ox + k) * 4
        buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 255
      }),
    )
  })
  return sharp(buf, { raw: { width: w, height: h, channels: 4 } })
    .flatten({ background: '#1a1a1a' })
    .resize({ width: w * 8, kernel: 'nearest' })
    .png()
}
await preview(cells, 16).toFile(here('./falsetype-charset-preview@8x.png').pathname)
console.log(`${glyphs.length} glyphs, sheet ${sheetWidth}x${lineHeight}`)
