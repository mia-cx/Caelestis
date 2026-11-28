import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const glyphs = {
  A: '01110/11011/11011/11111/11011/11011/11011',
  B: '11110/11011/11011/11110/11011/11011/11110',
  C: '01111/11000/11000/11000/11000/11000/01111',
  D: '11110/11011/11011/11011/11011/11011/11110',
  E: '11111/11000/11000/11110/11000/11000/11111',
  F: '11111/11000/11000/11110/11000/11000/11000',
  G: '01111/11000/11000/11011/11011/11011/01111',
  H: '11011/11011/11011/11111/11011/11011/11011',
  I: '01110/00100/00100/00100/00100/00100/01110',
  L: '11000/11000/11000/11000/11000/11000/11111',
  M: '10001/11011/11111/10101/10001/10001/10001',
  N: '10011/11011/11011/11111/11011/11011/11001',
  O: '01110/11011/11011/11011/11011/11011/01110',
  P: '11110/11011/11011/11110/11000/11000/11000',
  R: '11110/11011/11011/11110/11011/11011/11011',
  S: '01111/11000/11000/01110/00011/00011/11110',
  T: '11111/00100/00100/00100/00100/00100/00100',
  U: '11011/11011/11011/11011/11011/11011/01110',
  W: '10001/10001/10001/10101/11111/11011/10001',
  X: '11011/11011/01010/00100/01010/11011/11011',
  '&': '01100/10010/10100/01000/10101/10010/01101',
  '-': '00000/00000/00000/01110/00000/00000/00000',
}

const width = 128
const height = 40
const output = new URL('../apps/docs/vault/images/install/', import.meta.url)
const moon = await readFile(new URL('../brand/logo/caelestis-16.png', import.meta.url))

function rect(x, y, width, height) {
  return `M${x} ${y}h${width}v${height}h-${width}z`
}

function path(color, ...shapes) {
  return `<path fill="${color}" d="${shapes.join(' ')}"/>`
}

function label(text, x, y, color) {
  const pixels = []
  for (const [index, letter] of [...text].entries()) {
    if (letter === ' ') continue
    for (const [row, bits] of glyphs[letter].split('/').entries()) {
      for (const [column, bit] of [...bits].entries()) {
        if (bit === '1') pixels.push(rect(x + index * 6 + column, y + row, 1, 1))
      }
    }
  }
  return path(color, ...pixels)
}

for (const [file, browser, method, accent] of [
  ['firefox', 'FIREFOX', 'ADD-ON', '#edbfff'],
  ['chrome-edge', 'CHROME & EDGE', 'USERSCRIPT', '#c9bfff'],
]) {
  const art = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" shape-rendering="crispEdges">
    ${path('#6d28d9', rect(3, 0, 122, 40), rect(0, 3, 128, 34), rect(1, 1, 126, 38))}
    ${path('#211038', rect(3, 2, 122, 35), rect(2, 3, 124, 33))}
    ${path('#382059', rect(6, 7, 24, 26), rect(5, 8, 26, 24))}
    ${path('#6d28d9', rect(34, 8, 1, 24))}
    ${label('GET IT FOR', 40, 6, accent)}
    ${label(browser, 40, 16, '#fff7ff')}
    ${label(method, 40, 27, accent)}
    ${path(
      accent,
      rect(120, 26, 1, 5),
      rect(118, 28, 1, 1),
      rect(119, 29, 3, 1),
      rect(122, 28, 1, 1),
      rect(118, 32, 5, 1),
    )}
  </svg>`
  const banner = await sharp(Buffer.from(art))
    .composite([{ input: moon, left: 10, top: 12 }])
    .png()
    .toBuffer()

  await sharp(banner)
    .resize(width * 2, height * 2, { kernel: 'nearest' })
    .toFile(fileURLToPath(new URL(`banner-${file}.png`, output)))
}
