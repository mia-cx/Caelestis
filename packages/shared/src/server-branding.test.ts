import { describe, expect, it } from 'vitest'
import {
  logoText,
  MAX_HOME_COPY_LENGTH,
  MAX_HOME_COPY_LINKS,
  parseDiscordInviteUrl,
  parseHomeCopy,
  parseServerAsset,
  serverAssetPath,
  sniffServerAssetContentType,
} from './server-branding.js'

describe('parseDiscordInviteUrl', () => {
  it.each([
    ['https://discord.gg/abc123', 'https://discord.gg/abc123'],
    ['  https://discord.com/invite/abc-123/  ', 'https://discord.gg/abc-123'],
    ['https://www.discordapp.com/invite/xyz', 'https://discord.gg/xyz'],
  ])('%s canonicalises to %s', (input, expected) => {
    expect(parseDiscordInviteUrl(input)).toBe(expected)
  })

  it.each([
    'http://discord.gg/abc',
    'https://discord.gg/',
    'https://discord.gg/abc?ref=x',
    'https://example.com/invite/abc',
    'javascript:alert(1)',
    'https://discord.gg/a',
    42,
  ])('rejects %s', (input) => {
    expect(parseDiscordInviteUrl(input)).toBeNull()
  })
})

describe('logoText', () => {
  it('trims and bounds', () => {
    expect(logoText('  Allies ')).toBe('Allies')
    expect(logoText('')).toBeNull()
    expect(logoText('x'.repeat(65))).toBeNull()
    expect(logoText(`a${String.fromCharCode(0)}b`)).toBeNull()
  })
})

describe('parseHomeCopy', () => {
  it('parses headings, paragraphs, lists and inline marks', () => {
    const result = parseHomeCopy(
      '## Welcome\n\nWe paint **together** on *Wplace*.\nJoin [our server](https://discord.gg/abc).\n\n- one\n- two\n',
    )
    expect(result).toEqual({
      ok: true,
      blocks: [
        { type: 'heading', inlines: [{ type: 'text', text: 'Welcome' }] },
        {
          type: 'paragraph',
          inlines: [
            { type: 'text', text: 'We paint ' },
            { type: 'strong', text: 'together' },
            { type: 'text', text: ' on ' },
            { type: 'em', text: 'Wplace' },
            { type: 'text', text: '. Join ' },
            { type: 'link', text: 'our server', href: 'https://discord.gg/abc' },
            { type: 'text', text: '.' },
          ],
        },
        {
          type: 'list',
          items: [[{ type: 'text', text: 'one' }], [{ type: 'text', text: 'two' }]],
        },
      ],
    })
  })

  it('keeps markup it does not understand as text', () => {
    const result = parseHomeCopy('<script>alert(1)</script> and `code`')
    expect(result).toEqual({
      ok: true,
      blocks: [
        {
          type: 'paragraph',
          inlines: [{ type: 'text', text: '<script>alert(1)</script> and `code`' }],
        },
      ],
    })
  })

  it('accepts an empty body', () => {
    expect(parseHomeCopy('')).toEqual({ ok: true, blocks: [] })
  })

  it.each([
    ['a non-http link', '[x](javascript:alert(1))', /http/],
    ['control characters', `hello${String.fromCharCode(7)}`, /control/],
    ['oversized copy', 'x'.repeat(MAX_HOME_COPY_LENGTH + 1), /at most/],
    ['too many links', '[a](https://a.b) '.repeat(MAX_HOME_COPY_LINKS + 1), /links/],
    ['a non-string', 12, /text/],
  ])('rejects %s', (_label, input, message) => {
    const result = parseHomeCopy(input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(message)
  })
})

describe('server assets', () => {
  it('sniffs supported containers', () => {
    expect(
      sniffServerAssetContentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe('image/png')
    expect(sniffServerAssetContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffServerAssetContentType(new TextEncoder().encode('GIF89a......'))).toBe('image/gif')
    expect(sniffServerAssetContentType(new TextEncoder().encode('RIFF....WEBPVP8 '))).toBe(
      'image/webp',
    )
    expect(sniffServerAssetContentType(new TextEncoder().encode('<svg xmlns="x"/>'))).toBeNull()
  })

  it('parses and addresses assets', () => {
    const asset = parseServerAsset({ etag: 'a'.repeat(64), contentType: 'image/PNG' })
    expect(asset).toEqual({ etag: 'a'.repeat(64), contentType: 'image/png' })
    expect(parseServerAsset({ etag: 'nope', contentType: 'image/png' })).toBeNull()
    expect(parseServerAsset({ etag: 'a'.repeat(64), contentType: 'image/svg+xml' })).toBeNull()
    expect(serverAssetPath('logo', asset ?? { etag: '', contentType: 'image/png' })).toBe(
      `/server/assets/logo?v=${'a'.repeat(64)}`,
    )
  })
})
