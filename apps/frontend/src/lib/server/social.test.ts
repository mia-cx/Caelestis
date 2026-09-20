import type { Manifest, Template } from '@caelestis/shared'
import { millis } from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'
import { socialMetadata } from './social.js'

const template: Template = {
  id: 'art',
  version: 'v1',
  name: 'A & B',
  nodeId: null,
  published: true,
  bbox: { minX: 0, minY: 0, maxX: 16, maxY: 9 },
  totalPixels: 1000,
  chunks: [],
  finished: false,
  finishedAt: null,
  timelapseFrozen: false,
  createdAt: millis(0),
  updatedAt: millis(0),
}
const server = { id: 'site', name: 'Caelestis', auth: 'none' as const }
const manifest: Manifest = {
  season: 3,
  version: 'm1',
  server,
  tiles: [],
  templates: [template],
  nodes: [
    {
      id: 'folder',
      name: 'Gallery',
      description: 'Our shared pixel art.',
      path: '/gallery',
      parentId: null,
      createdAt: millis(0),
    },
  ],
}
const context = { server, manifest, statuses: [] }

describe('share metadata', () => {
  it('uses absolute URLs and excludes query credentials and fragments from the canonical URL', async () => {
    const result = await socialMetadata(
      new URL('https://example.com/?token=secret#private'),
      context,
    )
    expect(result.url).toBe('https://example.com/')
    expect(result.image).toBe('https://example.com/social/site.png')
    expect(result.title).toBe('Caelestis')
    expect(result.description).toContain('Wplace')
  })

  it('uses the operator description and preview on non-template routes only', async () => {
    const branded = {
      ...server,
      name: 'Allies',
      description: 'The Allied Communities paint together.',
      previewImage: { etag: 'e'.repeat(64), contentType: 'image/webp' as const },
    }
    const home = await socialMetadata(new URL('https://example.com/'), {
      ...context,
      server: branded,
    })
    expect(home.title).toBe('Allies · Caelestis')
    expect(home.description).toBe('The Allied Communities paint together.')
    expect(home.image).toBe(`https://example.com/api/v1/server/assets/preview?v=${'e'.repeat(64)}`)
    expect(home.imageType).toBe('image/webp')
    expect(home.imageWidth).toBeNull()
    expect(home.imageAlt).toBe('Allies')

    const folder = await socialMetadata(new URL('https://example.com/folder/folder'), {
      ...context,
      server: branded,
    })
    expect(folder.description).toBe('Our shared pixel art.')
    expect(folder.image).toBe(home.image)

    const images = { head: vi.fn().mockResolvedValue({ etag: 'gif' }), get: vi.fn() }
    const templatePage = await socialMetadata(
      new URL('https://example.com/template/art'),
      { ...context, server: branded },
      images,
    )
    expect(templatePage.image).toBe('https://example.com/social/template/art.gif?v=gif')
    expect(templatePage.imageWidth).toBe(640)
    expect(templatePage.description).toContain('pixels on Wplace')
  })

  it('gives folder links their own title and description', async () => {
    const result = await socialMetadata(new URL('https://example.com/folder/folder'), context)
    expect(result.title).toBe('Gallery · Caelestis')
    expect(result.description).toBe('Our shared pixel art.')
  })

  it('uses a generated template GIF with its actual storage revision', async () => {
    const head = vi.fn().mockResolvedValue({ etag: 'gif-revision' })
    const images = { head, get: vi.fn() }
    const result = await socialMetadata(
      new URL('https://example.com/template/art?utm_source=discord'),
      {
        ...context,
        statuses: [
          {
            templateId: 'art',
            correct: 500,
            wrong: 250,
            blank: 250,
            total: 1000,
            observedAt: millis(1),
          },
        ],
      },
      images,
    )
    expect(head).toHaveBeenCalledWith('social/v2/3/art.gif')
    expect(result.image).toBe('https://example.com/social/template/art.gif?v=gif-revision')
    expect(result.imageType).toBe('image/gif')
    expect(result.imageWidth).toBe(640)
    expect(result.description).toContain('50% painted correctly.')
    expect(result.title).toBe('A & B · Caelestis')
  })

  it('falls back before generation and never exposes unpublished template metadata', async () => {
    const images = { head: vi.fn().mockResolvedValue(null), get: vi.fn() }
    const result = await socialMetadata(
      new URL('https://example.com/template/art'),
      context,
      images,
    )
    expect(result.imageType).toBe('image/png')
    expect(result.description).not.toContain('%')
    images.head.mockClear()
    const privateResult = await socialMetadata(
      new URL('https://example.com/template/art'),
      {
        ...context,
        manifest: { ...manifest, templates: [{ ...template, published: false }] },
      },
      images,
    )
    expect(privateResult.title).toBe('Caelestis')
    expect(images.head).not.toHaveBeenCalled()
  })
})
