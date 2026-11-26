import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Manifest, TemplateStatus } from '@caelestis/shared'
import { socialImageKey } from '@caelestis/social'
import type { ObjectInfo } from '@caelestis/storage'
import { FilesystemObjectStorage } from '@caelestis/storage/filesystem'
import type { RequestEvent } from '@sveltejs/kit'
import { render } from 'svelte/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPlatformProxy } from 'wrangler'
import { handle } from '../hooks.server'
import SocialMetadata from '../lib/components/SocialMetadata.svelte'
import { fetchBackend } from '../lib/server/backend'
import { COMPONENT_EMBED_MAX_BYTES } from '../lib/server/discord-embed'
import { socialMetadata } from '../lib/server/social'
import { load } from '../routes/+layout.server'
import { GET as proxy } from '../routes/api/[...path]/+server'
import { GET as imageGet, HEAD as imageHead } from '../routes/social/template/[id].gif/+server'
import { GET as legacyPageGet, HEAD as legacyPageHead } from '../routes/template/[id]/+server'
import { adminToken, createTestBackend } from './backend'
import { manifest, server, template } from './fixtures'

const workers = vi.hoisted(() => ({ env: {} as App.HostEnv }))
vi.mock('cloudflare:workers', () => workers)

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
      parse: () => {
        throw new Error('unexpected cookie parsing')
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

  it('reads the backend and image bucket from Worker bindings on Cloudflare', async () => {
    // Local bindings from the real wrangler.toml, so a renamed binding fails here too.
    const platform = await getPlatformProxy<App.HostEnv>({ persist: false })
    try {
      const gif = new Uint8Array([71, 73, 70])
      await platform.env.SOCIAL_IMAGES?.put(socialImageKey(1, template()), gif)
      const backendRequests: Request[] = []
      workers.env = {
        SOCIAL_IMAGES: platform.env.SOCIAL_IMAGES,
        CAELESTIS_READ_TOKEN: adminToken,
        CAELESTIS_BACKEND: {
          fetch: async (request) => {
            backendRequests.push(request)
            return Response.json(manifest())
          },
        },
      }
      const url = `https://frontend.test/social/template/${template().id}.gif`
      // Cloudflare's adapter passes no platform, so the hook alone fills locals.
      const event = Object.assign(requestEvent(url, fetch), {
        params: { id: template().id },
        route: { id: '/social/template/[id].gif' as const },
        locals: {} as App.Locals,
      })
      const response = await handle({ event, resolve: async () => imageGet(event) })
      expect(response.status).toBe(200)
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(gif)
      expect(backendRequests.map((request) => request.headers.get('authorization'))).toEqual([
        `Bearer ${adminToken}`,
      ])
    } finally {
      await platform.dispose()
    }
  })

  it('redirects the www host to the apex before forwarding /docs', async () => {
    const event = requestEvent('https://www.caelest.is/docs/x?y=1', vi.fn<typeof fetch>())
    const resolve = vi.fn()
    const response = await handle({ event, resolve })

    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe('https://caelest.is/docs/x?y=1')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('forwards /docs paths to the docs site without reaching any route', async () => {
    const resolve = vi.fn()
    const forwarded = async (url: string) => {
      const event = requestEvent(url, vi.fn<typeof fetch>())
      const response = await handle({ event, resolve })
      return [response.status, response.headers.get('location')]
    }

    expect(await forwarded('https://caelest.is/docs')).toEqual([308, 'https://docs.caelest.is/'])
    expect(await forwarded('https://caelest.is/docs/start-here/?q=token')).toEqual([
      308,
      'https://docs.caelest.is/start-here/?q=token',
    ])
    expect(resolve).not.toHaveBeenCalled()
  })

  describe('former dashboard host', () => {
    /** localStorage stand-in: own enumerable keys are the entries, like the real Storage. */
    class MemoryStorage {
      [key: string]: unknown
      constructor(entries: Record<string, string>) {
        Object.assign(this, entries)
      }
      getItem(key: string) {
        return Object.hasOwn(this, key) ? (this[key] as string) : null
      }
      setItem(key: string, value: string) {
        this[key] = value
      }
    }

    /** Run a handoff page's inline script; report where it navigated or what form it posted. */
    const runPage = async (response: Response, storage: MemoryStorage) => {
      const html = await response.text()
      const script = html.slice(
        html.indexOf('<script>') + '<script>'.length,
        html.lastIndexOf('</script>'),
      )
      const result: { replaced?: string; posted?: { action: string; fields: FormData } } = {}
      const document = {
        body: { append: () => {} },
        createElement: () => {
          const element = {
            action: '',
            inputs: [] as { name: string; value: string }[],
            append: (input: { name: string; value: string }) => element.inputs.push(input),
            submit: () => {
              const fields = new FormData()
              for (const { name, value } of element.inputs) fields.set(name, value)
              result.posted = { action: element.action, fields }
            },
          }
          return element
        },
      }
      const location = { replace: (url: string) => (result.replaced = url) }
      new Function('localStorage', 'location', 'document', script)(storage, location, document)
      return result
    }

    const visit = (url: string, init: RequestInit = {}) =>
      handle({ event: requestEvent(url, vi.fn<typeof fetch>(), init), resolve: vi.fn() })
    const pageVisit = (url: string) => visit(url, { headers: { 'sec-fetch-dest': 'document' } })
    const move = (fields: FormData, origin = 'https://caelestis.mia.cx') =>
      visit('https://caelest.is/moved', { method: 'POST', body: fields, headers: { origin } })

    it('redirects crawlers and non-page requests with a 308', async () => {
      const response = await visit('https://caelestis.mia.cx/folder/abc?view=grid')

      expect([response.status, response.headers.get('location')]).toEqual([
        308,
        'https://caelest.is/folder/abc?view=grid',
      ])
    })

    it('sends a visitor without saved state straight to the same page on caelest.is', async () => {
      const response = await pageVisit('https://caelestis.mia.cx/folder/abc?view=grid')

      expect(await runPage(response, new MemoryStorage({ unrelated: 'x' }))).toEqual({
        replaced: 'https://caelest.is/folder/abc?view=grid',
      })
    })

    it('carries the saved connection and preferences to caelest.is', async () => {
      const old = new MemoryStorage({
        'caelestis:server': 'https://raid.example/backend',
        'caelestis:token': 'secret',
        'caelestis:theme': 'caelestis-dark',
        unrelated: 'x',
      })
      const { posted } = await runPage(await pageVisit('https://caelestis.mia.cx/folder/abc'), old)
      expect(posted?.action).toBe('https://caelest.is/moved')

      const current = new MemoryStorage({ 'caelestis:theme': 'caelestis' })
      const arrival = await runPage(await move(posted?.fields ?? new FormData()), current)

      expect(arrival.replaced).toBe('/folder/abc')
      expect({ ...current }).toEqual({
        'caelestis:server': 'https://raid.example/backend',
        'caelestis:token': 'secret',
        'caelestis:theme': 'caelestis',
      })
    })

    it('never pairs a carried token with a server caelest.is already holds', async () => {
      const fields = new FormData()
      fields.set('storage', JSON.stringify({ 'caelestis:token': 'secret' }))
      fields.set('to', '//evil.example/')
      const current = new MemoryStorage({ 'caelestis:server': 'https://other.example' })

      const arrival = await runPage(await move(fields), current)

      expect(arrival.replaced).toBe('/')
      expect({ ...current }).toEqual({ 'caelestis:server': 'https://other.example' })
    })

    it('refuses state posted from any other origin', async () => {
      const fields = new FormData()
      fields.set('storage', JSON.stringify({ 'caelestis:server': 'https://evil.example' }))

      expect((await move(fields, 'https://evil.example')).status).toBe(403)
    })
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
      const animated = embedOf(
        await socialMetadata(url, context, async () => ({ etag: 'gif-1' }) as ObjectInfo),
      )
      expect(text(animated)).toContain('4 pixels on Wplace. 50% painted correctly.')
      expect(gallery(animated)).toEqual([
        {
          media: { url: `https://frontend.test/social/template/${template().id}.gif?v=gif-1` },
          description: 'Painting timelapse of Artwork on Wplace',
        },
      ])
      const still = embedOf(await socialMetadata(url, context, async () => null))
      expect(gallery(still)).toEqual([
        {
          media: { url: 'https://frontend.test/social/site.png' },
          description: expect.any(String),
        },
      ])
    })

    it("leaves out a replaced artwork's previous progress", async () => {
      const data = manifest()
      const metadata = await socialMetadata(
        new URL(`https://frontend.test/artwork/${template().id}`),
        {
          server: data.server,
          manifest: data,
          statuses: [{ templateId: template().id, correct: 2, total: 2 } as TemplateStatus],
        },
      )
      expect(metadata.description).toBe(
        '4 pixels on Wplace. Watch the timelapse and follow its progress.',
      )
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
      const reads = vi.spyOn(objects, 'get')
      const get = await imageGet(event)
      expect(new Uint8Array(await get.arrayBuffer())).toEqual(new Uint8Array([71, 73, 70]))
      expect(get.headers.get('cache-control')).toBe('public, no-cache')
      event.request = new Request(event.url, { method: 'HEAD' })
      const head = await imageHead(event)
      expect(await head.text()).toBe('')
      expect(head.headers.get('content-length')).toBe('3')
      event.request = new Request(event.url, { headers: { 'if-none-match': `W/"${info?.etag}"` } })
      expect((await imageGet(event)).status).toBe(304)
      // HEAD and revalidation answer from metadata; only the full GET reads the image.
      expect(reads).toHaveBeenCalledTimes(1)
      published = false
      expect((await imageGet(event)).status).toBe(404)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
