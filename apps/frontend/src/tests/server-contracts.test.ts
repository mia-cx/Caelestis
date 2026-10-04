import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Manifest, TemplateStatus } from '@caelestis/shared'
import type { ObjectInfo } from '@caelestis/storage'
import { FilesystemObjectStorage } from '@caelestis/storage/filesystem'
import type { RequestEvent } from '@sveltejs/kit'
import { render } from 'svelte/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SocialMetadata from '../lib/components/SocialMetadata.svelte'
import { fetchBackend } from '../lib/server/backend'
import { COMPONENT_EMBED_MAX_BYTES } from '../lib/server/discord-embed'
import { socialMetadata } from '../lib/server/social'
import { socialImageKey } from '../lib/social-image'
import { load } from '../routes/+layout.server'
import { GET as proxy } from '../routes/api/[...path]/+server'
import { GET as imageGet, HEAD as imageHead } from '../routes/social/template/[id].gif/+server'
import { GET as legacyPageGet, HEAD as legacyPageHead } from '../routes/template/[id]/+server'
import { adminToken, createTestBackend } from './backend'
import { manifest, server, template } from './fixtures'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const requestEvent = (url: string, fetcher: typeof fetch, init: RequestInit = {}) =>
  ({
    url: new URL(url),
    request: new Request(url, init),
    fetch: fetcher,
    locals: {
      backendEnvironment: {
        CAELESTIS_SERVER: 'https://backend.test',
        CAELESTIS_READ_TOKEN: adminToken,
      },
    },
    params: {},
    platform: undefined,
    route: { id: null },
    cookies: {
      get: () => undefined,
      getAll: () => [],
      set: () => {
        throw new Error('unexpected cookie mutation')
      },
      delete: () => {
        throw new Error('unexpected cookie mutation')
      },
      serialize: () => {
        throw new Error('unexpected cookie serialization')
      },
    },
    getClientAddress: () => '127.0.0.1',
    setHeaders: () => {
      throw new Error('unexpected response header mutation')
    },
    isDataRequest: false,
    isSubRequest: false,
    isRemoteRequest: false,
    get tracing(): never {
      throw new Error('unexpected tracing access')
    },
  }) satisfies RequestEvent

describe('server-side read boundaries', () => {
  it('uses the server credential, strips cookies, and honors portable environment configuration', async () => {
    const { app } = await createTestBackend()
    const requests: Request[] = []
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      return app.fetch(request)
    }
    const event = requestEvent('https://frontend.test/', fetcher)
    const response = await fetchBackend(event, '/v1/manifest', {
      headers: { cookie: 'session=private', authorization: 'Bearer browser-token' },
    })
    expect(response.status).toBe(200)
    expect(requests[0].headers.get('cookie')).toBeNull()
    expect(requests[0].headers.get('authorization')).toBe(`Bearer ${adminToken}`)
    expect(requests[0].headers.get('accept')).toContain('frontend')
  })

  it('proxy forwards conditional reads but removes headers describing compressed upstream bytes', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get('if-none-match')).toBe('"version"')
      return new Response('decoded', {
        headers: { 'content-encoding': 'gzip', 'content-length': '999', etag: '"version"' },
      })
    })
    const event = requestEvent('https://frontend.test/api/v1/server', fetcher, {
      headers: { 'if-none-match': '"version"', cookie: 'private' },
    })
    const response = await proxy(
      Object.assign(event, {
        params: { path: 'v1/server' },
        route: { id: '/api/[...path]' as const },
      }),
    )
    expect(await response.text()).toBe('decoded')
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('content-length')).toBeNull()
    expect(response.headers.get('etag')).toBe('"version"')
  })

  it('SSR keeps a useful manifest when optional telemetry fails and marks recovery', async () => {
    const { app } = await createTestBackend()
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      if (request.url.includes('/telemetry/status')) return new Response(null, { status: 503 })
      return app.fetch(request)
    }
    const result = await load(
      Object.assign(requestEvent('https://frontend.test/', fetcher), {
        route: { id: '/' as const },
        parent: async () => ({}),
        depends: () => {},
        untrack: <T>(fn: () => T) => fn(),
      }),
    )
    expect(result?.bootstrap.manifest?.season).toBe(3)
    expect(result?.bootstrap.needsRecovery).toBe(true)
    expect(result?.bootstrap.error).toBeNull()
    expect(result?.social.image).toContain('/social/site.png')
  })
})

