import { describe, expect, it } from 'vitest'
import {
  archiveTileHash,
  liveCredentialProtocol,
  parseLiveCredentialProtocol,
  resolveServerUrl,
  tileImagePath,
} from './client-contract.js'

describe('server URLs', () => {
  it.each([
    ['https://templates.example', 'https://templates.example/backend'],
    ['https://templates.example/', 'https://templates.example/backend'],
    ['https://templates.example/backend/', 'https://templates.example/backend'],
    ['https://example.org/caelestis?x=1#y', 'https://example.org/caelestis'],
    ['  http://127.0.0.1:8787 ', 'http://127.0.0.1:8787/backend'],
  ])('%s resolves to %s', (input, expected) => {
    expect(resolveServerUrl(input)).toBe(expected)
  })

  it.each(['ftp://example.org', 'https://user:secret@example.org', 'example.org'])(
    'refuses %s',
    (input) => {
      expect(() => resolveServerUrl(input)).toThrow(TypeError)
    },
  )
})

describe('live credentials', () => {
  it('round-trips a token through its subprotocol, including non-ASCII text', () => {
    for (const token of ['plain-token', 'tökën/with+symbols=']) {
      const protocol = liveCredentialProtocol(token)
      expect(protocol).toMatch(/^[A-Za-z0-9._-]+$/)
      expect(parseLiveCredentialProtocol(protocol)).toBe(token)
    }
  })

  it('refuses protocols that carry no token', () => {
    expect(parseLiveCredentialProtocol('caelestis.live.v2')).toBeNull()
    expect(parseLiveCredentialProtocol('caelestis.auth.b64.')).toBeNull()
    expect(parseLiveCredentialProtocol('caelestis.auth.b64.!!')).toBeNull()
  })
})

it('serves archived and live tile captures from their own routes', () => {
  expect(tileImagePath(archiveTileHash('abc'))).toBe('archive/tiles/abc')
  expect(tileImagePath('abc')).toBe('tiles/abc')
})
