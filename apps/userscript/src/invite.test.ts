import { describe, expect, it } from 'vitest'

import { encodeInvite, readInvite } from './invite.js'

const base64url = (bytes: number[]): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')

describe('readInvite', () => {
  it('round-trips http and https invites through encodeInvite', () => {
    for (const url of ['http://localhost:8787', 'https://caelestis.example/backend']) {
      const fragment = encodeInvite(url, 't0k.en_with-punct')
      expect(readInvite(`#${fragment}`)).toEqual({
        serverUrl: url,
        token: 't0k.en_with-punct',
      })
    }
  })

  it('produces the exact documented example link', () => {
    expect(encodeInvite('https://caelestis.example', 'example-token')).toBe(
      'aHR0cHM6Ly9jYWVsZXN0aXMuZXhhbXBsZQ.ZXhhbXBsZS10b2tlbg',
    )
  })

  it.each(['', '#', '#foo', '#foo.bar', '#W5hbWU', '#amF2YXNjcmlwdDphbGVydCgxKQ.x'])(
    'ignores the unrelated fragment %s',
    (hash) => {
      expect(readInvite(hash)).toBeNull()
    },
  )

  it.each([
    ['bad UTF-8 in the server part', `#aHR0c-A.${base64url([116, 111, 107, 101, 110])}`],
    [
      'a credentialed server URL',
      `#${base64url([...new TextEncoder().encode('https://u:p@host.example')])}.dG9rZW4`,
    ],
    ['an empty token', `#${encodeInvite('https://caelestis.example', 'token').split('.')[0]}.`],
    [
      'a whitespace token',
      `#${encodeInvite('https://caelestis.example', 'token').split('.')[0]}.${base64url([...new TextEncoder().encode('bad token')])}`,
    ],
    ['an extra separator', `#${encodeInvite('https://caelestis.example', 'token')}.ZXh0cmE`],
  ])('reports a malformed invite for %s', (_name, hash) => {
    expect(readInvite(hash)).toBe('malformed')
  })
})
