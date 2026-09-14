import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { latLngToCanvasPixel } from '../../packages/shared/src/tiles.ts'

/** Import a local native Wplace export through the backend's normal template API. */
export async function importWplace({ api, adminToken, filename }) {
  const source = JSON.parse(readFileSync(filename, 'utf8'))
  assert.match(source.image.dataUrl, /^data:image\/png;base64,/)
  const png = Buffer.from(source.image.dataUrl.split(',')[1], 'base64')
  const origin = latLngToCanvasPixel({ lat: source.bounds.north, lng: source.bounds.west })
  const form = new FormData()
  form.set('png', new File([png], 'import.png', { type: 'image/png' }))
  for (const [key, value] of Object.entries({
    name: source.name,
    season: '0',
    originX: Math.round(origin.x),
    originY: Math.round(origin.y),
  }))
    form.set(key, String(value))
  const response = await fetch(`${api}/admin/templates`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  })
  assert.equal(response.status, 201, await response.clone().text())
  const template = await response.json()
  assert.ok(template.chunks.length > 0)
  const published = await fetch(`${api}/admin/templates/${template.templateId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ published: true }),
    signal: AbortSignal.timeout(30_000),
  })
  assert.equal(published.status, 200)
  return { ...template, name: source.name }
}

/** Check every imported object after each lifecycle test, through the public backend proxy. */
export async function verifyWplace({ api, readToken, template }) {
  const headers = { authorization: `Bearer ${readToken}` }
  const response = await fetch(`${api}/manifest`, { headers, signal: AbortSignal.timeout(30_000) })
  assert.equal(response.status, 200)
  const manifest = await response.json()
  const stored = manifest.templates.find((entry) => entry.id === template.templateId)
  assert.ok(stored, `${template.name} must remain published`)
  assert.equal(stored.name, template.name)
  assert.deepEqual(stored.bbox, template.bbox)
  assert.equal(stored.totalPixels, template.totalPixels)
  assert.deepEqual(
    Object.fromEntries(stored.chunks.map(({ tile, hash }) => [tile, hash])),
    Object.fromEntries(template.chunks.map(({ tile, hash }) => [tile, hash])),
  )
  for (const chunk of template.chunks) {
    const object = await fetch(`${api}/chunks/${chunk.hash}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    })
    assert.equal(object.status, 200)
    const bytes = Buffer.from(await object.arrayBuffer())
    assert.equal(createHash('sha256').update(bytes).digest('hex'), chunk.hash)
  }
}