describe('public social metadata and stored image routes', () => {
  it('only published templates receive template metadata and strips private query parameters', async () => {
    const data = manifest()
    const context = { server: data.server, manifest: data, statuses: [] }
    const url = new URL(`https://frontend.test/artwork/${template().id}?token=private`)
    const metadata = await socialMetadata(url, context)
    expect(metadata.title).toBe('Artwork · Test world')
    expect(metadata.url).not.toContain('?')
    const hidden = await socialMetadata(url, {
      ...context,
      manifest: manifest({ templates: [template({ published: false })] }),
    })
    expect(hidden.title).toBe('Test world · Caelestis')
    expect(
      (await socialMetadata(new URL('https://frontend.test/artwork/%ZZ'), context)).imageType,
    ).toBe('image/png')
  })

  describe('Discord component embed', () => {
    const invite = 'https://discord.gg/caelestis'
    const embedOf = (metadata: { discordEmbed: string | null }) => {
      expect(metadata.discordEmbed).not.toBeNull()
      expect(metadata.discordEmbed).not.toContain('<')
      return JSON.parse(metadata.discordEmbed ?? '') as {
        component: { type: number; components: { type: number; [key: string]: unknown }[] }
      }
    }
    const text = (embed: ReturnType<typeof embedOf>) =>
      embed.component.components.find((component) => component.type === 10)?.content
    const gallery = (embed: ReturnType<typeof embedOf>) =>
      embed.component.components.find((component) => component.type === 12)?.items
    const buttons = (embed: ReturnType<typeof embedOf>) =>
      embed.component.components.find((component) => component.type === 1)?.components

    it('lays out the home page with a canonical action and the configured invite', async () => {
      const data = manifest({ server: { ...server, discordInviteUrl: invite } })
      const metadata = await socialMetadata(
        new URL('https://user:secret@frontend.test/?token=private#fragment'),
        { server: data.server, manifest: data, statuses: [] },
      )
      const embed = embedOf(metadata)
      expect(embed.component.type).toBe(17)
      expect(text(embed)).toBe(`## Test world · Caelestis\n${metadata.description}`)
      expect(gallery(embed)).toEqual([
        { media: { url: metadata.image }, description: metadata.imageAlt },
      ])
      expect(buttons(embed)).toEqual([
        { type: 2, style: 5, url: 'https://frontend.test/', label: 'Open in Caelestis' },
        { type: 2, style: 5, url: invite, label: 'Join Discord' },
      ])
    })

    it('names the folder and leaves out the invite when none is configured', async () => {
      const folder = { id: 'folder-1', parentId: null, path: '/folder-1', name: 'Skyline' }
      const data = manifest({ nodes: [folder as Manifest['nodes'][number]] })
      const embed = embedOf(
        await socialMetadata(new URL('https://frontend.test/folder/folder-1'), {
          server: data.server,
          manifest: data,
          statuses: [],
        }),
      )
      expect(text(embed)).toContain('## Skyline · Test world')
      expect(buttons(embed)).toEqual([
        {
          type: 2,
          style: 5,
          url: 'https://frontend.test/folder/folder-1',
          label: 'Open in Caelestis',
        },
      ])
    })

    it('shows published template progress over its timelapse, falling back to the site image', async () => {
      const data = manifest()
      const url = new URL(`https://frontend.test/artwork/${template().id}`)
      const context = {
        server: data.server,
        manifest: data,
        statuses: [{ templateId: template().id, correct: 2, total: 4 } as TemplateStatus],
      }
      const images = { head: async () => ({ etag: 'gif-1' }) as ObjectInfo }
      const animated = embedOf(await socialMetadata(url, context, images))
      expect(text(animated)).toContain('4 pixels on Wplace. 50% painted correctly.')
      expect(gallery(animated)).toEqual([
        {
          media: { url: `https://frontend.test/social/template/${template().id}.gif?v=gif-1` },
          description: 'Painting timelapse of Artwork on Wplace',
        },
      ])
      const still = embedOf(await socialMetadata(url, context, { head: async () => null }))
      expect(gallery(still)).toEqual([
        {
          media: { url: 'https://frontend.test/social/site.png' },
          description: expect.any(String),
        },
      ])
    })

    it('reveals nothing about an unpublished template', async () => {
      const data = manifest({ templates: [template({ published: false, name: 'Secret plan' })] })
      const metadata = await socialMetadata(
        new URL(`https://frontend.test/artwork/${template().id}`),
        { server: data.server, manifest: data, statuses: [] },
      )
      expect(metadata.discordEmbed).not.toContain('Secret plan')
      expect(text(embedOf(metadata))).toContain('## Test world · Caelestis')
    })

    it('keeps the legacy /template/ path anonymous', async () => {
      const data = manifest()
      const context = { server: data.server, manifest: data, statuses: [] }
      const legacy = await socialMetadata(
        new URL(`https://frontend.test/template/${template().id}`),
        context,
      )
      expect(legacy.title).toBe('Test world · Caelestis')
      expect(legacy.image).toContain('/social/site.png')
      const moved = await socialMetadata(
        new URL(`https://frontend.test/artwork/${template().id}`),
        context,
      )
      expect(moved.title).toBe('Artwork · Test world')
    })

    it.each([
      ['GET', legacyPageGet],
      ['HEAD', legacyPageHead],
    ] as const)('redirects /template/ %s requests to /artwork/', async (_method, handler) => {
      const event = {
        url: new URL('https://frontend.test/template/abc?x=1'),
        params: { id: 'abc' },
      } as Parameters<typeof handler>[0]
      await expect(handler(event)).rejects.toMatchObject({
        status: 308,
        location: '/artwork/abc?x=1',
      })
    })

    it('redirects encode unusual ids', async () => {
      const event = {
        url: new URL('https://frontend.test/template/a%2Fb%20c'),
        params: { id: 'a/b c' },
      } as Parameters<typeof legacyPageGet>[0]
      await expect(legacyPageGet(event)).rejects.toMatchObject({
        status: 308,
        location: '/artwork/a%2Fb%20c',
      })
    })

    it('renders operator content as plain text and drops payloads over the size limit', async () => {
      const data = manifest({
        server: {
          ...server,
          name: '</script><!-- [Free nitro](https://evil.test) @everyone',
          description: `# Heading\n> quote ${'🎨'.repeat(400)}`,
        },
      })
      const context = { server: data.server, manifest: data, statuses: [] }
      const metadata = await socialMetadata(new URL('https://frontend.test/'), context)
      const content = text(embedOf(metadata))
      expect(content).toContain(
        '\\</script\\>\\<!\\-\\- \\[Free nitro\\]\\(https://evil.test\\) \\@everyone',
      )
      expect(content).toContain('\\# Heading \\> quote')
      expect(content).toMatch(/…$/)
      expect(new TextEncoder().encode(metadata.discordEmbed ?? '').length).toBeLessThanOrEqual(
        COMPONENT_EMBED_MAX_BYTES,
      )
      const long = new URL(`https://frontend.test/folder/${'x'.repeat(COMPONENT_EMBED_MAX_BYTES)}`)
      const fallback = await socialMetadata(long, context)
      expect(fallback.discordEmbed).toBeNull()
      expect(fallback.title).toBe(metadata.title)
    })

    it('server-renders the payload as an inline script beside the Open Graph tags', async () => {
      const data = manifest()
      const metadata = await socialMetadata(new URL('https://frontend.test/'), {
        server: data.server,
        manifest: data,
        statuses: [],
      })
      const { head } = render(SocialMetadata, { props: { metadata } })
      expect(head).toContain(
        `<script id="discord:component-embed" type="application/vnd.discord.component-embed+json">${metadata.discordEmbed}</script>`,
      )
      expect(head).toContain('<meta property="og:title" content="Test world · Caelestis"')
      const fallback = render(SocialMetadata, {
        props: { metadata: { ...metadata, discordEmbed: null } },
      })
      expect(fallback.head).not.toContain('discord:component-embed')
      expect(fallback.head).toContain('<meta property="og:image"')
    })
  })

  it('revalidates publication even for conditional requests and serves HEAD without a body', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caelestis-social-'))
    const objects = new FilesystemObjectStorage(directory)
    try {
      const data = manifest()
      const info = await objects.put(socialImageKey(1, template()), new Uint8Array([71, 73, 70]), {
        contentType: 'image/gif',
      })
      let published = true
      const fetcher: typeof fetch = async (input) => {
        expect(String(input)).toBe('https://backend.test/v1/manifest')
        return Response.json(published ? data : manifest({ templates: [] }))
      }
      const event = Object.assign(
        requestEvent(`https://frontend.test/social/template/${template().id}.gif`, fetcher),
        {
          params: { id: template().id },
          route: { id: '/social/template/[id].gif' as const },
          locals: {
            objectStorage: objects,
            backendEnvironment: {
              CAELESTIS_SERVER: 'https://backend.test',
              CAELESTIS_READ_TOKEN: adminToken,
            },
          },
        },
      )
      const get = await imageGet(event)
      expect(new Uint8Array(await get.arrayBuffer())).toEqual(new Uint8Array([71, 73, 70]))
      expect(get.headers.get('cache-control')).toBe('public, no-cache')
      event.request = new Request(event.url, { method: 'HEAD' })
      const head = await imageHead(event)
      expect(await head.text()).toBe('')
      event.request = new Request(event.url, { headers: { 'if-none-match': `W/"${info?.etag}"` } })
      expect((await imageGet(event)).status).toBe(304)
      published = false
      expect((await imageGet(event)).status).toBe(404)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
