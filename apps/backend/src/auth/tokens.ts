import { sha256Hex } from '@caelestis/shared'

/**
 * Access-token minting and hashing.
 *
 * Tokens are server-generated 128-bit values, never user-chosen, which is why SHA-256 at rest is
 * sufficient and no slow KDF is needed: there is no low-entropy secret to grind. A user-chosen
 * password would need argon2 or scrypt; 128 bits of CSPRNG output does not.
 */

/** RFC 4648 base32 without padding, minus the characters that invite transcription errors. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789'
const TOKEN_BYTES = 16
const BITS_PER_CHARACTER = 5

/**
 * A fresh token. 128 bits from the platform CSPRNG.
 *
 * Encoded by consuming a bit at a time rather than by chunking bytes, so no bits are discarded and
 * the value really does carry the full 128 bits its length advertises.
 */
export const mintToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))
  let bits = 0
  let value = 0
  let token = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= BITS_PER_CHARACTER) {
      bits -= BITS_PER_CHARACTER
      token += ALPHABET[(value >> bits) & 31]
    }
  }
  if (bits > 0) token += ALPHABET[(value << (BITS_PER_CHARACTER - bits)) & 31]
  return token
}

/** Lowercase hex SHA-256, the form stored in `access_tokens.token_hash`. */
export const hashToken = (token: string): Promise<string> =>
  sha256Hex(new TextEncoder().encode(token))
