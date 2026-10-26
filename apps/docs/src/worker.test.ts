import { describe, expect, test } from 'vitest'
import worker from './worker'

// The build output as the assets binding serves it: pages as HTML, copies beside them.
const files: Record<string, [body: string, type: string]> = {
  '/': ['<h1>Caelestis</h1>', 'text/html'],
  '/index.md': ['# Caelestis', 'text/markdown'],
  '/start-here/getting-started/': ['<h1>Getting started</h1>', 'text/html'],
  '/start-here/getting-started.md': ['# Getting started', 'text/markdown'],
  '/feed/': ['<h1>Recent changes</h1>', 'text/html'],
}

const env = {
  ASSETS: {
    async fetch(request: Request) {
      const file = files[new URL(request.url).pathname]
      return file
        ? new Response(file[0], { headers: { 'content-type': file[1] } })
        : new Response('Not found', { status: 404 })
    },
  },
}

const get = (path: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://docs.caelest.is${path}`, { headers }), env)

describe('docs worker', () => {
  test.each([
    [
      'an Accept header that asks for Markdown',
      '/start-here/getting-started/',
      { accept: 'text/markdown' },
      '# Getting started',
    ],
    [
      'an AI agent user agent',
      '/',
      { 'user-agent': 'Mozilla/5.0 (compatible; ClaudeBot/1.0)' },
      '# Caelestis',
    ],
  ])('answers %s with the Markdown copy', async (_, path, headers, body) => {
    const response = await get(path, headers)

    expect(await response.text()).toBe(body)
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(response.headers.get('vary')).toContain('User-Agent')
  })

  test('serves browsers the HTML page', async () => {
    const response = await get('/start-here/getting-started/', {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/150.0',
    })

    expect(await response.text()).toBe('<h1>Getting started</h1>')
    expect(response.headers.get('vary')).toContain('Accept')
  })

  test('falls back to HTML for a page without a Markdown copy', async () => {
    const response = await get('/feed/', { accept: 'text/markdown' })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<h1>Recent changes</h1>')
  })
})
